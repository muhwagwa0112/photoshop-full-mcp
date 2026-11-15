#!/usr/bin/env python3
"""Record installed executables/models. Never install or download dependencies."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys

from common import canonical, digest_file


def model_record(path: str, model_id: str) -> dict:
    actual = Path(path).resolve(strict=True)
    if actual.is_dir():
        manifest = [[p.relative_to(actual).as_posix(), digest_file(p)] for p in sorted(actual.rglob("*")) if p.is_file()]
        sha = hashlib.sha256(canonical(manifest)).hexdigest()
    else:
        sha = digest_file(actual)
    return {"id": model_id, "path": str(actual), "sha256": sha, "device": "cpu"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="New local profile path (existing files are never replaced)")
    parser.add_argument("--ffmpeg")
    parser.add_argument("--ffprobe")
    parser.add_argument("--whisper-model", help="Preinstalled faster-whisper model directory")
    parser.add_argument("--sam2-checkpoint", help="Preinstalled SAM2 checkpoint file")
    parser.add_argument("--sam2-config", help="SAM2 package-relative config name matching the checkpoint")
    parser.add_argument("--profile-id", default="local-worker")
    args = parser.parse_args()
    python = Path(sys.executable).resolve(strict=True)
    profile = {"schemaVersion": 1, "profileId": args.profile_id, "qualification": "not_run", "pythonExecutable": str(python), "pythonSha256": digest_file(python), "pythonVersion": platform.python_version(), "os": platform.platform(), "architecture": platform.machine(), "executables": {}, "models": {}, "packages": {}, "limits": {"maxImagePixels": 16777216}, "maxParallelJobs": 2}
    for name in ("ffmpeg", "ffprobe"):
        configured = getattr(args, name) or shutil.which(name)
        if configured:
            executable = Path(configured).resolve(strict=True)
            result = subprocess.run([str(executable), "-version"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=True, text=True, shell=False)
            profile["executables"][name] = {"path": str(executable), "sha256": digest_file(executable), "version": result.stdout.splitlines()[0], "buildConfiguration": next((line for line in result.stdout.splitlines() if line.startswith("configuration:")), "")}
    for name in ("numpy", "opencv-python-headless", "opencv-python", "Pillow", "faster-whisper", "ctranslate2", "torch", "torchvision", "SAM-2", "sam2", "hydra-core"):
        try:
            profile["packages"][name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            pass
    if args.whisper_model:
        profile["models"]["whisper"] = {**model_record(args.whisper_model, "local-whisper"), "computeType": "int8"}
    if args.sam2_checkpoint:
        if not args.sam2_config:
            parser.error("--sam2-config is required with --sam2-checkpoint")
        import sam2
        package = Path(sam2.__file__).resolve().parent
        config = (package / args.sam2_config).resolve(strict=True)
        if not config.is_relative_to(package):
            parser.error("SAM2 config must belong to the installed sam2 package")
        profile["models"]["sam2"] = {**model_record(args.sam2_checkpoint, "local-sam2"), "configName": args.sam2_config, "configSha256": digest_file(config)}
    destination = Path(args.output).expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("xb") as target:
        target.write(json.dumps(profile, ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
        target.flush()
        os.fsync(target.fileno())
    print(str(destination))


if __name__ == "__main__":
    main()
