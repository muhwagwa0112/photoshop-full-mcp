#!/usr/bin/env python3
"""One pinned local job per process, with an independent stdin cancellation lane."""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys
import threading
from typing import Any

from common import Context, WorkerError, canonical, digest_file

OPERATIONS = {"media.inspect", "media.frames", "media.conform", "media.transcribe", "audio.analyze", "audio.render", "audio.sync", "image.segment", "image.inpaint", "artifact.verify"}


def emit(result: dict, maximum: int) -> None:
    payload = canonical(result)
    if len(payload) > maximum:
        result = {"workerRequestId": result["workerRequestId"], "operation": result["operation"], "ok": False, "data": {}, "artifacts": [], "error": {"code": "RESULT_TOO_LARGE", "message": "Structured result exceeds configured output limit; use its persisted receipt", "retrySafe": False}}
        payload = canonical(result)
    sys.stdout.buffer.write(payload + b"\n")
    sys.stdout.buffer.flush()


def execute(request: dict, profile: dict, roots: list[str], cancellation: threading.Event) -> dict:
    result: dict = {"workerRequestId": request.get("workerRequestId", "invalid"), "operation": request.get("operation", "invalid"), "ok": False, "data": {}, "artifacts": []}
    context: Context | None = None
    receipt: Path | None = None
    claim: Path | None = None
    owns_claim = False
    try:
        if request.get("operation") not in OPERATIONS or not isinstance(request.get("options"), dict) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", request.get("workerRequestId", "")):
            raise WorkerError("INVALID_REQUEST", "Invalid worker identity, operation, or options", True)
        if profile.get("pythonSha256") and digest_file(Path(sys.executable).resolve()) != profile["pythonSha256"]:
            raise WorkerError("PROVIDER_CHANGED", "Python executable hash differs from the installed profile", True)
        for package, version in profile.get("packages", {}).items():
            try:
                actual = importlib.metadata.version(package)
            except importlib.metadata.PackageNotFoundError:
                raise WorkerError("WORKER_REQUIRES_SETUP", f"Pinned package {package} is missing", True) from None
            if actual != version:
                raise WorkerError("PROVIDER_CHANGED", f"Pinned package {package} changed from {version} to {actual}", True)
        context = Context(request, profile, roots, cancellation)
        # Filesystem-safe names are derived from the whole ID, not an attacker-controlled filename.
        identity = hashlib.sha256(request["workerRequestId"].encode()).hexdigest()
        receipt = context.output / f".receipt-{identity}.json"
        claim = context.output / f".claim-{identity}.json"
        request_digest = hashlib.sha256(canonical(request)).hexdigest()
        if receipt.exists():
            old = json.loads(receipt.read_bytes())
            if old["requestDigest"] != request_digest:
                raise WorkerError("IDEMPOTENCY_CONFLICT", "Worker ID was previously accepted with different arguments", True)
            return old["result"]
        try:
            with claim.open("x", encoding="utf-8") as target:
                json.dump({"requestDigest": request_digest, "workerRequestId": request["workerRequestId"]}, target)
                target.flush()
                os.fsync(target.fileno())
            owns_claim = True
        except FileExistsError:
            old = json.loads(claim.read_bytes())
            code = "IDEMPOTENCY_CONFLICT" if old["requestDigest"] != request_digest else "WORKER_OUTCOME_UNKNOWN"
            raise WorkerError(code, "Existing dispatched worker claim has no receipt; reconcile instead of replaying")
        if request["operation"].startswith("image."):
            from image_ops import dispatch
        else:
            from media_ops import dispatch
        # Third-party progress output must never corrupt the one-line JSON protocol.
        with redirect_stdout(sys.stderr):
            data = dispatch(context)
        context.check()
        result.update(ok=True, data=data, artifacts=context.artifacts)
    except WorkerError as error:
        result["error"] = {"code": error.code, "message": str(error), "retrySafe": error.retry_safe}
        if error.code in ("CANCELLED", "DEADLINE_EXCEEDED"):
            result["cancelled"] = True
    except (OSError, ValueError, KeyError, TypeError, ImportError) as error:
        result["error"] = {"code": "WORKER_FAILED", "message": f"{type(error).__name__}: {error}", "retrySafe": False}
    except Exception as error:
        result["error"] = {"code": "PROVIDER_EXCEPTION", "message": f"{type(error).__name__}: {error}", "retrySafe": False}
    finally:
        if context:
            context.cleanup(not result["ok"])
    # Keep the durable claim forever; a missing result is UNKNOWN, never an invitation to replay.
    if owns_claim and receipt is not None and claim is not None and not receipt.exists():
        try:
            claimed = json.loads(claim.read_bytes())
            if claimed.get("requestDigest") == hashlib.sha256(canonical(request)).hexdigest():
                temporary = receipt.with_suffix(".tmp")
                with temporary.open("xb") as target:
                    target.write(canonical({"requestDigest": claimed["requestDigest"], "result": result}))
                    target.flush()
                    os.fsync(target.fileno())
                os.replace(temporary, receipt)
        except OSError:
            # The parent must not publish success when the durable worker receipt could not be saved.
            result.update(ok=False, data={}, artifacts=[], error={"code": "RECEIPT_PERSIST_FAILED", "message": "Worker outcome could not be durably recorded", "retrySafe": False})
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--roots-json", required=True)
    parser.add_argument("--profile")
    args = parser.parse_args()
    roots = json.loads(args.roots_json)
    profile: dict[str, Any] = json.loads(Path(args.profile).read_bytes()) if args.profile else {}
    line = sys.stdin.buffer.readline(8 * 1024 * 1024 + 1)
    if len(line) > 8 * 1024 * 1024 or not line.endswith(b"\n"):
        raise ValueError("Worker request exceeds limit or has no newline")
    request = json.loads(line)
    cancellation = threading.Event()

    def control() -> None:
        while True:
            incoming = sys.stdin.buffer.readline(8193)
            if not incoming:
                cancellation.set()  # An abandoned owner must not leave child renders running.
                return
            if len(incoming) > 8192:
                cancellation.set()
                return
            try:
                message = json.loads(incoming)
                if message.get("kind") == "cancel" and message.get("workerRequestId") == request.get("workerRequestId"):
                    cancellation.set()
            except (ValueError, AttributeError):
                cancellation.set()

    threading.Thread(target=control, daemon=True).start()
    result = execute(request, profile, roots, cancellation)
    emit(result, int(request.get("limits", {}).get("maxOutputBytes", 1048576)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
