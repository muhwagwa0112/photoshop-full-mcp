"""Pinned SAM2 prompts and opaque RGB8 retouch patches; never generative fill."""
from __future__ import annotations

from contextlib import nullcontext
import hashlib
from pathlib import Path
import time

from common import Context, WorkerError, canonical, digest_file, integer, number, pin_model


def libraries():
    try:
        import cv2
        import numpy as np
        from PIL import Image
    except ImportError as error:
        raise WorkerError("WORKER_REQUIRES_SETUP", f"Install the pinned OpenCV/numpy/Pillow environment: {error}", True) from None
    return cv2, np, Image


def rectangle(value: dict, name: str) -> dict:
    if not isinstance(value, dict):
        raise WorkerError("INVALID_REGION", f"{name} must be a rectangle", True)
    left = number(value.get("left", value.get("x")), f"{name}.left", -10**8, 10**8)
    top = number(value.get("top", value.get("y")), f"{name}.top", -10**8, 10**8)
    width = number(value.get("width", value.get("right", left) - left), f"{name}.width", 1, 10**8)
    height = number(value.get("height", value.get("bottom", top) - top), f"{name}.height", 1, 10**8)
    return {"left": left, "top": top, "width": width, "height": height}


def source(context: Context):
    cv2, np, Image = libraries()
    raster = cv2.imdecode(np.fromfile(context.input(), dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if raster is None:
        raise WorkerError("INVALID_RASTER", "Image decoder could not read the source", True)
    height, width = raster.shape[:2]
    maximum = integer(context.profile.get("limits", {}).get("maxImagePixels", 16777216), "maxImagePixels", 1, 268435456)
    if width * height > maximum:
        raise WorkerError("IMAGE_PIXEL_LIMIT", "Source raster exceeds configured pixel limit", True)
    with Image.open(context.input()) as loaded:
        icc = loaded.info.get("icc_profile")
        orientation = loaded.getexif().get(274, 1)
    if orientation != 1:
        raise WorkerError("IMAGE_ORIENTATION_NOT_APPLIED", "Apply orientation before creating the worker source snapshot", True)
    bounds = rectangle(context.options.get("sourceRegion", {"left": 0, "top": 0, "width": width, "height": height}), "sourceRegion")
    region = {"x": bounds["left"], "y": bounds["top"], "width": bounds["width"], "height": bounds["height"]}
    return raster, width, height, region, icc, (cv2, np, Image)


def write_png(context: Context, filename: str, array, Image, icc: bytes | None = None) -> Path:
    target = context.path(filename)
    image = Image.fromarray(array)
    kwargs = {"icc_profile": icc} if icc else {}
    with target.open("xb") as handle:
        image.save(handle, format="PNG", **kwargs)
    return target


def observed_srgb(context: Context) -> bool:
    color = context.options.get("sourceColor", {})
    return isinstance(color, dict) and color.get("bitDepth") == 8 and str(color.get("iccProfile", "")).lower() in ("srgb", "srgb iec61966-2.1")


def segment(context: Context) -> dict:
    raster, width, height, region, _, (cv2, np, Image) = source(context)
    if raster.dtype != np.uint8 or raster.ndim != 3 or raster.shape[2] not in (3, 4):
        raise WorkerError("SEGMENT_REQUIRES_RGB8_PROXY", "SAM2 input must be an explicitly created sRGB RGB8 snapshot", True)
    if raster.shape[2] == 4 and np.any(raster[:, :, 3] != 255):
        raise WorkerError("SEGMENT_REQUIRES_OPAQUE_PROXY", "Composite a segmentation proxy explicitly before SAM2", True)
    if not observed_srgb(context):
        raise WorkerError("SEGMENT_COLOR_UNOBSERVED", "SAM2 requires the actual source snapshot's observed RGB8 sRGB color metadata", True)
    points = context.options.get("points", [])
    box = context.options.get("box")
    if not isinstance(points, list) or len(points) > 128 or (not points and box is None):
        raise WorkerError("INVALID_PROMPT", "SAM2 needs 1..128 point prompts or a box", True)
    coordinates, labels = [], []
    for point in points:
        coordinates.append([number(point.get("x"), "point.x", 0, width - 1), number(point.get("y"), "point.y", 0, height - 1)])
        labels.append(integer(point.get("label"), "point.label", 0, 1))
    box_array = None
    if box is not None:
        bounds = rectangle(box, "box")
        right, bottom = bounds["left"] + bounds["width"], bounds["top"] + bounds["height"]
        if bounds["left"] < 0 or bounds["top"] < 0 or right > width or bottom > height:
            raise WorkerError("INVALID_PROMPT", "Prompt box is outside the source raster", True)
        box_array = np.array([bounds["left"], bounds["top"], right, bottom], dtype=np.float32)
    model = pin_model(context.profile, "sam2")
    if context.options.get("modelId") not in (None, "local-sam2", model.get("id")):
        raise WorkerError("MODEL_MISMATCH", "Requested segmentation model does not match the local profile", True)
    try:
        import sam2
        import torch
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
    except ImportError as error:
        raise WorkerError("WORKER_REQUIRES_SETUP", f"Install the pinned SAM2/PyTorch environment: {error}", True) from None
    config_name, config_hash = model.get("configName"), model.get("configSha256")
    if not isinstance(config_name, str) or not isinstance(config_hash, str):
        raise WorkerError("MODEL_REQUIRES_SETUP", "Pin SAM2 package-relative configName and configSha256", True)
    package = Path(sam2.__file__).resolve().parent
    config = (package / config_name).resolve(strict=True)
    if not config.is_relative_to(package) or digest_file(config) != config_hash:
        raise WorkerError("MODEL_CONFIG_CHANGED", "SAM2 config does not match the pinned installed package", True)
    device = model.get("device", "cpu")
    if device not in ("cpu", "cuda") or (device == "cuda" and not torch.cuda.is_available()):
        raise WorkerError("DEVICE_UNAVAILABLE", "Configured SAM2 device is unavailable", True)
    torch.set_num_threads(context.threads)
    count = integer(context.options.get("candidates", 3), "candidates", 1, 3)
    if count not in (1, 3):
        raise WorkerError("INVALID_ARGUMENT", "SAM2 candidates must be 1 or 3", True)
    started = time.time()
    context.check()
    engine = build_sam2(config_name, model["path"], device=device)
    predictor = SAM2ImagePredictor(engine)
    rgb = cv2.cvtColor(raster[:, :, :3], cv2.COLOR_BGR2RGB)
    with torch.inference_mode():
        predictor.set_image(rgb)
        context.check()
        masks, scores, _ = predictor.predict(point_coords=np.asarray(coordinates, dtype=np.float32) if coordinates else None, point_labels=np.asarray(labels, dtype=np.int32) if labels else None, box=box_array, multimask_output=count == 3)
    context.check()
    candidates = []
    for index, (mask, score) in enumerate(zip(masks, scores)):
        if mask.shape != (height, width):
            raise WorkerError("MASK_DIMENSION_MISMATCH", "SAM2 returned a mask with unexpected dimensions")
        binary = np.asarray(mask > 0, dtype=np.uint8) * 255
        prompts_pass = all(bool(binary[min(height - 1, int(y + 0.5)), min(width - 1, int(x + 0.5))]) == bool(label) for (x, y), label in zip(coordinates, labels))
        target = write_png(context, f"mask-{index}.png", binary, Image)
        metadata = {"sourceRasterSha256": context.input_hashes["source"], "sourceRegion": region, "width": width, "height": height, "channels": 1, "sample": "uint8", "meaning": "selected", "representation": "binary", "alpha": "none", "colorEncoding": "linear-mask", "modelScore": float(score), "pointPromptsSatisfied": prompts_pass}
        artifact = context.artifact(target, "segmentation_mask", "image/png", metadata)
        candidates.append({"artifactIndex": artifact, "score": float(score), "pointPromptsSatisfied": prompts_pass})
    return {"masks": candidates, "sourceRasterSha256": context.input_hashes["source"], "sourceRegion": region, "width": width, "height": height, "provider": {"providerId": "local-sam2", "implementationRevision": "1", "modelId": model.get("id", "sam2"), "modelSha256": model["sha256"], "configSha256": config_hash, "device": device, "startedAtUnix": started, "endedAtUnix": time.time()}}


def raster_rect(value: dict, width: int, height: int) -> tuple[int, int, int, int]:
    rect = rectangle(value, "repair region")
    left, top = integer(rect["left"], "left", 0, width - 1), integer(rect["top"], "top", 0, height - 1)
    right = integer(rect["left"] + rect["width"], "right", left + 1, width)
    bottom = integer(rect["top"] + rect["height"], "bottom", top + 1, height)
    return left, top, right, bottom


def inpaint(context: Context) -> dict:
    raster, width, height, region, icc, (cv2, np, Image) = source(context)
    if raster.dtype != np.uint8 or raster.ndim != 3 or raster.shape[2] not in (3, 4):
        raise WorkerError("INPAINT_UNSUPPORTED_PRECISION", "Initial inpaint provider requires an explicit RGB8 snapshot", True)
    if raster.shape[2] == 4 and np.any(raster[:, :, 3] != 255):
        raise WorkerError("INPAINT_UNSUPPORTED_ALPHA", "Initial inpaint provider supports only opaque source pixels", True)
    if not icc:
        if not observed_srgb(context):
            raise WorkerError("INPAINT_COLOR_PROFILE_UNAVAILABLE", "A patch needs the source's embedded ICC profile or observed sRGB snapshot metadata", True)
        try:
            from PIL import ImageCms
            icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        except (ImportError, OSError) as error:
            raise WorkerError("WORKER_REQUIRES_SETUP", f"Pillow LittleCMS is required to embed the observed sRGB snapshot profile: {error}", True) from None
    if "mask" in context.inputs:
        repair = cv2.imdecode(np.fromfile(context.input("mask"), dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        if repair is None or repair.dtype != np.uint8 or repair.ndim != 2 or repair.shape != (height, width):
            raise WorkerError("MASK_FORMAT_MISMATCH", "Repair mask must be a matching 8-bit single-channel raster", True)
    else:
        bounds = context.options.get("bounds")
        if bounds is None:
            raise WorkerError("MISSING_REPAIR_MASK", "Provide a repair mask or explicit raster-coordinate bounds", True)
        left, top, right, bottom = raster_rect(bounds, width, height)
        repair = np.zeros((height, width), dtype=np.uint8)
        repair[top:bottom, left:right] = 255
    if "protect" in context.inputs:
        protected = cv2.imdecode(np.fromfile(context.input("protect"), dtype=np.uint8), cv2.IMREAD_UNCHANGED)
        if protected is None or protected.dtype != np.uint8 or protected.ndim != 2 or protected.shape != repair.shape:
            raise WorkerError("MASK_FORMAT_MISMATCH", "Protected mask must be a matching 8-bit single-channel raster", True)
        # Any protected coverage excludes the entire pixel from edits.
        repair = np.where(protected > 0, 0, repair).astype(np.uint8)
    for protected in context.options.get("protectedRegions", []):
        left, top, right, bottom = raster_rect(protected, width, height)
        repair[top:bottom, left:right] = 0
    feather = number(context.options.get("featherPx", 0), "featherPx", 0, 64)
    if feather > 0:
        # Feather inward only: never expand an allowed edit into a protected/outside pixel.
        softened = cv2.GaussianBlur(repair, (0, 0), sigmaX=feather, sigmaY=feather)
        repair = np.minimum(repair, softened)
    fraction = int(np.count_nonzero(repair)) / (width * height)
    maximum = number(context.options.get("maxRepairFraction", 0.02), "maxRepairFraction", 0.000001, 0.2)
    if fraction == 0 or fraction > maximum:
        raise WorkerError("INPAINT_REGION_LIMIT", f"Repair coverage {fraction:.6f} is empty or exceeds configured small-defect fraction {maximum}", True)
    radius = number(context.options.get("radius", 3), "radius", 0.1, 32)
    method = context.options.get("method", "telea")
    if method not in ("telea", "ns", "navier-stokes"):
        raise WorkerError("INVALID_ARGUMENT", "Inpaint method must be telea or ns", True)
    source_state = context.options.get("sourceStateDigest")
    if source_state is not None and (not isinstance(source_state, str) or len(source_state) != 64):
        raise WorkerError("INVALID_SOURCE_STATE", "sourceStateDigest must be a SHA-256 digest", True)
    context.check()
    cv2.setNumThreads(context.threads)
    repaired_bgr = cv2.inpaint(np.ascontiguousarray(raster[:, :, :3]), np.where(repair > 0, 255, 0).astype(np.uint8), radius, cv2.INPAINT_TELEA if method == "telea" else cv2.INPAINT_NS)
    context.check()
    rgba = np.dstack((cv2.cvtColor(repaired_bgr, cv2.COLOR_BGR2RGB), repair))
    # Outside the allowed repair mask the patch is exactly transparent.
    rgba[repair == 0, :3] = 0
    patch = write_png(context, "retouch-patch.png", rgba, Image, icc)
    mask_path = write_png(context, "repair-mask.png", repair, Image)
    metadata = {"sourceRasterSha256": context.input_hashes["source"], "sourceRegion": region, "width": width, "height": height, "alpha": "straight", "alphaRule": "opaque-source-repair-coverage", "changesSourceAlpha": False, "sourceStateDigest": source_state, "iccProfileSha256": hashlib.sha256(icc).hexdigest() if icc else None, "processing": {"providerId": "opencv-inpaint", "implementationRevision": "1", "method": method, "radiusPx": radius, "featherPx": feather, "parametersDigest": hashlib.sha256(canonical(context.options)).hexdigest(), "precisionConversion": context.options.get("precisionConversion", "none"), "repairFraction": fraction}}
    mask_index = context.artifact(mask_path, "repair_mask", "image/png", {"sourceRasterSha256": context.input_hashes["source"], "sourceRegion": region, "width": width, "height": height, "channels": 1, "meaning": "repair", "representation": "coverage", "colorEncoding": "linear-mask"})
    patch_index = context.artifact(patch, "retouch_patch", "image/png", metadata)
    return {"artifactIndex": patch_index, "maskArtifactIndex": mask_index, **metadata}


def dispatch(context: Context) -> dict:
    return {"image.segment": segment, "image.inpaint": inpaint}[context.request["operation"]](context)
