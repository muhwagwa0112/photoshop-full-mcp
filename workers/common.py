"""Local worker primitives. No network, shell commands, or source-file mutations."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
from fractions import Fraction
from typing import Any

TICKS_PER_SECOND = 254016000000


class WorkerError(Exception):
    def __init__(self, code: str, message: str, retry_safe: bool = False):
        super().__init__(message)
        self.code, self.retry_safe = code, retry_safe


def digest_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def seconds_to_ticks(value: str | float | int | Fraction) -> str:
    fraction = value if isinstance(value, Fraction) else Fraction(str(value))
    ticks = fraction * TICKS_PER_SECOND
    # Round nearest, with ties away from zero; never convert timeline ticks to float.
    rounded = (abs(ticks.numerator) * 2 + ticks.denominator) // (2 * ticks.denominator)
    return str(rounded if ticks >= 0 else -rounded)


def ticks_to_seconds(value: str) -> str:
    if not isinstance(value, str) or not value.lstrip("-").isdigit():
        raise WorkerError("INVALID_TIME", "Time must be an integer tick string", True)
    ticks = int(value)
    sign = "-" if ticks < 0 else ""
    ticks = abs(ticks)
    whole, rest = divmod(ticks, TICKS_PER_SECOND)
    decimals = (rest * 10**12) // TICKS_PER_SECOND
    return f"{sign}{whole}.{decimals:012d}"


def number(value: Any, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise WorkerError("INVALID_ARGUMENT", f"{name} must be finite and in [{minimum}, {maximum}]", True)
    return float(value)


def integer(value: Any, name: str, minimum: int, maximum: int) -> int:
    result = number(value, name, minimum, maximum)
    if not result.is_integer():
        raise WorkerError("INVALID_ARGUMENT", f"{name} must be an integer", True)
    return int(result)


def inside(root: Path, path: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


class Context:
    def __init__(self, request: dict, profile: dict, roots: list[str], cancel: threading.Event):
        self.request, self.options, self.profile = request, request.get("options", {}), profile
        self.cancel = cancel
        self.started = time.monotonic()
        self.deadline = self.started + integer(request["limits"]["timeoutMs"], "timeoutMs", 1, 86400000) / 1000
        self.max_bytes = int(request["limits"]["maxTemporaryBytes"])
        if self.max_bytes < 1:
            raise WorkerError("INVALID_QUOTA", "Temporary quota must be positive", True)
        self.threads = integer(request["limits"]["maxCpuThreads"], "maxCpuThreads", 1, 256)
        self.roots = [Path(root).resolve(strict=True) for root in roots]
        self.output = Path(request["outputDirectory"]).resolve(strict=True)
        if not self.output.is_dir() or not any(inside(root, self.output) for root in self.roots):
            raise WorkerError("ROOT_DENIED", "Output directory is outside configured roots", True)
        self.inputs: dict[str, Path] = {}
        self.input_hashes: dict[str, str] = {}
        for key, asset in request.get("inputs", {}).items():
            path = Path(asset["path"]).resolve(strict=True)
            if not path.is_file() or not any(inside(root, path) for root in self.roots):
                raise WorkerError("ROOT_DENIED", f"Input {key} is outside configured roots", True)
            sha = digest_file(path)
            if asset.get("sha256") and sha != asset["sha256"]:
                raise WorkerError("INPUT_CHANGED", f"Input {key} does not match its pinned hash", True)
            self.inputs[key], self.input_hashes[key] = path, sha
        self.artifacts: list[dict] = []
        self.temporary: list[Path] = []
        self.created: list[Path] = []
        self.process: subprocess.Popen | None = None
        self._process_lock = threading.Lock()
        self._executables: dict[str, str] = {}

    def check(self) -> None:
        if self.cancel.is_set():
            raise WorkerError("CANCELLED", "Worker cancelled")
        if time.monotonic() >= self.deadline:
            raise WorkerError("DEADLINE_EXCEEDED", "Worker execution deadline exceeded")

    def input(self, key: str = "source") -> Path:
        try:
            return self.inputs[key]
        except KeyError:
            raise WorkerError("MISSING_INPUT", f"Input {key} is required", True) from None

    def path(self, filename: str, temporary: bool = False) -> Path:
        if Path(filename).name != filename or filename in (".", ".."):
            raise WorkerError("INVALID_OUTPUT", "Output filename must be local", True)
        path = self.output / filename
        if path.exists() or path.is_symlink():
            raise WorkerError("OUTPUT_CONFLICT", f"Worker output already exists: {filename}")
        self.created.append(path)
        if temporary:
            self.temporary.append(path)
        return path

    def check_quota(self) -> None:
        size = 0
        for path in self.output.rglob("*"):
            if path.is_symlink():
                raise WorkerError("OUTPUT_LINK", "Links are not allowed in worker output")
            if path.is_file():
                size += path.stat().st_size
                if size > self.max_bytes:
                    raise WorkerError("TEMPORARY_QUOTA_EXCEEDED", "Worker temporary storage quota exceeded")

    def executable(self, key: str) -> str:
        if key not in self._executables:
            record = self.profile.get("executables", {}).get(key)
            if not isinstance(record, dict) or not record.get("path") or not record.get("sha256"):
                raise WorkerError("WORKER_REQUIRES_SETUP", f"Pin local {key} path and SHA-256 in worker profile", True)
            path = Path(record["path"]).resolve(strict=True)
            if digest_file(path) != record["sha256"]:
                raise WorkerError("PROVIDER_CHANGED", f"{key} executable hash differs from profile", True)
            self._executables[key] = str(path)
        return self._executables[key]

    def stop_process(self) -> None:
        with self._process_lock:
            process = self.process
            if not process or process.poll() is not None:
                return
            try:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGTERM)
                else:
                    process.terminate()
            except ProcessLookupError:
                return
            try:
                process.wait(timeout=1.5)
            except subprocess.TimeoutExpired:
                if os.name == "posix":
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    process.kill()
                process.wait(timeout=1.5)

    def run(self, executable: str, args: list[str], *, stdout_limit: int = 16 * 1024 * 1024) -> tuple[str, str]:
        self.check()
        index = len(self.temporary)
        out = self.path(f"process-{index}.stdout", temporary=True)
        err = self.path(f"process-{index}.stderr", temporary=True)
        try:
            with out.open("xb") as output, err.open("xb") as errors:
                command = [self.executable(executable), *args]
                kwargs: dict = {"stdin": subprocess.DEVNULL, "stdout": output, "stderr": errors, "shell": False, "cwd": str(self.output)}
                if os.name == "posix":
                    kwargs["start_new_session"] = True
                elif os.name == "nt":
                    kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
                with self._process_lock:
                    self.process = subprocess.Popen(command, **kwargs)
                while self.process.poll() is None:
                    self.check()
                    if out.stat().st_size > stdout_limit or err.stat().st_size > 8 * 1024 * 1024:
                        raise WorkerError("PROVIDER_OUTPUT_LIMIT", "Provider output exceeded bounded capture")
                    self.check_quota()
                    self.cancel.wait(0.05)
                return_code = self.process.returncode
            stdout, stderr = out.read_text(errors="replace"), err.read_text(errors="replace")
            if len(stdout.encode()) > stdout_limit or len(stderr.encode()) > 8 * 1024 * 1024:
                raise WorkerError("PROVIDER_OUTPUT_LIMIT", "Provider output exceeded bounded capture")
            if return_code:
                raise WorkerError("PROVIDER_FAILED", f"{executable} exited {return_code}: {stderr[-4000:]}")
            self.check()
            self.check_quota()
            return stdout, stderr
        finally:
            self.stop_process()
            with self._process_lock:
                self.process = None
            for path in (out, err):
                path.unlink(missing_ok=True)

    def artifact(self, path: Path, kind: str, mime: str, metadata: dict | None = None) -> int:
        self.check()
        actual = path.resolve(strict=True)
        if not inside(self.output, actual) or path.is_symlink() or not actual.is_file():
            raise WorkerError("INVALID_ARTIFACT", "Artifact must be an ordinary job-owned file")
        self.check_quota()
        result: dict = {"path": str(actual), "sha256": digest_file(actual), "sizeBytes": str(actual.stat().st_size), "kind": kind, "mimeType": mime}
        if metadata is not None:
            result["metadata"] = metadata
        self.artifacts.append(result)
        return len(self.artifacts) - 1

    def json_artifact(self, filename: str, value: Any, kind: str) -> int:
        path = self.path(filename)
        with path.open("xb") as target:
            target.write(canonical(value))
            target.flush()
            os.fsync(target.fileno())
        return self.artifact(path, kind, "application/json")

    def cleanup(self, failed: bool) -> None:
        self.stop_process()
        for path in self.temporary:
            path.unlink(missing_ok=True)
        if failed:
            # Only files created by this attempt are removed; never source inputs.
            for path in self.created:
                if path.is_file() or path.is_symlink():
                    path.unlink(missing_ok=True)


def pin_model(profile: dict, key: str) -> dict:
    record = profile.get("models", {}).get(key)
    if not isinstance(record, dict):
        raise WorkerError("MODEL_REQUIRES_SETUP", f"Configure a local pinned {key} model", True)
    for name in ("path", "sha256"):
        if not isinstance(record.get(name), str) or not record[name]:
            raise WorkerError("MODEL_REQUIRES_SETUP", f"{key}.{name} is required", True)
    path = Path(record["path"]).resolve(strict=True)
    if path.is_dir():
        manifest = [[p.relative_to(path).as_posix(), digest_file(p)] for p in sorted(path.rglob("*")) if p.is_file()]
        sha = hashlib.sha256(canonical(manifest)).hexdigest()
    else:
        sha = digest_file(path)
    if sha != record["sha256"]:
        raise WorkerError("MODEL_CHANGED", f"{key} model hash differs from its profile", True)
    return {**record, "path": str(path)}
