import { open } from "node:fs/promises";
import { AutomationError, requireCondition } from "./automation/errors.js";

export interface PhotoshopFileMetadata {
  format: "png" | "jpg" | "psd" | "psb";
  width: number;
  height: number;
  bitDepth: number;
  alpha: "none" | "straight";
  embeddedIcc: boolean;
  storedLayerRecords?: number;
}

/** Bounded header/section reads, not a claim that all pixels were decoded.
 * PSD/PSB layout: https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/
 */
export async function readPhotoshopFileMetadata(file: string): Promise<PhotoshopFileMetadata> {
  const handle = await open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const read = async (at: number, length: number): Promise<Buffer> => {
      requireCondition(Number.isSafeInteger(at) && at >= 0 && length >= 0 && length <= 1_048_576 && at + length <= size, "INVALID_EXPORT_HEADER", "Export contains an invalid or truncated section.");
      const bytes = Buffer.alloc(length); const result = await handle.read(bytes, 0, length, at);
      requireCondition(result.bytesRead === length, "INVALID_EXPORT_HEADER", "Export header is truncated."); return bytes;
    };
    const header = await read(0, Math.min(26, size));
    if (header.length >= 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      const ihdr = await read(8, 25);
      requireCondition(ihdr.toString("ascii", 4, 8) === "IHDR" && ihdr.readUInt32BE(0) === 13, "INVALID_EXPORT_HEADER", "PNG IHDR is missing.");
      const colorType = ihdr[17]; let alpha = colorType === 4 || colorType === 6; let embeddedIcc = false; let offset = 8; let ended = false;
      for (let count = 0; count < 100_000 && offset + 12 <= size; count++) {
        const chunk = await read(offset, 8); const length = chunk.readUInt32BE(0); const kind = chunk.toString("ascii", 4, 8);
        requireCondition(offset + length + 12 <= size, "INVALID_EXPORT_HEADER", "PNG chunk exceeds the file boundary.");
        if (kind === "iCCP") embeddedIcc = length > 3;
        if (kind === "tRNS") alpha = true;
        offset += length + 12;
        if (kind === "IEND") { ended = true; break; }
      }
      requireCondition(ended, "INVALID_EXPORT_HEADER", "PNG IEND is missing.");
      return { format: "png", width: ihdr.readUInt32BE(8), height: ihdr.readUInt32BE(12), bitDepth: ihdr[16]!, alpha: alpha ? "straight" : "none", embeddedIcc };
    }
    if (header.length >= 2 && header[0] === 0xff && header[1] === 0xd8) {
      let offset = 2; let width = 0; let height = 0; let bitDepth = 0; let iccCount = 0; const iccParts = new Set<number>();
      for (let count = 0; count < 100_000 && offset + 4 <= size; count++) {
        let marker = await read(offset, 2);
        requireCondition(marker[0] === 0xff, "INVALID_EXPORT_HEADER", "JPEG segment marker is invalid.");
        while (marker[1] === 0xff) { offset++; marker = await read(offset, 2); }
        const tag = marker[1]!; offset += 2;
        if (tag === 0xda || tag === 0xd9) break;
        if (tag === 0x01 || tag >= 0xd0 && tag <= 0xd7) continue;
        const length = (await read(offset, 2)).readUInt16BE(0); requireCondition(length >= 2 && offset + length <= size, "INVALID_EXPORT_HEADER", "JPEG segment length is invalid.");
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(tag)) {
          const frame = await read(offset + 2, 6); bitDepth = frame[0]!; height = frame.readUInt16BE(1); width = frame.readUInt16BE(3);
        }
        if (tag === 0xe2 && length >= 16) {
          const signature = await read(offset + 2, 14);
          if (signature.toString("ascii", 0, 12) === "ICC_PROFILE\0") { iccParts.add(signature[12]!); iccCount = signature[13]!; }
        }
        offset += length;
      }
      requireCondition(width > 0 && height > 0 && bitDepth > 0, "INVALID_EXPORT_HEADER", "JPEG frame dimensions are missing.");
      return { format: "jpg", width, height, bitDepth, alpha: "none", embeddedIcc: iccCount > 0 && iccParts.size === iccCount && [...iccParts].every(index => index >= 1 && index <= iccCount) };
    }
    if (header.length === 26 && header.toString("ascii", 0, 4) === "8BPS") {
      const version = header.readUInt16BE(4); requireCondition(version === 1 || version === 2, "INVALID_EXPORT_HEADER", "Unsupported Photoshop file version.");
      const lengthBytes = version === 2 ? 8 : 4;
      const sectionLength = async (at: number, length = 4): Promise<number> => {
        const bytes = await read(at, length); const value = length === 8 ? bytes.readBigUInt64BE(0) : BigInt(bytes.readUInt32BE(0));
        requireCondition(value <= BigInt(size), "INVALID_EXPORT_HEADER", "Photoshop section exceeds the file boundary."); return Number(value);
      };
      let offset = 26; const colorLength = await sectionLength(offset); offset += 4 + colorLength;
      const resourceLength = await sectionLength(offset); offset += 4; const resourcesEnd = offset + resourceLength; let embeddedIcc = false;
      requireCondition(resourcesEnd <= size, "INVALID_EXPORT_HEADER", "Photoshop image resources are truncated.");
      for (let count = 0; count < 100_000 && offset < resourcesEnd; count++) {
        const resource = await read(offset, 7); requireCondition(resource.toString("ascii", 0, 4) === "8BIM", "INVALID_EXPORT_HEADER", "Photoshop resource signature is invalid.");
        const id = resource.readUInt16BE(4); const nameBytes = resource[6]! + 1; offset += 6 + nameBytes + nameBytes % 2;
        const length = await sectionLength(offset); offset += 4; if (id === 1039 && length >= 128) embeddedIcc = true;
        offset += length + length % 2; requireCondition(offset <= resourcesEnd, "INVALID_EXPORT_HEADER", "Photoshop resource length is invalid.");
      }
      const layersLength = await sectionLength(resourcesEnd, lengthBytes); let storedLayerRecords: number | undefined;
      if (layersLength >= lengthBytes + 2) {
        const layerInfoAt = resourcesEnd + lengthBytes; const layerInfoLength = await sectionLength(layerInfoAt, lengthBytes);
        if (layerInfoLength >= 2) storedLayerRecords = Math.abs((await read(layerInfoAt + lengthBytes, 2)).readInt16BE(0));
      }
      return { format: version === 1 ? "psd" : "psb", width: header.readUInt32BE(18), height: header.readUInt32BE(14), bitDepth: header.readUInt16BE(22), alpha: "straight", embeddedIcc, ...(storedLayerRecords !== undefined ? { storedLayerRecords } : {}) };
    }
    throw new AutomationError("INVALID_EXPORT_FORMAT", "Export bytes are not a supported Photoshop output format.");
  } finally { await handle.close(); }
}
