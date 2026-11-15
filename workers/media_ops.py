"""FFmpeg/ffprobe and local faster-whisper operations with source-clock receipts."""
from __future__ import annotations

from fractions import Fraction
import io
import json
import math
from pathlib import Path
import re
import shutil

from common import Context, WorkerError, TICKS_PER_SECOND, digest_file, integer, number, pin_model, seconds_to_ticks, ticks_to_seconds


def ffmpeg(context: Context, args: list[str]) -> tuple[str, str]:
    return context.run("ffmpeg", ["-hide_banner", "-nostdin", "-n", "-threads", str(context.threads), "-filter_threads", str(context.threads), "-filter_complex_threads", str(context.threads), "-protocol_whitelist", "file,pipe", *args[:-1], "-threads", str(context.threads), args[-1]])


def probe(context: Context, path: Path) -> dict:
    stdout, _ = context.run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", str(path)])
    return json.loads(stdout)


def rate(value: str | None) -> dict | None:
    try:
        rational = Fraction(value or "0/1")
        return {"num": rational.numerator, "den": rational.denominator} if rational > 0 else None
    except (ValueError, ZeroDivisionError):
        return None


def inspection(context: Context, path: Path) -> dict:
    raw = probe(context, path)
    streams = raw.get("streams", [])
    video = next((stream for stream in streams if stream.get("codec_type") == "video" and not stream.get("disposition", {}).get("attached_pic")), None)
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    duration = raw.get("format", {}).get("duration")
    if duration is None:
        values = [Fraction(str(stream["duration"])) for stream in streams if stream.get("duration") not in (None, "N/A")]
        duration = str(float(max(values))) if values else "0"
    result = {
        "durationTicks": seconds_to_ticks(duration), "frameRate": rate(video.get("avg_frame_rate")) if video else None,
        "width": video.get("width") if video else None, "height": video.get("height") if video else None,
        "hasVideo": video is not None, "hasAudio": audio is not None,
        "audio": {"sampleRate": int(audio.get("sample_rate", 0)), "channels": audio.get("channels"), "layout": audio.get("channel_layout", "unknown")} if audio else None,
        "isVfr": None, "vfrEvidence": "not_scanned", "streams": streams, "format": raw.get("format", {}),
    }
    # avg_frame_rate != r_frame_rate alone is not proof of variable frame spacing.
    return result


def inspect(context: Context) -> dict:
    data = inspection(context, context.input())
    if context.options.get("scanFrameTiming") and data["hasVideo"]:
        stdout, _ = context.run("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp", "-of", "json", str(context.input())], stdout_limit=32 * 1024 * 1024)
        timestamps = [int(frame["best_effort_timestamp"]) for frame in json.loads(stdout).get("frames", []) if "best_effort_timestamp" in frame]
        deltas = {right - left for left, right in zip(timestamps, timestamps[1:])}
        data["isVfr"] = len(deltas) > 1 if deltas else None
        data["vfrEvidence"] = "complete_frame_pts" if deltas else "insufficient_frames"
        data["frameCount"] = len(timestamps)
    context.json_artifact("media-manifest.json", data, "media_manifest")
    return data


def audio_origin(media: dict) -> tuple[Fraction, dict]:
    audio = next((stream for stream in media["streams"] if stream.get("codec_type") == "audio"), None)
    if audio is None:
        raise WorkerError("NO_AUDIO", "Source has no audio stream", True)
    stream_start = Fraction(int(audio["start_pts"])) * Fraction(audio["time_base"]) if "start_pts" in audio and audio.get("time_base") else Fraction(audio["start_time"]) if audio.get("start_time") is not None else None
    container_start = Fraction(media["format"]["start_time"]) if media["format"].get("start_time") is not None else None
    if stream_start is None or container_start is None:
        if media["hasVideo"]:
            raise WorkerError("AUDIO_ORIGIN_UNOBSERVED", "A video container requires an observed first-audio and container origin", True)
        # A sample-only file has no independent video clock; its source origin
        # is the first decoded sample, rather than an invented video timestamp.
        return Fraction(0), {"offsetTicks": "0", "evidence": "audio_only_sample_zero", "streamIndex": audio.get("index")}
    offset = stream_start - container_start
    return offset, {"offsetTicks": seconds_to_ticks(offset), "evidence": "observed_stream_and_container_start", "streamIndex": audio.get("index"), "streamStartTicks": seconds_to_ticks(stream_start), "containerStartTicks": seconds_to_ticks(container_start)}


def frames(context: Context) -> dict:
    times = context.options.get("times")
    if not isinstance(times, list) or not 1 <= len(times) <= 64:
        raise WorkerError("INVALID_ARGUMENT", "times must contain 1..64 source timestamps", True)
    width = integer(context.options.get("maxEdge", context.options.get("maxWidth", 1280)), "maxEdge", 16, 8192)
    manifest = inspection(context, context.input())
    if not manifest["hasVideo"]:
        raise WorkerError("NO_VIDEO", "Source has no video stream", True)
    start = Fraction(str(manifest["format"].get("start_time", "0")))
    results = []
    for index, time in enumerate(times):
        requested = time.get("ticks")
        seconds = Fraction(int(requested), TICKS_PER_SECOND) if isinstance(requested, str) and requested.isdigit() else None
        if seconds is None or (int(manifest["durationTicks"]) > 0 and int(requested) >= int(manifest["durationTicks"])):
            raise WorkerError("INVALID_TIME", "Frame timestamp is outside the source", True)
        target = context.path(f"frame-{index:04d}.png")
        # showinfo reports the actual decoded PTS. -copyts retains source timestamps.
        _, stderr = ffmpeg(context, ["-ss", ticks_to_seconds(requested), "-copyts", "-i", str(context.input()), "-map", "0:v:0", "-an", "-vf", f"scale=w='min({width},iw)':h='min({width},ih)':force_original_aspect_ratio=decrease,format=rgb24,showinfo", "-frames:v", "1", "-fps_mode", "passthrough", "-pix_fmt", "rgb24", str(target)])
        match = re.search(r"\bn:\s*0\s+pts:\s*(-?\d+)\s+pts_time:([-.\d]+)", stderr)
        time_base = re.search(r"config in time_base:\s*(\d+)/(\d+)", stderr)
        if not target.is_file() or not match or not time_base:
            raise WorkerError("FRAME_NOT_OBSERVED", "Decoder did not return a frame with an observed timestamp")
        resolved = int(match.group(1)) * Fraction(int(time_base.group(1)), int(time_base.group(2))) - start
        actual = seconds_to_ticks(resolved)
        with target.open("rb") as png_file:
            header = png_file.read(33)
        if header[:8] != b"\x89PNG\r\n\x1a\n" or len(header) < 26 or header[24] != 8 or header[25] != 2:
            raise WorkerError("FRAME_FORMAT_MISMATCH", "Frame encoder did not produce an opaque RGB8 PNG raster")
        metadata = {"clock": "source", "requestedTicks": requested, "resolvedTicks": actual, "sourceAssetSha256": context.input_hashes["source"], "isProxy": False, "width": int.from_bytes(header[16:20], "big"), "height": int.from_bytes(header[20:24], "big"), "sourceWidth": manifest["width"], "sourceHeight": manifest["height"], "color": {"bitDepth": 8, "range": "full", "alpha": "none"}}
        if context.options.get("statistics") is True:
            try:
                from PIL import Image, ImageStat
            except ImportError:
                raise WorkerError("WORKER_REQUIRES_SETUP", "Pillow is required for observed frame statistics", True) from None
            with Image.open(target) as opened:
                rgb = opened.convert("RGB")
                measurement = ImageStat.Stat(rgb)
                histogram = rgb.histogram()
                samples = rgb.width * rgb.height
                metadata["statistics"] = {"space": "encoded_rgb_8bit", "mean": measurement.mean, "stddev": measurement.stddev, "sampleCount": samples, "shadowFraction": [sum(histogram[channel * 256:channel * 256 + 5]) / samples for channel in range(3)], "highlightFraction": [sum(histogram[channel * 256 + 251:(channel + 1) * 256]) / samples for channel in range(3)]}
        artifact = context.artifact(target, "source_frame", "image/png", metadata)
        results.append({"artifactIndex": artifact, **metadata})
    return {"frames": results, "clock": "source", "complete": True}


def conform(context: Context) -> dict:
    output_format = context.options.get("outputFormat")
    if output_format in ("png", "jpg", "jpeg"):
        return render_still(context, "jpg" if output_format == "jpeg" else output_format)
    fps = context.options.get("fps")
    if not isinstance(fps, dict):
        raise WorkerError("INVALID_ARGUMENT", "A rational fps is required", True)
    numerator = integer(fps.get("num"), "fps.num", 1, 240000)
    denominator = integer(fps.get("den"), "fps.den", 1, 100100)
    if not 1 <= numerator / denominator <= 240:
        raise WorkerError("INVALID_ARGUMENT", "Frame rate must be 1..240 fps", True)
    codec = context.options.get("videoCodec", "h264" if output_format == "mp4" else "prores")
    if codec not in ("prores", "h264"):
        raise WorkerError("INVALID_ARGUMENT", "videoCodec must be prores or h264", True)
    if output_format not in (None, "mp4", "mov") or (output_format == "mp4" and codec != "h264"):
        raise WorkerError("INVALID_ARGUMENT", "Output container/codec combination is unsupported", True)
    source = inspection(context, context.input())
    if not source["hasVideo"]:
        raise WorkerError("NO_VIDEO", "Conform requires a video source", True)
    extension = output_format or ("mov" if codec == "prores" else "mp4")
    output = context.path(f"conformed.{extension}")
    filters = [f"fps={numerator}/{denominator}:round=near"]
    if "width" in context.options or "height" in context.options:
        width = integer(context.options.get("width", source["width"]), "width", 16, 16384)
        height = integer(context.options.get("height", source["height"]), "height", 16, 16384)
        if width % 2 or height % 2:
            raise WorkerError("INVALID_ARGUMENT", "Conform dimensions must be even", True)
        filters.append(f"scale={width}:{height}:flags=lanczos")
    if context.options.get("pixelAspect"):
        aspect = context.options["pixelAspect"]
        aspect_num = integer(aspect.get("num"), "pixelAspect.num", 1, 1000000)
        aspect_den = integer(aspect.get("den"), "pixelAspect.den", 1, 1000000)
        filters.append(f"setsar={aspect_num}/{aspect_den}")
    if context.options.get("burnSubtitles") is True:
        captions = context.input("subtitles")
        if captions.stat().st_size > 16 * 1024 * 1024:
            raise WorkerError("SUBTITLE_LIMIT", "Subtitle input exceeds 16 MiB", True)
        text = captions.read_text(encoding="utf-8-sig")
        if not re.search(r"\d{2,}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2,}:\d{2}:\d{2},\d{3}", text):
            raise WorkerError("INVALID_SUBTITLES", "Burn-in requires a UTF-8 SRT cue file", True)
        staged = context.path("burn-captions.srt", temporary=True)
        shutil.copyfile(captions, staged)
        # A constant filename under cwd avoids platform-specific filter-path escaping.
        filters.append("subtitles=filename=burn-captions.srt")
    encoding = ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"] if codec == "prores" else ["-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p"]
    sample_rate = integer(context.options.get("audioSampleRate", 48000), "audioSampleRate", 8000, 192000)
    audio = ["-c:a", "pcm_s24le"] if codec == "prores" else ["-c:a", "aac", "-b:a", "192k"]
    ffmpeg(context, ["-i", str(context.input()), "-map", "0:v:0", "-map", "0:a?", "-map_metadata", "0", "-vf", ",".join(filters), *encoding, *audio, "-ar", str(sample_rate), str(output)])
    derived = inspection(context, output)
    # Presentation-time mapping is preserved; frame selection is nearest at the explicit CFR grid.
    tolerance = Fraction(denominator, numerator) * TICKS_PER_SECOND
    if abs(int(derived["durationTicks"]) - int(source["durationTicks"])) > math.ceil(tolerance * 2):
        raise WorkerError("CONFORM_DURATION_MISMATCH", "Conformed output duration differs by more than two output frames")
    mapping = {"kind": "linear", "sourceStartTicks": "0", "derivedStartTicks": "0", "scale": {"num": 1, "den": 1}, "frameSelection": "nearest_cfr", "sourceSha256": context.input_hashes["source"], "sourceDurationTicks": source["durationTicks"], "derivedDurationTicks": derived["durationTicks"]}
    index = context.artifact(output, "conformed_media", "video/quicktime" if extension == "mov" else "video/mp4", {"mapping": mapping, "media": derived})
    context.json_artifact("conform-map.json", mapping, "conform_map")
    return {"artifactIndex": index, "mapping": mapping, "media": derived, "subtitlesBurned": context.options.get("burnSubtitles") is True}


def render_still(context: Context, output_format: str) -> dict:
    try:
        from PIL import Image, ImageOps
    except ImportError:
        raise WorkerError("WORKER_REQUIRES_SETUP", "Install the pinned Pillow environment for still-image delivery", True) from None
    with Image.open(context.input()) as opened:
        if opened.format == "PNG":
            with context.input().open("rb") as source_file:
                header = source_file.read(33)
            if len(header) >= 25 and header[24] != 8:
                raise WorkerError("STILL_PRECISION_UNSUPPORTED", "An explicit 8-bit proxy is required before this delivery encoder", True)
        if opened.format == "TIFF":
            bits = opened.tag_v2.get(258, (8,))
            if isinstance(bits, int):
                bits = (bits,)
            if any(int(depth) != 8 for depth in bits):
                raise WorkerError("STILL_PRECISION_UNSUPPORTED", "An explicit 8-bit proxy is required before this delivery encoder", True)
        if getattr(opened, "n_frames", 1) != 1 or opened.mode not in ("RGB", "RGBA", "L", "LA"):
            raise WorkerError("STILL_FORMAT_UNSUPPORTED", "Still delivery requires a single RGB8/grayscale8 raster snapshot", True)
        if opened.getexif().get(274, 1) != 1:
            raise WorkerError("IMAGE_ORIENTATION_NOT_APPLIED", "Still snapshot orientation must already be applied", True)
        maximum = integer(context.profile.get("limits", {}).get("maxImagePixels", 16777216), "maxImagePixels", 1, 268435456)
        if opened.width * opened.height > maximum:
            raise WorkerError("IMAGE_PIXEL_LIMIT", "Still raster exceeds configured pixel limit", True)
        icc = opened.info.get("icc_profile")
        image = opened.convert("RGBA")
    width = integer(context.options.get("width", image.width), "width", 1, 16384)
    height = integer(context.options.get("height", image.height), "height", 1, 16384)
    if width * height > maximum:
        raise WorkerError("IMAGE_PIXEL_LIMIT", "Still output exceeds configured pixel limit", True)
    fit = context.options.get("fit", "contain")
    if fit not in ("contain", "cover", "stretch"):
        raise WorkerError("INVALID_ARGUMENT", "Image fit must be contain, cover or stretch", True)
    background = context.options.get("backgroundColor", "#000000")
    if not isinstance(background, str) or not re.fullmatch(r"#[0-9A-Fa-f]{6}", background):
        raise WorkerError("INVALID_ARGUMENT", "backgroundColor must be #RRGGBB", True)
    context.check()
    if fit == "cover":
        resized = ImageOps.fit(image, (width, height), method=Image.Resampling.LANCZOS)
    elif fit == "stretch":
        resized = image.resize((width, height), resample=Image.Resampling.LANCZOS)
    else:
        resized = ImageOps.contain(image, (width, height), method=Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (width, height), background if output_format == "jpg" else (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((width - resized.width) // 2, (height - resized.height) // 2))
    if output_format == "jpg":
        canvas = canvas.convert("RGB")
    output = context.path("delivered." + output_format)
    embed_icc = context.options.get("embedIcc", True)
    kwargs = {"icc_profile": icc} if icc and embed_icc else {}
    quality = None
    if context.options.get("embedIcc") is True and not icc:
        raise WorkerError("ICC_PROFILE_REQUIRED", "Source snapshot has no ICC profile to embed; no source color space was assumed", True)
    if output_format == "jpg":
        requested_quality = integer(context.options.get("jpegQuality", 10), "jpegQuality", 0, 12)
        quality = round(5 + requested_quality * 90 / 12)
        kwargs.update(quality=quality, subsampling=0)
    with output.open("xb") as target:
        canvas.save(target, format="JPEG" if output_format == "jpg" else "PNG", **kwargs)
    context.check()
    metadata = {"width": width, "height": height, "sourceSha256": context.input_hashes["source"], "fit": fit, "iccEmbedded": bool(icc and embed_icc), "alpha": "none" if output_format == "jpg" else "straight", "jpegEncoder": "Pillow" if output_format == "jpg" else None, "jpegQuality0To100": quality}
    artifact = context.artifact(output, "image", "image/jpeg" if output_format == "jpg" else "image/png", metadata)
    return {"artifactIndex": artifact, "media": {"width": width, "height": height, "kind": "image", "mimeType": "image/jpeg" if output_format == "jpg" else "image/png"}, **metadata}


def transcribe(context: Context) -> dict:
    model = pin_model(context.profile, "whisper")
    if context.options.get("modelId") not in (None, model.get("id"), "local-whisper"):
        raise WorkerError("MODEL_MISMATCH", "Requested ASR model does not match the installed profile", True)
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise WorkerError("WORKER_REQUIRES_SETUP", "Install the pinned faster-whisper environment", True) from None
    language = context.options.get("language")
    if language == "auto":
        language = None
    if language is not None and (not isinstance(language, str) or not re.fullmatch(r"[a-z]{2,3}", language)):
        raise WorkerError("INVALID_LANGUAGE", "ASR language must be a language code", True)
    manifest = inspection(context, context.input())
    if not manifest["hasAudio"]:
        raise WorkerError("NO_AUDIO", "Transcription source has no audio stream", True)
    audio_stream = next(stream for stream in manifest["streams"] if stream.get("codec_type") == "audio")
    audio_offset, _ = audio_origin(manifest)
    decoded = context.path("transcription-input.wav", temporary=True)
    # Decode via the bounded local transport before PyAV/ASR can follow container URLs.
    ffmpeg(context, ["-i", str(context.input()), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(decoded)])
    actual = inspection(context, decoded)
    expected_audio_duration = audio_stream.get("duration")
    if expected_audio_duration is not None and abs(int(actual["durationTicks"]) - int(seconds_to_ticks(expected_audio_duration))) > TICKS_PER_SECOND // 20:
        raise WorkerError("ASR_DECODE_DURATION_MISMATCH", "Decoded ASR audio is truncated or has a different source duration")
    engine = WhisperModel(model["path"], device=model.get("device", "cpu"), compute_type=model.get("computeType", "int8"), cpu_threads=context.threads, num_workers=1, local_files_only=True)
    segments, info = engine.transcribe(str(decoded), language=language, word_timestamps=True, vad_filter=bool(context.options.get("vadFilter", True)), beam_size=integer(context.options.get("beamSize", 5), "beamSize", 1, 10))
    words, cues = [], []
    for segment in segments:
        context.check()
        if segment.text.strip():
            cues.append({"startTicks": seconds_to_ticks(Fraction(str(segment.start)) + audio_offset), "endTicks": seconds_to_ticks(Fraction(str(segment.end)) + audio_offset), "text": segment.text.strip()})
        for word in segment.words or []:
            if word.end <= word.start:
                continue
            words.append({"word": word.word, "startTicks": seconds_to_ticks(Fraction(str(word.start)) + audio_offset), "endTicks": seconds_to_ticks(Fraction(str(word.end)) + audio_offset), "confidence": float(word.probability)})
    data = {"clock": "source", "language": info.language, "languageProbability": float(info.language_probability), "durationTicks": manifest["durationTicks"], "audioSourceOffsetTicks": seconds_to_ticks(audio_offset), "words": words, "cues": cues, "modelId": model.get("id", "whisper"), "modelSha256": model["sha256"], "sourceSha256": context.input_hashes["source"]}
    context.json_artifact("transcript.json", data, "transcript")
    srt = context.path("transcript.srt")
    with srt.open("x", encoding="utf-8", newline="\n") as target:
        for index, cue in enumerate(cues, 1):
            def stamp(ticks: str) -> str:
                ms = max(0, (int(ticks) * 1000 + TICKS_PER_SECOND // 2) // TICKS_PER_SECOND)
                hours, rem = divmod(ms, 3600000)
                minutes, rem = divmod(rem, 60000)
                seconds, millis = divmod(rem, 1000)
                return f"{hours:02}:{minutes:02}:{seconds:02},{millis:03}"
            target.write(f"{index}\n{stamp(cue['startTicks'])} --> {stamp(cue['endTicks'])}\n{cue['text']}\n\n")
    context.artifact(srt, "captions_srt", "application/x-subrip", {"clock": "source"})
    return data


def loudness_settings(context: Context) -> tuple[float, float, float]:
    return (number(context.options.get("targetLufs", -16), "targetLufs", -70, -5), number(context.options.get("truePeakDb", -1), "truePeakDb", -9, 0), number(context.options.get("maxLra", 11), "maxLra", 1, 50))


def gain_filter(context: Context) -> str:
    gain = number(context.options.get("gainDb", 0), "gainDb", -96, 36)
    points = context.options.get("envelope", [])
    if not isinstance(points, list) or len(points) > 500:
        raise WorkerError("INVALID_ENVELOPE", "Envelope must contain at most 500 ordered points", True)
    expression = f"{gain:.9g}"
    parsed = []
    for point in points:
        if not isinstance(point, dict) or not isinstance(point.get("ticks"), str) or not point["ticks"].isdigit():
            raise WorkerError("INVALID_ENVELOPE", "Envelope points need nonnegative ticks and gainDb", True)
        parsed.append((int(point["ticks"]), number(point.get("gainDb"), "envelope.gainDb", -96, 36)))
    if any(right[0] <= left[0] for left, right in zip(parsed, parsed[1:])):
        raise WorkerError("INVALID_ENVELOPE", "Envelope times must strictly increase", True)
    if parsed:
        expression = f"{parsed[-1][1] + gain:.9g}"
        for (left_t, left_gain), (right_t, right_gain) in reversed(list(zip(parsed, parsed[1:]))):
            left, right = ticks_to_seconds(str(left_t)), ticks_to_seconds(str(right_t))
            ramp = f"({left_gain + gain:.9g}+({right_gain-left_gain:.9g})*(t-{left})/({right}-{left}))"
            expression = f"if(lt(t,{right}),{ramp},{expression})"
        expression = f"if(lt(t,{ticks_to_seconds(str(parsed[0][0]))}),{parsed[0][1]+gain:.9g},{expression})"
    # All tokens are constructed from checked finite numbers, never user filter strings.
    return f"volume='pow(10,({expression})/20)':eval=frame"


def loudness_measure(context: Context, path: Path, prefix: str = "") -> tuple[dict, str]:
    target, peak, lra = loudness_settings(context)
    chain = f"{prefix}," if prefix else ""
    chain += f"loudnorm=I={target}:TP={peak}:LRA={lra}:print_format=json"
    _, stderr = ffmpeg(context, ["-i", str(path), "-map", "0:a:0", "-vn", "-af", chain, "-f", "null", "-"])
    matches = re.findall(r'\{\s*"input_i"\s*:.*?\}', stderr, flags=re.S)
    if not matches:
        raise WorkerError("AUDIO_MEASUREMENT_MISSING", "FFmpeg returned no loudness measurement")
    measured = json.loads(matches[-1])
    return measured, stderr


def finite_measurement(value: str) -> float | None:
    parsed = float(value)
    return parsed if math.isfinite(parsed) else None


def analyze(context: Context) -> dict:
    media = inspection(context, context.input())
    if not media["hasAudio"]:
        raise WorkerError("NO_AUDIO", "Source has no audio stream", True)
    measured, _ = loudness_measure(context, context.input())
    silence_db = number(context.options.get("silenceThresholdDb", -40), "silenceThresholdDb", -100, -10)
    silence_duration = number(context.options.get("minimumSilenceSeconds", 0.25), "minimumSilenceSeconds", 0.01, 60)
    _, stderr = ffmpeg(context, ["-i", str(context.input()), "-map", "0:a:0", "-vn", "-af", f"silencedetect=noise={silence_db}dB:d={silence_duration}", "-f", "null", "-"])
    intervals, start = [], None
    for event, value in re.findall(r"silence_(start|end):\s*(-?[\d.]+)", stderr):
        if event == "start":
            start = max(Fraction(0), Fraction(value))
        elif start is not None:
            intervals.append({"startTicks": seconds_to_ticks(start), "endTicks": seconds_to_ticks(value)})
            start = None
    if start is not None:
        intervals.append({"startTicks": seconds_to_ticks(start), "endTicks": media["durationTicks"]})
    data = {"durationTicks": media["durationTicks"], "clock": "source", "integratedLufs": finite_measurement(measured["input_i"]), "maxTruePeakDbtp": finite_measurement(measured["input_tp"]), "loudnessRangeLu": finite_measurement(measured["input_lra"]), "thresholdLufs": finite_measurement(measured["input_thresh"]), "silenceIntervals": intervals, "measurement": measured}
    context.json_artifact("audio-measurement.json", data, "audio_measurement")
    return data


def render_audio(context: Context) -> dict:
    prefix = gain_filter(context)
    measured, _ = loudness_measure(context, context.input(), prefix)
    if any(finite_measurement(measured[key]) is None for key in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")):
        raise WorkerError("AUDIO_UNMEASURABLE", "Silent or unmeasurable audio cannot be normalized to the requested loudness")
    target, peak, lra = loudness_settings(context)
    second = f"loudnorm=I={target}:TP={peak}:LRA={lra}:measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:offset={measured['target_offset']}:linear=true:print_format=json"
    sample_rate = integer(context.options.get("sampleRate", 48000), "sampleRate", 8000, 192000)
    channels = integer(context.options.get("channels", 2), "channels", 1, 8)
    output = context.path("processed-audio.wav")
    ffmpeg(context, ["-i", str(context.input()), "-map", "0:a:0", "-vn", "-af", f"{prefix},{second}", "-ar", str(sample_rate), "-ac", str(channels), "-c:a", "pcm_s24le", str(output)])
    final, _ = loudness_measure(context, output)
    actual_lufs, actual_peak = finite_measurement(final["input_i"]), finite_measurement(final["input_tp"])
    if actual_lufs is None or actual_peak is None or abs(actual_lufs - target) > 0.5 or actual_peak > peak + 0.1:
        raise WorkerError("AUDIO_POSTCONDITION_FAILED", "Rendered audio did not meet LUFS (±0.5) or true-peak (+0.1dB) limits")
    media = inspection(context, output)
    original = inspection(context, context.input())
    if abs(int(media["durationTicks"]) - int(original["durationTicks"])) > 2 * TICKS_PER_SECOND // sample_rate:
        raise WorkerError("AUDIO_DURATION_MISMATCH", "Processed audio duration changed by more than two samples")
    index = context.artifact(output, "processed_audio", "audio/wav", {"sourceSha256": context.input_hashes["source"], "sampleRate": sample_rate, "channels": channels, "processing": "gain-envelope+two-pass-loudnorm"})
    return {"artifactIndex": index, "durationTicks": media["durationTicks"], "integratedLufs": actual_lufs, "maxTruePeakDbtp": actual_peak, "sampleRate": sample_rate, "channels": channels, "clock": "source"}


def timecode_ticks(value: str, fps: Fraction) -> str:
    match = re.fullmatch(r"(\d{2}):(\d{2}):(\d{2})([:;.])(\d{2,3})", value)
    if not match or not (fps.denominator == 1 and fps.numerator in (24, 25, 30, 48, 50, 60, 100, 120) or fps in (Fraction(24000, 1001), Fraction(30000, 1001), Fraction(60000, 1001), Fraction(120000, 1001))):
        raise WorkerError("TIMECODE_FORMAT_UNSUPPORTED", "Timecode needs an explicit supported SMPTE label and observed rational frame rate", True)
    hours, minutes, seconds, separator, frames = match.groups()
    hour, minute, second, frame = map(int, (hours, minutes, seconds, frames))
    nominal = (fps.numerator + fps.denominator // 2) // fps.denominator
    if hour >= 24 or minute >= 60 or second >= 60 or frame >= nominal:
        raise WorkerError("INVALID_TIMECODE", "Timecode component is outside its frame/day range", True)
    count = ((hour * 60 + minute) * 60 + second) * nominal + frame
    if separator != ":":
        if fps not in (Fraction(30000, 1001), Fraction(60000, 1001)):
            raise WorkerError("TIMECODE_DROP_RATE_UNSUPPORTED", "Drop-frame labels require 30000/1001 or 60000/1001 fps", True)
        dropped = 2 if nominal == 30 else 4
        if minute % 10 and second == 0 and frame < dropped:
            raise WorkerError("INVALID_TIMECODE", "The requested drop-frame label is skipped at this minute", True)
        elapsed_minutes = hour * 60 + minute
        count -= dropped * (elapsed_minutes - elapsed_minutes // 10)
    return seconds_to_ticks(Fraction(count, 1) / fps)


def observed_timecode(context: Context, key: str) -> dict:
    media = inspection(context, context.input(key))
    videos = [stream for stream in media["streams"] if stream.get("codec_type") == "video" and not stream.get("disposition", {}).get("attached_pic")]
    if len(videos) != 1:
        raise WorkerError("TIMECODE_STREAM_AMBIGUOUS", "Timecode sync requires one unambiguous video stream", True)
    video = videos[0]
    observed_rate = media.get("frameRate")
    if not observed_rate:
        raise WorkerError("TIMECODE_RATE_MISSING", "The video stream has no observed rational frame rate", True)
    fps = Fraction(observed_rate["num"], observed_rate["den"])
    declared_rate = rate(video.get("r_frame_rate"))
    if declared_rate and Fraction(declared_rate["num"], declared_rate["den"]) != fps:
        raise WorkerError("TIMECODE_RATE_AMBIGUOUS", "Nominal and average frame rates disagree; timecode requires a qualified clock mapping", True)
    tags = []
    for location, owner in [("format", media["format"]), *[(f"stream:{stream.get('index')}", stream) for stream in media["streams"]]]:
        value = owner.get("tags", {}).get("timecode")
        if value is not None:
            if not isinstance(value, str):
                raise WorkerError("INVALID_TIMECODE", "The observed timecode tag is not a string", True)
            tags.append({"location": location, "value": value, "ticks": timecode_ticks(value, fps)})
    if not tags:
        raise WorkerError("TIMECODE_MISSING", "No actual timecode tag was observed", True)
    if len({tag["ticks"] for tag in tags}) != 1:
        raise WorkerError("TIMECODE_TAG_CONFLICT", "Container and stream timecodes disagree", True)
    if "start_pts" in video and video.get("time_base"):
        video_start = Fraction(int(video["start_pts"])) * Fraction(video["time_base"])
    elif video.get("start_time") is not None:
        video_start = Fraction(video["start_time"])
    else:
        raise WorkerError("TIMECODE_ORIGIN_MISSING", "The video stream start time is not observed", True)
    if media["format"].get("start_time") is None:
        raise WorkerError("TIMECODE_ORIGIN_MISSING", "The container start time is not observed", True)
    video_offset = video_start - Fraction(media["format"]["start_time"])
    return {"tags": tags, "frameRate": observed_rate, "timecodeTicks": tags[0]["ticks"], "videoOffsetTicks": seconds_to_ticks(video_offset), "sourceSha256": context.input_hashes[key]}


def timecode_sync(context: Context) -> dict:
    reference = observed_timecode(context, "reference")
    source = observed_timecode(context, "source")
    offset = int(source["timecodeTicks"]) - int(reference["timecodeTicks"]) - int(source["videoOffsetTicks"]) + int(reference["videoOffsetTicks"])
    if abs(offset) >= 12 * 60 * 60 * TICKS_PER_SECOND:
        raise WorkerError("TIMECODE_DAY_AMBIGUOUS", "A possible 24-hour wrap requires explicit manual day/offset mapping", True)
    data = {"method": "timecode", "offsetTicks": str(offset), "clock": "source", "referenceConvention": "referenceTime=sourceTime+offset", "reference": reference, "source": source, "acousticResidual": "not_measured"}
    context.json_artifact("timecode-sync.json", data, "timecode_sync")
    return data


def sync(context: Context) -> dict:
    method = context.options.get("method", "waveform")
    if method == "timecode":
        return timecode_sync(context)
    if method != "waveform":
        raise WorkerError("INVALID_ARGUMENT", "Sync method must be timecode or waveform", True)
    try:
        import numpy as np
    except ImportError:
        raise WorkerError("WORKER_REQUIRES_SETUP", "Install the pinned numpy environment for waveform sync", True) from None
    sample_rate = integer(context.options.get("sampleRate", 8000), "sampleRate", 1000, 48000)
    window = number(context.options.get("windowSeconds", 90), "windowSeconds", 2, 600)
    maximum = number(context.options.get("maxOffsetSeconds", 30), "maxOffsetSeconds", 0.01, window / 2)
    arrays = []
    origins = {}
    for key in ("reference", "source"):
        offset, evidence = audio_origin(inspection(context, context.input(key)))
        origins[key] = {"offset": offset, "evidence": evidence}
        path = context.path(f"sync-{key}.f32", temporary=True)
        ffmpeg(context, ["-i", str(context.input(key)), "-map", "0:a:0", "-t", str(window), "-vn", "-ac", "1", "-ar", str(sample_rate), "-c:a", "pcm_f32le", "-f", "f32le", str(path)])
        arrays.append(np.fromfile(path, dtype="<f4").astype(np.float64))
    reference, source = arrays
    if min(len(reference), len(source)) < sample_rate:
        raise WorkerError("SYNC_INSUFFICIENT_AUDIO", "At least one second of overlapping audio is required", True)
    reference -= reference.mean()
    source -= source.mean()
    size = 1 << (len(reference) + len(source) - 2).bit_length()
    correlation = np.fft.irfft(np.fft.rfft(reference, size) * np.conj(np.fft.rfft(source, size)), size)
    limit = int(maximum * sample_rate)
    lags = np.arange(-limit, limit + 1)
    values = correlation[lags % size]
    best = int(lags[int(np.argmax(values))])
    ref_start, source_start = max(best, 0), max(-best, 0)
    overlap = min(len(reference) - ref_start, len(source) - source_start)
    ref = reference[ref_start:ref_start + overlap]
    src = source[source_start:source_start + overlap]
    norm = float(np.linalg.norm(ref) * np.linalg.norm(src))
    confidence = float(np.dot(ref, src) / norm) if norm > 1e-12 else 0.0
    # Residual is independently measured on the last overlapping quarter, not asserted to zero.
    quarter = min(overlap // 4, sample_rate * 10)
    if quarter < sample_rate // 2:
        raise WorkerError("SYNC_INSUFFICIENT_OVERLAP", "Too little independent overlap to validate sync")
    ref_tail, src_tail = ref[-quarter:], src[-quarter:]
    tail_size = 1 << (quarter * 2 - 2).bit_length()
    tail_corr = np.fft.irfft(np.fft.rfft(ref_tail, tail_size) * np.conj(np.fft.rfft(src_tail, tail_size)), tail_size)
    residual_lags = np.arange(-min(sample_rate // 10, quarter // 4), min(sample_rate // 10, quarter // 4) + 1)
    residual = int(residual_lags[int(np.argmax(tail_corr[residual_lags % tail_size]))])
    context.check()
    minimum = number(context.options.get("minimumConfidence", 0.3), "minimumConfidence", 0, 1)
    if confidence < minimum:
        raise WorkerError("SYNC_UNCERTAIN", f"Waveform correlation {confidence:.4f} is below configured confidence {minimum}")
    sample_lag = Fraction(best, sample_rate)
    source_clock_offset = sample_lag + origins["reference"]["offset"] - origins["source"]["offset"]
    data = {"method": "waveform", "offsetTicks": seconds_to_ticks(source_clock_offset), "measuredSampleLagTicks": seconds_to_ticks(sample_lag), "audioOrigins": {key: entry["evidence"] for key, entry in origins.items()}, "residualOffsetSamples": str(residual), "sampleRate": sample_rate, "confidence": max(0.0, min(1.0, confidence)), "clock": "source", "referenceConvention": "referenceTime=sourceTime+offset", "analyzedOverlapSamples": overlap, "referenceSha256": context.input_hashes["reference"], "sourceSha256": context.input_hashes["source"]}
    context.json_artifact("audio-sync.json", data, "audio_sync")
    return data


def verify(context: Context) -> dict:
    output_spec = context.options.get("output")
    if isinstance(output_spec, dict) and output_spec.get("encoding", {}).get("kind") == "subtitle":
        return verify_subtitle(context, output_spec)
    media = inspection(context, context.input())
    decoded = False
    if context.options.get("decode") is True or context.options.get("verifyMode") == "full_decode":
        ffmpeg(context, ["-v", "error", "-xerror", "-i", str(context.input()), "-map", "0:v?", "-map", "0:a?", "-f", "null", "-"])
        decoded = True
    expected = dict(context.options.get("expected", {}))
    output = context.options.get("output")
    if output is not None and not isinstance(output, dict):
        raise WorkerError("INVALID_OUTPUT_SPEC", "output must be an ArtifactSpec", True)
    if output:
        for field in ("width", "height"):
            if field in output:
                expected[field] = output[field]
        if output.get("range", {}).get("kind") == "timeline_range":
            span = output["range"]["value"]
            expected["durationTicks"] = str(int(span["end"]["ticks"]) - int(span["start"]["ticks"]))
        elif context.options.get("expectedDurationTicks") is not None:
            expected["durationTicks"] = context.options["expectedDurationTicks"]
    failures, checks = [], []
    for key in ("width", "height", "hasVideo", "hasAudio"):
        if key in expected:
            passed = media[key] == expected[key]
            checks.append({"name": key, "status": "pass" if passed else "fail", "expected": expected[key], "actual": media[key]})
            if not passed:
                failures.append(key)
    if "durationTicks" in expected:
        fps = (output or {}).get("frameRate") or media.get("frameRate")
        frame_ticks = math.ceil(Fraction(fps["den"], fps["num"]) * TICKS_PER_SECOND) if fps else 0
        tolerance = integer(context.options.get("durationToleranceTicks", frame_ticks), "durationToleranceTicks", 0, TICKS_PER_SECOND * 60)
        if abs(int(expected["durationTicks"]) - int(media["durationTicks"])) > tolerance:
            failures.append("durationTicks")
        checks.append({"name": "durationTicks", "status": "fail" if "durationTicks" in failures else "pass", "expected": expected["durationTicks"], "actual": media["durationTicks"]})
    def compare(name: str, wanted, actual, passed: bool | None = None) -> None:
        success = wanted == actual if passed is None else passed
        checks.append({"name": name, "status": "pass" if success else "fail", "expected": wanted, "actual": actual})
        if not success:
            failures.append(name)
    if output:
        streams = media["streams"]
        video = next((stream for stream in streams if stream.get("codec_type") == "video" and not stream.get("disposition", {}).get("attached_pic")), {})
        audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), {})
        fps = output.get("frameRate")
        if fps:
            actual = media.get("frameRate")
            compare("frameRate", fps, actual, bool(actual and Fraction(fps["num"], fps["den"]) == Fraction(actual["num"], actual["den"])))
        aspect = output.get("pixelAspect")
        if aspect:
            actual = rate(video.get("sample_aspect_ratio", "").replace(":", "/"))
            compare("pixelAspect", aspect, actual, bool(actual and Fraction(aspect["num"], aspect["den"]) == Fraction(actual["num"], actual["den"])))
        encoding = output.get("encoding", {})
        if encoding.get("kind") == "video":
            aliases = {"avc": "h264", "avc1": "h264", "hevc": "hevc", "h265": "hevc", "hvc1": "hevc", "prores_ks": "prores", "libx264": "h264", "libx265": "hevc", "pcm": "pcm_s24le"}
            wanted_codec = aliases.get(str(encoding.get("videoCodec", "")).lower(), str(encoding.get("videoCodec", "")).lower())
            compare("videoCodec", wanted_codec, video.get("codec_name"))
            compare("pixelFormat", encoding.get("pixelFormat"), video.get("pix_fmt"))
            order = {"progressive": "progressive", "tt": "top_first", "tb": "top_first", "bb": "bottom_first", "bt": "bottom_first"}.get(video.get("field_order"), "unknown")
            compare("fieldOrder", encoding.get("fieldOrder"), order)
            if encoding.get("audioCodec"):
                requested_codec = str(encoding["audioCodec"]).lower()
                compare("audioCodec", aliases.get(requested_codec, requested_codec), audio.get("codec_name"))
        if output.get("audio"):
            requested_audio = output["audio"]
            actual_audio = media.get("audio") or {}
            for requested_key, observed_key in (("sampleRate", "sampleRate"), ("channels", "channels"), ("channelLayout", "layout")):
                if requested_key in requested_audio:
                    compare("audio." + requested_key, requested_audio[requested_key], actual_audio.get(observed_key))
            if "integratedLufs" in requested_audio or "maxTruePeakDbtp" in requested_audio:
                measured, _ = loudness_measure(context, context.input())
                lufs, peak = finite_measurement(measured["input_i"]), finite_measurement(measured["input_tp"])
                if "integratedLufs" in requested_audio:
                    wanted = number(requested_audio["integratedLufs"], "integratedLufs", -70, -5)
                    compare("audio.integratedLufs", wanted, lufs, lufs is not None and abs(lufs - wanted) <= 0.5)
                if "maxTruePeakDbtp" in requested_audio:
                    wanted = number(requested_audio["maxTruePeakDbtp"], "maxTruePeakDbtp", -96, 0)
                    compare("audio.maxTruePeakDbtp", wanted, peak, peak is not None and peak <= wanted + 0.1)
        if encoding.get("kind") == "image":
            try:
                from PIL import Image, ImageCms
            except ImportError:
                raise WorkerError("WORKER_REQUIRES_SETUP", "Pillow is required to verify image color/encoding", True) from None
            with Image.open(context.input()) as image:
                image.load()
                image_format, image_mode = image.format, image.mode
                icc = image.info.get("icc_profile")
                has_alpha = "A" in image.getbands() or "transparency" in image.info
                depth = 32 if image_mode == "F" else 16 if "16" in image_mode else 8
                if image_format == "PNG":
                    with context.input().open("rb") as image_file:
                        header = image_file.read(33)
                    depth = header[24]
                elif image_format == "TIFF":
                    bits = image.tag_v2.get(258, (depth,))
                    if isinstance(bits, int):
                        bits = (bits,)
                    depth = int(bits[0]) if len(set(bits)) == 1 else None
                requested_format = str(output.get("format", "")).upper()
                expected_format = {"JPG": "JPEG", "TIF": "TIFF"}.get(requested_format, requested_format)
                compare("image.format", expected_format, image_format)
                compression = "jpeg" if image_format == "JPEG" else "lossless" if image_format in ("PNG", "BMP") else "unobserved"
                if image_format == "TIFF":
                    compression_name = image.info.get("compression")
                    compression = "lossless" if compression_name in ("raw", "tiff_lzw", "packbits", "tiff_adobe_deflate", "tiff_deflate", "lzma", "zstd") else "jpeg" if compression_name in ("jpeg", "tiff_jpeg") else "unobserved"
                compare("image.compression", encoding.get("compression"), compression)
                compare("image.embedIcc", encoding.get("embedIcc"), bool(icc))
                color = output.get("color", {})
                if "bitDepth" in color:
                    compare("color.bitDepth", color["bitDepth"], depth)
                if "range" in color:
                    compare("color.range", color["range"], "full")
                if "alpha" in color:
                    compare("color.alpha", color["alpha"], "straight" if has_alpha and image_format == "PNG" else "none" if not has_alpha else "unobserved_association")
                if color.get("iccProfile"):
                    description = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(icc))).strip() if icc else None
                    compare("color.iccProfile", color["iccProfile"], description)
                for name in ("primaries", "transfer", "matrix"):
                    if name in color:
                        compare("color." + name, color[name], "not_observed_by_image_decoder", False)
        elif output.get("color"):
            color = output["color"]
            for name, key in (("primaries", "color_primaries"), ("transfer", "color_transfer"), ("matrix", "color_space")):
                if name in color:
                    compare("color." + name, color[name], video.get(key))
            if "range" in color:
                compare("color.range", color["range"], {"tv": "limited", "pc": "full"}.get(video.get("color_range"), "unknown"))
            if "bitDepth" in color or "alpha" in color:
                formats, _ = context.run("ffprobe", ["-v", "error", "-show_pixel_formats", "-of", "json"])
                descriptor = next((entry for entry in json.loads(formats).get("pixel_formats", []) if entry.get("name") == video.get("pix_fmt")), {})
                depths = {component.get("bit_depth") for component in descriptor.get("components", [])}
                if "bitDepth" in color:
                    compare("color.bitDepth", color["bitDepth"], next(iter(depths)) if len(depths) == 1 else None)
                if color.get("alpha") == "none":
                    compare("color.alpha", "none", "present" if descriptor.get("flags", {}).get("alpha") else "none")
                elif "alpha" in color:
                    # Pixel format cannot prove straight vs premultiplied alpha semantics.
                    compare("color.alpha", color["alpha"], "unobserved_association", False)
            if color.get("iccProfile"):
                compare("color.iccProfile", color["iccProfile"], "not_observed_by_ffprobe", False)
    if failures:
        raise WorkerError("ARTIFACT_POSTCONDITION_FAILED", f"Artifact does not satisfy: {', '.join(failures)}")
    if digest_file(context.input()) != context.input_hashes["source"]:
        raise WorkerError("INPUT_CHANGED_DURING_VERIFY", "Output changed while its postconditions were being verified")
    return {"sha256": context.input_hashes["source"], "sizeBytes": str(context.input().stat().st_size), "media": media, "decoded": decoded, "checks": checks, "verified": bool(checks), "complete": True}


def verify_subtitle(context: Context, output: dict) -> dict:
    if context.input().stat().st_size > 16 * 1024 * 1024:
        raise WorkerError("SUBTITLE_LIMIT", "Subtitle verification limit is 16 MiB", True)
    if str(output.get("format", "")).lower() != "srt":
        raise WorkerError("SUBTITLE_FORMAT_UNSUPPORTED", "This subtitle verifier supports SRT", True)
    raw = context.input().read_bytes()
    text = raw.decode("utf-8-sig", errors="strict")
    requested = output["encoding"]
    if requested.get("charset") != "utf-8":
        raise WorkerError("SUBTITLE_CHARSET_UNSUPPORTED", "SRT output must be UTF-8", True)
    endings = "CRLF" if b"\r\n" in raw and b"\n" not in raw.replace(b"\r\n", b"") else "LF" if b"\r" not in raw else "mixed"
    if endings != requested.get("lineEnding"):
        raise WorkerError("SUBTITLE_LINE_ENDINGS", "Subtitle line endings differ from the delivery specification")
    normalized = text.replace("\r\n", "\n").strip()
    cues = []
    time_pattern = r"(\d{2,}):(\d{2}):(\d{2}),(\d{3})"
    for block in re.split(r"\n[ \t]*\n", normalized) if normalized else []:
        lines = block.splitlines()
        if len(lines) < 3 or not lines[0].isdigit():
            raise WorkerError("SUBTITLE_CUE_INVALID", "SRT cue needs an index, time range and text")
        match = re.fullmatch(time_pattern + r"\s+-->\s+" + time_pattern, lines[1])
        if not match:
            raise WorkerError("SUBTITLE_CUE_INVALID", "SRT timestamps must have three millisecond digits")
        values = [int(value) for value in match.groups()]
        if any(values[index] >= 60 for index in (1, 2, 5, 6)):
            raise WorkerError("SUBTITLE_CUE_INVALID", "SRT minutes/seconds are out of range")
        start = ((values[0] * 60 + values[1]) * 60 + values[2]) * 1000 + values[3]
        end = ((values[4] * 60 + values[5]) * 60 + values[6]) * 1000 + values[7]
        if end <= start or not "\n".join(lines[2:]).strip():
            raise WorkerError("SUBTITLE_CUE_INVALID", "SRT cue has empty text or a nonpositive duration")
        cues.append({"startTicks": seconds_to_ticks(Fraction(start, 1000)), "endTicks": seconds_to_ticks(Fraction(end, 1000)), "text": "\n".join(lines[2:])})
    if not cues:
        raise WorkerError("SUBTITLE_EMPTY", "SRT has no cues")
    checks = [{"name": "subtitle.charset", "status": "pass", "expected": "utf-8", "actual": "utf-8"}, {"name": "subtitle.lineEnding", "status": "pass", "expected": endings, "actual": endings}, {"name": "subtitle.cues", "status": "pass", "actual": len(cues)}]
    return {"sha256": context.input_hashes["source"], "sizeBytes": str(len(raw)), "cues": cues, "checks": checks, "verified": True, "decoded": True, "complete": True}


def dispatch(context: Context) -> dict:
    return {"media.inspect": inspect, "media.frames": frames, "media.conform": conform, "media.transcribe": transcribe, "audio.analyze": analyze, "audio.render": render_audio, "audio.sync": sync, "artifact.verify": verify}[context.request["operation"]](context)
