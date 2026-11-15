import { deflateSync } from "node:zlib";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}
/** Lossless preview encoding without changing straight-alpha pixel values. */
export function encodePng(pixels: Buffer, width: number, height: number, components: number): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 300000 || height > 300000 || ![1, 2, 3, 4].includes(components) || width * height * components > 32 * 1024 * 1024) throw new Error("Invalid or over-budget PNG pixel metadata");
  const stride = width * components;
  if (pixels.length !== stride * height) throw new Error("PNG pixel buffer size does not match dimensions");
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8;
  header[9] = ({ 1: 0, 2: 4, 3: 2, 4: 6 } as Record<number, number>)[components]!;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), ...([3, 4].includes(components) ? [chunk("sRGB", Buffer.from([0]))] : []), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
