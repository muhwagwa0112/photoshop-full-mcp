import type { Rect, VisualEvidenceReceipt } from './contracts.js';
import { requireCondition } from './errors.js';
export function sourcePoint(evidence: VisualEvidenceReceipt, x: number, y: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = evidence.evidenceToSource; return { x: a * x + c * y + e, y: b * x + d * y + f };
}
export function rasterPoint(evidence: VisualEvidenceReceipt, x: number, y: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = evidence.evidenceToSource; const det = a * d - b * c;
  requireCondition(Number.isFinite(det) && Math.abs(det) > 1e-12, 'RASTER_TRANSFORM_INVALID', 'Source raster affine transform is singular.');
  return { x: (d * (x - e) - c * (y - f)) / det, y: (-b * (x - e) + a * (y - f)) / det };
}
/** SAM point prompts are pixel-center indices; affine bounds are pixel edges. */
export function mapPixelCenter(from: VisualEvidenceReceipt, to: VisualEvidenceReceipt, x: number, y: number): { x: number; y: number } {
  const source = sourcePoint(from, x + 0.5, y + 0.5); const target = rasterPoint(to, source.x, source.y);
  return { x: target.x - 0.5, y: target.y - 0.5 };
}
export function transformRect(rect: Rect, transform: (x: number, y: number) => { x: number; y: number }): Rect {
  const corners = [transform(rect.x, rect.y), transform(rect.x + rect.width, rect.y), transform(rect.x, rect.y + rect.height), transform(rect.x + rect.width, rect.y + rect.height)];
  const left = Math.min(...corners.map(point => point.x)); const top = Math.min(...corners.map(point => point.y));
  return { x: left, y: top, width: Math.max(...corners.map(point => point.x)) - left, height: Math.max(...corners.map(point => point.y)) - top };
}
export interface SourcePlacement { sourceWidth: number; sourceHeight: number; sourceAssetId: string; sourceSha256: string; sourceToDocument: [number, number, number, number, number, number]; visibleBounds: Rect }
export function photoRectToDocument(rect: Rect, placement: SourcePlacement): { exact: Rect; pixels: Rect } {
  requireCondition([rect.x, rect.y, rect.width, rect.height, placement.sourceWidth, placement.sourceHeight, ...placement.sourceToDocument].every(Number.isFinite) && rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= placement.sourceWidth && rect.y + rect.height <= placement.sourceHeight, 'PHOTO_REGION_OUT_OF_SOURCE', 'Retouch coordinates must lie in the observed original photo raster.');
  const [a, b, c, d, e, f] = placement.sourceToDocument;
  requireCondition(a > 0 && d > 0 && b === 0 && c === 0, 'PHOTO_AFFINE_UNSUPPORTED', 'Rectangular retouch requires the observed forward axis-aligned placement transform.');
  const exact = transformRect(rect, (x, y) => ({ x: a * x + e, y: d * y + f })); const bounds = placement.visibleBounds;
  requireCondition(exact.x >= bounds.x && exact.y >= bounds.y && exact.x + exact.width <= bounds.x + bounds.width && exact.y + exact.height <= bounds.y + bounds.height, 'PHOTO_REGION_CROPPED', 'The original-photo retouch region is not fully visible after placement/crop.');
  const x = Math.floor(exact.x), y = Math.floor(exact.y); const pixels = { x, y, width: Math.ceil(exact.x + exact.width) - x, height: Math.ceil(exact.y + exact.height) - y };
  return { exact, pixels };
}
