"""Focused regression checks for worker receipt and source-time boundaries."""
from __future__ import annotations

from fractions import Fraction
import hashlib
import json
from pathlib import Path
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import wave

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workers"))
from common import TICKS_PER_SECOND, WorkerError, canonical, digest_file, seconds_to_ticks, ticks_to_seconds
from media_ops import timecode_ticks
from worker import execute


class WorkerRegression(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.profile = {"executables": {}}
        for name in ("ffmpeg", "ffprobe"):
            path = shutil.which(name)
            if path:
                actual = Path(path).resolve()
                self.profile["executables"][name] = {"path": str(actual), "sha256": digest_file(actual)}

    def tearDown(self):
        self.temp.cleanup()

    def wav(self, name, samples, sample_rate=8000):
        path = self.root / name
        with wave.open(str(path), "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(sample_rate)
            out.writeframes(struct.pack("<" + "h" * len(samples), *samples))
        return {"path": str(path), "sha256": digest_file(path)}

    def request(self, operation, inputs, options=None):
        output = self.root / "output"
        output.mkdir(exist_ok=True)
        return {"workerRequestId": "regression-1", "operation": operation, "inputs": inputs, "options": options or {}, "outputDirectory": str(output), "limits": {"maxCpuThreads": 1, "maxTemporaryBytes": "32000000", "maxOutputBytes": 1000000, "timeoutMs": 20000}}

    def test_rational_time_does_not_lose_large_tick_precision(self):
        ticks = seconds_to_ticks(Fraction(1001, 30000) * 123456789)
        self.assertEqual(ticks, str(8475667200 * 123456789))
        self.assertLessEqual(abs(int(seconds_to_ticks(ticks_to_seconds(ticks))) - int(ticks)), 1)

    def test_existing_claim_without_receipt_is_never_replayed_or_rewritten(self):
        request = self.request("media.inspect", {})
        identity = hashlib.sha256(request["workerRequestId"].encode()).hexdigest()
        claim = Path(request["outputDirectory"]) / f".claim-{identity}.json"
        claim.write_bytes(canonical({"requestDigest": hashlib.sha256(canonical(request)).hexdigest()}))
        result = execute(request, self.profile, [str(self.root)], threading.Event())
        self.assertEqual(result["error"]["code"], "WORKER_OUTCOME_UNKNOWN")
        self.assertFalse((Path(request["outputDirectory"]) / f".receipt-{identity}.json").exists())

    def test_inspect_receipt_reuses_same_identity_and_rejects_changed_arguments(self):
        self.assertIn("ffprobe", self.profile["executables"], "This scoped case requires local ffprobe")
        source = self.wav("source.wav", [0] * 8000)
        request = self.request("media.inspect", {"source": source})
        first = execute(request, self.profile, [str(self.root)], threading.Event())
        self.assertTrue(first["ok"], first)
        self.assertEqual(first["data"]["durationTicks"], str(TICKS_PER_SECOND))
        self.assertEqual(first["data"]["audio"]["sampleRate"], 8000)
        second = execute(request, self.profile, [str(self.root)], threading.Event())
        self.assertEqual(first, second)
        changed = {**request, "options": {"scanFrameTiming": True}}
        conflict = execute(changed, self.profile, [str(self.root)], threading.Event())
        self.assertEqual(conflict["error"]["code"], "IDEMPOTENCY_CONFLICT")

    def test_waveform_offset_sign_and_independent_residual(self):
        self.assertIn("ffmpeg", self.profile["executables"], "This scoped case requires local ffmpeg")
        generator = random.Random(301)
        signal = [generator.randrange(-15000, 15000) for _ in range(24000)]
        inputs = {"reference": self.wav("reference.wav", [0] * 2000 + signal), "source": self.wav("source.wav", signal + [0] * 2000)}
        request = self.request("audio.sync", inputs, {"windowSeconds": 3, "maxOffsetSeconds": 0.5, "sampleRate": 8000, "minimumConfidence": 0.9})
        result = execute(request, self.profile, [str(self.root)], threading.Event())
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["data"]["offsetTicks"], str(TICKS_PER_SECOND // 4))
        self.assertEqual(result["data"]["residualOffsetSamples"], "0")
        self.assertGreater(result["data"]["confidence"], 0.99)

    def test_timecode_sync_observes_tags_and_drop_frame_boundaries(self):
        fps = Fraction(30000, 1001)
        self.assertEqual(timecode_ticks("00:01:00;02", fps), str(1800 * 8475667200))
        self.assertEqual(timecode_ticks("00:10:00;00", fps), str(17982 * 8475667200))
        with self.assertRaises(WorkerError):
            timecode_ticks("00:01:00;00", fps)
        inputs = {}
        for key, label in (("reference", "01:00:00;00"), ("source", "01:00:01;00")):
            target = self.root / f"{key}.mov"
            subprocess.run([self.profile["executables"]["ffmpeg"]["path"], "-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=size=32x32:rate=30000/1001:duration=0.1", "-c:v", "mpeg4", "-threads", "1", "-timecode", label, str(target)], check=True, capture_output=True, timeout=10)
            inputs[key] = {"path": str(target), "sha256": digest_file(target)}
        result = execute(self.request("audio.sync", inputs, {"method": "timecode"}), self.profile, [str(self.root)], threading.Event())
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["data"]["method"], "timecode")
        self.assertEqual(result["data"]["offsetTicks"], str(30 * 8475667200))
        self.assertNotIn("residualOffsetSamples", result["data"])
        self.assertEqual(result["data"]["source"]["tags"][0]["value"], "01:00:01;00")

    def test_waveform_sync_includes_container_audio_origin(self):
        generator = random.Random(409)
        audio = self.wav("audio.wav", [generator.randrange(-15000, 15000) for _ in range(24000)])
        reference = self.root / "delayed-audio.mkv"
        subprocess.run([self.profile["executables"]["ffmpeg"]["path"], "-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "color=size=32x32:rate=25:duration=3.5", "-itsoffset", "0.25", "-i", audio["path"], "-map", "0:v:0", "-map", "1:a:0", "-c:v", "ffv1", "-threads", "1", "-c:a", "pcm_s16le", str(reference)], check=True, capture_output=True, timeout=10)
        inputs = {"reference": {"path": str(reference), "sha256": digest_file(reference)}, "source": audio}
        result = execute(self.request("audio.sync", inputs, {"windowSeconds": 3, "maxOffsetSeconds": 0.5, "sampleRate": 8000, "minimumConfidence": 0.9}), self.profile, [str(self.root)], threading.Event())
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["data"]["offsetTicks"], str(TICKS_PER_SECOND // 4))
        self.assertEqual(result["data"]["audioOrigins"]["reference"]["offsetTicks"], str(TICKS_PER_SECOND // 4))
        self.assertEqual(result["data"]["measuredSampleLagTicks"], "0")

    def test_still_delivery_is_encoded_and_output_dimensions_are_observed(self):
        from PIL import Image
        source = self.root / "snapshot.png"
        Image.new("RGBA", (4, 2), (255, 0, 0, 128)).save(source)
        request = self.request("media.conform", {"source": {"path": str(source), "sha256": digest_file(source)}}, {"outputFormat": "jpg", "width": 8, "height": 8, "fit": "contain", "embedIcc": False, "backgroundColor": "#FFFFFF"})
        result = execute(request, self.profile, [str(self.root)], threading.Event())
        self.assertTrue(result["ok"], result)
        output = Path(result["artifacts"][0]["path"])
        with Image.open(output) as image:
            self.assertEqual(image.format, "JPEG")
            self.assertEqual(image.size, (8, 8))
        wrong_size = self.request("artifact.verify", {"source": {"path": str(output), "sha256": digest_file(output)}}, {"expected": {"width": 9}})
        wrong_size["workerRequestId"] = "verify-wrong-width"
        checked = execute(wrong_size, self.profile, [str(self.root)], threading.Event())
        self.assertEqual(checked["error"]["code"], "ARTIFACT_POSTCONDITION_FAILED")

    def test_subtitle_verification_reads_cues_and_line_endings(self):
        source = self.root / "captions.srt"
        source.write_text("1\n00:00:00,250 --> 00:00:01,000\nHello\n\n2\n00:00:01,100 --> 00:00:02,000\nWorld\n", encoding="utf-8")
        request = self.request("artifact.verify", {"source": {"path": str(source), "sha256": digest_file(source)}}, {"output": {"format": "srt", "encoding": {"kind": "subtitle", "charset": "utf-8", "lineEnding": "LF"}}})
        result = execute(request, self.profile, [str(self.root)], threading.Event())
        self.assertTrue(result["ok"], result)
        self.assertTrue(result["data"]["verified"])
        self.assertEqual(len(result["data"]["cues"]), 2)
        self.assertEqual(result["data"]["cues"][0]["startTicks"], str(TICKS_PER_SECOND // 4))

    def test_frame_receipt_uses_observed_pts_and_actual_scaled_dimensions(self):
        from PIL import Image
        source = self.root / "frame-source.png"
        Image.new("RGB", (64, 96), (30, 90, 150)).save(source)
        request = self.request("media.frames", {"source": {"path": str(source), "sha256": digest_file(source)}}, {"times": [{"ticks": "0"}], "maxEdge": 48, "statistics": True})
        result = execute(request, self.profile, [str(self.root)], threading.Event())
        self.assertTrue(result["ok"], result)
        frame = result["data"]["frames"][0]
        self.assertEqual(frame["resolvedTicks"], "0")
        self.assertEqual((frame["width"], frame["height"]), (32, 48))
        self.assertEqual((frame["sourceWidth"], frame["sourceHeight"]), (64, 96))
        self.assertEqual(frame["color"], {"bitDepth": 8, "range": "full", "alpha": "none"})
        self.assertEqual(frame["statistics"]["mean"], [30.0, 90.0, 150.0])
        self.assertEqual(frame["statistics"]["space"], "encoded_rgb_8bit")

    def test_quota_failure_removes_only_owned_partial_output(self):
        from PIL import Image
        source = self.root / "noise.png"
        generator = random.Random(22)
        Image.frombytes("RGB", (64, 64), bytes(generator.randrange(256) for _ in range(64 * 64 * 3))).save(source)
        before = digest_file(source)
        request = self.request("media.conform", {"source": {"path": str(source), "sha256": before}}, {"outputFormat": "png"})
        request["limits"]["maxTemporaryBytes"] = "1024"
        result = execute(request, self.profile, [str(self.root)], threading.Event())
        self.assertEqual(result["error"]["code"], "TEMPORARY_QUOTA_EXCEEDED")
        self.assertFalse((Path(request["outputDirectory"]) / "delivered.png").exists())
        self.assertEqual(digest_file(source), before)


if __name__ == "__main__":
    unittest.main()
