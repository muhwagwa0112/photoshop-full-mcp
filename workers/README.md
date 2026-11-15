# Local media and image worker

This worker executes fixed operations through local Python and pinned executables/models. It never downloads a model, invokes a shell, changes source files, or interprets a job argument as an executable/filter string. Each job has its own staging directory, quota, deadline, receipt and cancellation channel. Source files must be under the workflow owner's registered roots.

## Installation profile

Use a dedicated Python environment on the machine that will run the worker. Media inspection/conforming/frame extraction/loudness use FFmpeg and ffprobe; waveform sync additionally uses numpy; transcription uses faster-whisper/CTranslate2 and a **local** converted Whisper model directory; segmentation uses the official SAM2 package, matching local checkpoint/config, PyTorch and torchvision; small-defect inpainting uses OpenCV, numpy and Pillow. Install versions compatible with your machine, then record the exact installed versions and hashes:

```sh
python workers/configure.py --output /absolute/path/local-worker-profile.json
python workers/configure.py --output /absolute/path/image-worker-profile.json \
  --sam2-checkpoint /absolute/path/sam2.1_hiera_tiny.pt \
  --sam2-config configs/sam2.1/sam2.1_hiera_t.yaml
python workers/configure.py --output /absolute/path/asr-worker-profile.json \
  --whisper-model /absolute/path/faster-whisper-model
```

Optional model arguments can be combined in **one** profile. `configure.py` only records what is already installed; it never installs dependencies. It refuses to replace an existing profile. Set `ADOBE_MCP_WORKER_PROFILE` in the **owner/daemon** environment to the profile's absolute path, or place it at `<workflow-data-directory>/profiles/local-worker-profile.json`. A profile records `qualification: not_run`; installation alone is not real-device qualification.

For Windows with a WSL worker, run the recorder inside the target WSL environment, copy the profile to an accessible path, and add the following fields with actual installation paths. The Node owner passes only fixed launcher arguments. Map every root used by the script, profile, assets and staging; longer nested mappings should come first:

```json
{
  "launcher": { "executable": "C:\\Windows\\System32\\wsl.exe", "args": ["--distribution", "Ubuntu-24.04", "--exec"] },
  "pathMappings": [{ "hostRoot": "C:\\", "workerRoot": "/mnt/c" }]
}
```

Keep `pythonExecutable` as the **WSL** executable path recorded by the script; `pythonSha256` is checked by the worker in WSL. `workerScript` may be explicitly set to the Windows-visible installation path if auto-discovery is unsuitable. Do not commit machine profiles, model weights, raw media or tokens.

## Protocol

The parent writes one newline-terminated JSON `WorkerRequest` and keeps stdin open. A second line `{ "kind":"cancel", "workerRequestId":"..." }` cancels the owned operation. EOF cancels abandoned work. Stdout contains exactly one `WorkerResult`; libraries must not print progress there. A durable `.claim-*` is saved before execution and a `.receipt-*` after it. An existing claim without receipt returns `WORKER_OUTCOME_UNKNOWN`; it is never automatically replayed.

The owner records the actual profile-file hash and runtime implementation hashes with each worker operation. Dispatch includes that provider identity in the durable request digest. A profile or implementation changed under a running owner is rejected before dispatch; restart the owner with the intended configuration. A previous accepted request keeps its historical result. Reusing a derived artifact in a different revision requires matching input, operation arguments and provider identity.

`inputs` maps `source`, `reference`, `mask` or `protect` to absolute allowed paths and SHA-256 hashes. All outputs are inside `outputDirectory`. Limits are `maxCpuThreads`, decimal-string `maxTemporaryBytes`, integer `maxOutputBytes` and `timeoutMs`. Time values use integer strings at **254016000000 ticks/second**. No binary floating-point timeline ticks are accepted.

| Operation | Options and result |
|---|---|
| `media.inspect` | ffprobe streams/format, duration, dimensions, rational average frame rate, audio layout; `scanFrameTiming:true` explicitly scans PTS. `isVfr:null` means unmeasured. |
| `media.frames` | `times:[{ticks}]`, `maxEdge` (`maxWidth` alias), optional `statistics:true`; actual opaque RGB8 PNGs, source/output dimensions and requested/resolved **source** PTS. Statistics measure encoded RGB values; they do not claim linear-light color measurements. These are not previews of an edited Premiere sequence. |
| `media.conform` | `fps:{num,den}`, optional `width/height`, `pixelAspect`, `audioSampleRate`, `videoCodec:prores\|h264`; derived video and source↔CFR mapping. Explicit `burnSubtitles:true` consumes an SRT input. `outputFormat:png\|jpg` uses actual Pillow encoding/resizing and ICC/alpha handling for still delivery. |
| `media.transcribe` | Optional `language`, pinned `modelId`, `beamSize`, `vadFilter`; bounded local FFmpeg PCM decoding followed by faster-whisper, word timestamps, cues, JSON and UTF-8 SRT in source clock. |
| `audio.analyze` | `targetLufs`, `truePeakDb`, `maxLra`, silence thresholds; observed loudness and silence intervals. Unmeasurable values are null. |
| `audio.render` | Above plus `gainDb`, ordered `envelope:[{ticks,gainDb}]`, `sampleRate/channels`; two-pass loudnorm, post-measurement, lossless WAV. |
| `audio.sync` | `reference` and `source` inputs. `method:waveform` uses `windowSeconds`, `maxOffsetSeconds`, `sampleRate`, `minimumConfidence`, actual first-audio/container origins, correlation and an independently measured residual. `method:timecode` reads actual consistent container/stream tags and rational FPS, including 29.97/59.94 drop-frame labels; absent/conflicting clocks or ambiguous day wrap fail explicitly. Timecode does not claim an acoustic residual. Convention: `referenceTime = sourceTime + offset`. |
| `image.segment` | `points:[{x,y,label:0\|1}]` and/or `box:{left,top,right,bottom}`, `candidates:1\|3`, pinned `modelId`, observed `sourceColor`; single-channel binary masks, model scores and prompt checks. SAM2 has no text prompt API. |
| `image.inpaint` | `mask` input or explicit raster `bounds`, optional `protect` input/`protectedRegions`, `radius`, inward `featherPx`, `method:telea\|ns`, `maxRepairFraction`; a separate straight-alpha RGBA patch and the final allowed mask. |
| `artifact.verify` | `output` delivery specification or selected `expected` fields; actual media/image/SRT metadata and assertion outcomes. Explicit `decode:true` or `verifyMode:full_decode` additionally decodes video. Empty checks cannot report verified delivery. |

Image inputs must be orientation-applied RGB8 snapshots. Segmentation uses opaque sRGB proxies and checks the actual capture's `sourceColor` metadata. Inpainting supports opaque RGB8 sources and small defects, with a default repair-area limit of 2% (explicitly configurable up to 20%). Translucent or high-bit sources are rejected; capture an explicitly permitted proxy or use the native provider. The patch preserves embedded ICC data. When a raw host snapshot lacks embedded ICC but its observed `sourceColor` is sRGB, Pillow LittleCMS embeds the standard sRGB profile in the patch; an unknown color interpretation is rejected. Patch alpha is zero outside allowed repair coverage and the source is never overwritten. `sourceRegion` describes the actual document region represented by the whole raster; point/box/bounds values are **raster** coordinates. The caller maps pixel centers with `left + (x + 0.5) * regionWidth / rasterWidth - 0.5` and must recheck source state before applying the patch.

Provider references: [FFmpeg filters](https://ffmpeg.org/ffmpeg-filters.html), [ffprobe](https://ffmpeg.org/ffprobe.html), [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [SAM2](https://github.com/facebookresearch/sam2), [OpenCV inpaint](https://docs.opencv.org/4.x/d7/d8b/group__photo__inpaint.html). Device/model behavior is unqualified until exercised on the intended installation.
