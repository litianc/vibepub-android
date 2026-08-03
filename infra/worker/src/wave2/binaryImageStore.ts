import { sha256 } from "./artifactContracts";
import { visualBinaryKey } from "./visualContracts";

export type BinaryImageBucket = Pick<R2Bucket, "get" | "head" | "put">;
export type BinaryImageMetadata = {
  storage_ref: string;
  byte_hash: string;
  byte_length: number;
  mime: "image/png";
  width: number;
  height: number;
  user_id: string;
  workspace_id: string;
  run_id: string;
  frozen_payload_hash: string;
  slot_id: string;
};

export type BinaryImageRead = { bytes: Uint8Array; metadata: BinaryImageMetadata };
export type BinaryImageScope = Pick<BinaryImageMetadata, "user_id" | "workspace_id" | "run_id" | "frozen_payload_hash" | "slot_id">;

export class BinaryImageStoreError extends Error {
  constructor(public readonly code: "binary_conflict" | "binary_reconciliation_required" | "binary_readback_mismatch" | "binary_owner_conflict" | "binary_key_invalid", message: string, public readonly status = 409) {
    super(message);
    this.name = "BinaryImageStoreError";
  }
}

export class ImageTransformationServiceError extends Error {
  constructor(
    public readonly code: "image_transformation_quota_exceeded" | "image_transformation_service_unavailable",
    message: string,
    public readonly retryable: boolean,
    public readonly providerCode?: number,
  ) {
    super(message);
    this.name = "ImageTransformationServiceError";
  }
}

function imageTransformationServiceError(error: unknown): ImageTransformationServiceError {
  const value = error && typeof error === "object" ? error as { code?: unknown } : null;
  const providerCode = typeof value?.code === "number" && Number.isSafeInteger(value.code) ? value.code : undefined;
  return providerCode === 9422
    ? new ImageTransformationServiceError("image_transformation_quota_exceeded", "Cloudflare Images transformation quota is exhausted", false, providerCode)
    : new ImageTransformationServiceError("image_transformation_service_unavailable", "Cloudflare Images transformation is unavailable", true, providerCode);
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
export const MAX_PROVIDER_PNG_BYTES = 8 * 1024 * 1024;
export const MAX_PROVIDER_BASE64_CHARS = Math.ceil(MAX_PROVIDER_PNG_BYTES / 3) * 4;
const MAX_PROVIDER_PIXEL_COUNT = 3_000_000;
const MAX_NORMALIZED_PNG_BYTES = 8 * 1024 * 1024;
const FIXED_PROVIDER_CANVAS = { width: 1536, height: 1024 } as const;
type PngNormalizationOptions = {
  backgroundRgb?: readonly [number, number, number];
  padding?: "solid" | "edge";
};

type PngInfo = { width: number; height: number; bitDepth: number; colorType: number; interlace: number; idat: Uint8Array[] };
type PngHeader = Omit<PngInfo, "idat">;

function readPngHeader(bytes: Uint8Array): PngHeader {
  if (bytes.byteLength < 33 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) throw new BinaryImageStoreError("binary_readback_mismatch", "image is not a PNG", 422);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const isHeader = view.getUint32(8) === 13 && bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82;
  if (!isHeader) throw new BinaryImageStoreError("binary_readback_mismatch", "PNG IHDR is invalid", 422);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const compression = bytes[26];
  const filter = bytes[27];
  const interlace = bytes[28];
  if (!width || !height || compression !== 0 || filter !== 0) throw new BinaryImageStoreError("binary_readback_mismatch", "PNG dimensions or encoding are invalid", 422);
  return { width, height, bitDepth, colorType, interlace };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readPng(bytes: Uint8Array): PngInfo {
  if (bytes.byteLength < 33 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) throw new BinaryImageStoreError("binary_readback_mismatch", "image is not a PNG", 422);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let header: PngInfo | null = null;
  const idat: Uint8Array[] = [];
  while (offset + 12 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const typeBytes = bytes.slice(offset + 4, offset + 8);
    const type = String.fromCharCode(...typeBytes);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    if (dataEnd + 4 > bytes.byteLength) throw new BinaryImageStoreError("binary_readback_mismatch", "PNG chunk is truncated", 422);
    const expectedCrc = view.getUint32(crcOffset);
    const actualCrc = crc32(bytes.slice(offset + 4, dataEnd));
    if (actualCrc !== expectedCrc) throw new BinaryImageStoreError("binary_readback_mismatch", "PNG chunk checksum is invalid", 422);
    if (type === "IHDR") {
      if (length !== 13 || header) throw new BinaryImageStoreError("binary_readback_mismatch", "PNG IHDR is invalid", 422);
      const width = view.getUint32(dataStart);
      const height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      const interlace = bytes[dataStart + 12];
      if (!width || !height) throw new BinaryImageStoreError("binary_readback_mismatch", "PNG dimensions are invalid", 422);
      header = { width, height, bitDepth, colorType, interlace, idat };
    } else if (type === "IDAT") {
      idat.push(bytes.slice(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!header) throw new BinaryImageStoreError("binary_readback_mismatch", "PNG IHDR is missing", 422);
  header.idat = idat;
  return header;
}

function readPngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const info = readPngHeader(bytes);
  return { width: info.width, height: info.height };
}

const WHITE_BACKGROUND_BORDER_THRESHOLD = 0.95;
const WHITE_BACKGROUND_MIN_CHANNEL = 248;
const WHITE_BACKGROUND_BORDER_FRACTION = 0.05;
const WHITE_BACKGROUND_MIN_COVERAGE = 0.35;
const OPAQUE_PIXEL_THRESHOLD = 0.98;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

async function inflatePngPixels(info: PngInfo): Promise<{ pixels: Uint8Array; channels: number }> {
  if (info.bitDepth !== 8 || info.interlace !== 0 || ![0, 2, 4, 6].includes(info.colorType) || info.idat.length === 0) {
    throw new BinaryImageStoreError("binary_readback_mismatch", "PNG pixel format is unsupported", 422);
  }
  const compressed = new Uint8Array(info.idat.reduce((total, item) => total + item.byteLength, 0));
  let cursor = 0;
  for (const item of info.idat) { compressed.set(item, cursor); cursor += item.byteLength; }
  const channels = info.colorType === 0 ? 1 : info.colorType === 2 ? 3 : info.colorType === 4 ? 2 : 4;
  const rowBytes = info.width * channels;
  const expectedLength = info.height * (rowBytes + 1);
  if (!Number.isSafeInteger(expectedLength) || expectedLength > MAX_PROVIDER_PIXEL_COUNT * 4 + info.height) {
    throw new BinaryImageStoreError("binary_readback_mismatch", "PNG pixel length exceeds the normalization limit", 422);
  }
  const raw = new Uint8Array(expectedLength);
  let rawOffset = 0;
  try {
    const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    try {
      while (true) {
        const current = await reader.read();
        if (current.done) break;
        if (rawOffset + current.value.byteLength > expectedLength) {
          try { await reader.cancel(); } catch { /* reject the oversized stream below */ }
          throw new BinaryImageStoreError("binary_readback_mismatch", "PNG decompressed beyond its declared pixel length", 422);
        }
        raw.set(current.value, rawOffset);
        rawOffset += current.value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (error instanceof BinaryImageStoreError) throw error;
    throw new BinaryImageStoreError("binary_readback_mismatch", "PNG pixels cannot be decompressed", 422);
  }
  if (rawOffset !== expectedLength) throw new BinaryImageStoreError("binary_readback_mismatch", "PNG pixel length is invalid", 422);
  const pixels = new Uint8Array(info.height * rowBytes);
  for (let y = 0; y < info.height; y += 1) {
    const filter = raw[y * (rowBytes + 1)];
    if (filter > 4) throw new BinaryImageStoreError("binary_readback_mismatch", "PNG row filter is invalid", 422);
    const sourceStart = y * (rowBytes + 1) + 1;
    const targetStart = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const target = targetStart + x;
      const left = x >= channels ? pixels[target - channels] : 0;
      const up = y > 0 ? pixels[target - rowBytes] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[target - rowBytes - channels] : 0;
      const value = raw[sourceStart + x];
      pixels[target] = filter === 0 ? value : filter === 1 ? (value + left) & 255 : filter === 2 ? (value + up) & 255 : filter === 3 ? (value + Math.floor((left + up) / 2)) & 255 : (value + paeth(left, up, upperLeft)) & 255;
    }
  }
  return { pixels, channels };
}

function pngChunk(type: "IHDR" | "IDAT" | "IEND", data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.byteLength);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(chunk.slice(4, 8 + data.byteLength)));
  return chunk;
}

function joinBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return output;
}

async function encodeRgbaPng(rgba: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const rowBytes = width * 4;
  const filtered = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    const sourceStart = y * rowBytes;
    const targetStart = y * (rowBytes + 1);
    filtered[targetStart] = 1;
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= 4 ? rgba[sourceStart + x - 4] : 0;
      filtered[targetStart + x + 1] = (rgba[sourceStart + x] - left) & 255;
    }
  }
  const compressed = new Uint8Array(await new Response(new Blob([filtered]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  return joinBytes([PNG_SIGNATURE, pngChunk("IHDR", header), pngChunk("IDAT", compressed), pngChunk("IEND", new Uint8Array())]);
}

/**
 * The approved provider may apply a pixel cap or return its fixed 3:2 canvas.
 * Fit that canvas inside the requested dimensions and fill the unused area
 * from its approved solid or edge background so text and illustrations are
 * neither stretched nor cropped before the immutable exact-dimension contract
 * is evaluated.
 */
export async function normalizePngToExactDimensions(
  bytes: Uint8Array,
  targetWidth: number,
  targetHeight: number,
  options: PngNormalizationOptions = {},
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(targetWidth) || !Number.isSafeInteger(targetHeight) || targetWidth < 1 || targetHeight < 1 || targetWidth > 2256 || targetHeight > 960) {
    throw new BinaryImageStoreError("binary_readback_mismatch", "target image dimensions are invalid", 422);
  }
  const backgroundRgb = options.backgroundRgb ?? [255, 255, 255];
  const padding = options.padding ?? "solid";
  if (!Array.isArray(backgroundRgb) || backgroundRgb.length !== 3 || backgroundRgb.some(value => !Number.isInteger(value) || value < 0 || value > 255) || (padding !== "solid" && padding !== "edge")) {
    throw new BinaryImageStoreError("binary_readback_mismatch", "image normalization options are invalid", 422);
  }
  if (bytes.byteLength > MAX_PROVIDER_PNG_BYTES) {
    throw new BinaryImageStoreError("binary_readback_mismatch", "provider PNG exceeds the normalization byte limit", 422);
  }
  const info = readPng(bytes);
  const pixelCount = info.width * info.height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_PROVIDER_PIXEL_COUNT) {
    throw new BinaryImageStoreError("binary_readback_mismatch", "provider PNG exceeds the normalization pixel limit", 422);
  }
  if (info.width === targetWidth && info.height === targetHeight && info.colorType !== 4 && info.colorType !== 6) return bytes;
  const sourceRatio = info.width / info.height;
  const targetRatio = targetWidth / targetHeight;
  const ratioDrift = Math.abs(sourceRatio - targetRatio) / targetRatio;
  const widthScale = info.width / targetWidth;
  const heightScale = info.height / targetHeight;
  const isBoundedTargetScale = ratioDrift <= 0.005 && widthScale >= 0.75 && widthScale <= 1.25 && heightScale >= 0.75 && heightScale <= 1.25;
  const isFixedProviderCanvas = info.width === FIXED_PROVIDER_CANVAS.width && info.height === FIXED_PROVIDER_CANVAS.height;
  if (!isBoundedTargetScale && !isFixedProviderCanvas) {
    throw new BinaryImageStoreError("binary_readback_mismatch", "provider image dimensions are outside the bounded normalization contract", 422);
  }
  const { pixels, channels } = await inflatePngPixels(info);
  const sourceRgba = new Uint8Array(info.width * info.height * 4);
  for (let index = 0; index < info.width * info.height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    const gray = pixels[source];
    const red = gray;
    const green = info.colorType === 0 || info.colorType === 4 ? gray : pixels[source + 1];
    const blue = info.colorType === 0 || info.colorType === 4 ? gray : pixels[source + 2];
    const alpha = info.colorType === 4 ? pixels[source + 1] : info.colorType === 6 ? pixels[source + 3] : 255;
    const inverseAlpha = 255 - alpha;
    sourceRgba[target] = Math.round((red * alpha + backgroundRgb[0] * inverseAlpha) / 255);
    sourceRgba[target + 1] = Math.round((green * alpha + backgroundRgb[1] * inverseAlpha) / 255);
    sourceRgba[target + 2] = Math.round((blue * alpha + backgroundRgb[2] * inverseAlpha) / 255);
    sourceRgba[target + 3] = 255;
  }
  const fitScale = Math.min(targetWidth / info.width, targetHeight / info.height);
  const fittedWidth = Math.max(1, Math.min(targetWidth, Math.round(info.width * fitScale)));
  const fittedHeight = Math.max(1, Math.min(targetHeight, Math.round(info.height * fitScale)));
  const offsetX = Math.floor((targetWidth - fittedWidth) / 2);
  const offsetY = Math.floor((targetHeight - fittedHeight) / 2);
  const targetRgba = new Uint8Array(targetWidth * targetHeight * 4);
  for (let target = 0; target < targetRgba.byteLength; target += 4) {
    targetRgba[target] = backgroundRgb[0];
    targetRgba[target + 1] = backgroundRgb[1];
    targetRgba[target + 2] = backgroundRgb[2];
    targetRgba[target + 3] = 255;
  }
  for (let y = 0; y < targetHeight; y += 1) {
    const insideY = y >= offsetY && y < offsetY + fittedHeight;
    if (padding === "solid" && !insideY) continue;
    const fittedY = Math.max(0, Math.min(fittedHeight - 1, y - offsetY));
    const sourceY = Math.max(0, Math.min(info.height - 1, (fittedY + 0.5) * info.height / fittedHeight - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(info.height - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < targetWidth; x += 1) {
      const insideX = x >= offsetX && x < offsetX + fittedWidth;
      if (padding === "solid" && !insideX) continue;
      const fittedX = Math.max(0, Math.min(fittedWidth - 1, x - offsetX));
      const sourceX = Math.max(0, Math.min(info.width - 1, (fittedX + 0.5) * info.width / fittedWidth - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(info.width - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const target = (y * targetWidth + x) * 4;
      const topLeft = (y0 * info.width + x0) * 4;
      const topRight = (y0 * info.width + x1) * 4;
      const bottomLeft = (y1 * info.width + x0) * 4;
      const bottomRight = (y1 * info.width + x1) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const top = sourceRgba[topLeft + channel] * (1 - xWeight) + sourceRgba[topRight + channel] * xWeight;
        const bottom = sourceRgba[bottomLeft + channel] * (1 - xWeight) + sourceRgba[bottomRight + channel] * xWeight;
        targetRgba[target + channel] = Math.round(top * (1 - yWeight) + bottom * yWeight);
      }
    }
  }
  return encodeRgbaPng(targetRgba, targetWidth, targetHeight);
}

async function readBoundedImageStream(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const current = await reader.read();
      if (current.done) break;
      length += current.value.byteLength;
      if (length > maxBytes) {
        try { await reader.cancel(); } catch { /* reject the oversized output below */ }
        throw new BinaryImageStoreError("binary_readback_mismatch", "image transformation output exceeds its byte limit", 422);
      }
      chunks.push(current.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function normalizationGeometryAllowed(info: PngHeader, targetWidth: number, targetHeight: number): boolean {
  const pixelCount = info.width * info.height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_PROVIDER_PIXEL_COUNT) return false;
  const targetRatio = targetWidth / targetHeight;
  const ratioDrift = Math.abs(info.width / info.height - targetRatio) / targetRatio;
  const widthScale = info.width / targetWidth;
  const heightScale = info.height / targetHeight;
  const isBoundedTargetScale = ratioDrift <= 0.005 && widthScale >= 0.75 && widthScale <= 1.25 && heightScale >= 0.75 && heightScale <= 1.25;
  return isBoundedTargetScale || (info.width === FIXED_PROVIDER_CANVAS.width && info.height === FIXED_PROVIDER_CANVAS.height);
}

function colorHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map(value => value.toString(16).padStart(2, "0")).join("")}`;
}

/** Uses Cloudflare Images so large provider PNGs do not consume Worker CPU. */
export async function normalizePngWithImagesBinding(
  images: ImagesBinding,
  bytes: Uint8Array,
  targetWidth: number,
  targetHeight: number,
  options: PngNormalizationOptions = {},
): Promise<Uint8Array> {
  if (!images || typeof images.input !== "function" || !Number.isSafeInteger(targetWidth) || !Number.isSafeInteger(targetHeight) || targetWidth < 1 || targetHeight < 1 || targetWidth > 2256 || targetHeight > 960) {
    throw new BinaryImageStoreError("binary_readback_mismatch", "image transformation binding or target dimensions are invalid", 422);
  }
  const backgroundRgb = options.backgroundRgb ?? [255, 255, 255];
  const padding = options.padding ?? "solid";
  if (!Array.isArray(backgroundRgb) || backgroundRgb.length !== 3 || backgroundRgb.some(value => !Number.isInteger(value) || value < 0 || value > 255) || padding !== "solid") {
    throw new BinaryImageStoreError("binary_readback_mismatch", "image normalization options are invalid", 422);
  }
  if (bytes.byteLength > MAX_PROVIDER_PNG_BYTES) throw new BinaryImageStoreError("binary_readback_mismatch", "provider PNG exceeds the normalization byte limit", 422);
  const info = readPngHeader(bytes);
  if (info.bitDepth !== 8 || info.interlace !== 0 || ![0, 2, 4, 6].includes(info.colorType) || !normalizationGeometryAllowed(info, targetWidth, targetHeight)) {
    throw new BinaryImageStoreError("binary_readback_mismatch", "provider image dimensions or encoding are outside the bounded normalization contract", 422);
  }
  const background = colorHex(backgroundRgb);
  try {
    const transformed = await images.input(new Blob([bytes]).stream())
      .transform({ width: targetWidth, height: targetHeight, fit: "pad", background })
      .output({ format: "image/png", background, anim: false });
    const output = await readBoundedImageStream(transformed.image(), MAX_NORMALIZED_PNG_BYTES);
    const outputInfo = readPngHeader(output);
    if (outputInfo.width !== targetWidth || outputInfo.height !== targetHeight || outputInfo.bitDepth !== 8 || outputInfo.interlace !== 0 || ![0, 2, 4, 6].includes(outputInfo.colorType)) {
      throw new BinaryImageStoreError("binary_readback_mismatch", "image transformation output does not match the exact PNG contract", 422);
    }
    return output;
  } catch (error) {
    if (error instanceof BinaryImageStoreError) throw error;
    throw imageTransformationServiceError(error);
  }
}

async function samplePngPixels(images: ImagesBinding, bytes: Uint8Array, width: number, height: number): Promise<{ width: number; height: number; colorType: number; pixels: Uint8Array; channels: number }> {
  const expectedRgbaLength = width * height * 4;
  try {
    const raw = await images.input(new Blob([bytes]).stream())
      .transform({ width, height, fit: "squeeze" })
      .output({ format: "rgba", anim: false });
    const pixels = await readBoundedImageStream(raw.image(), expectedRgbaLength);
    if (pixels.byteLength !== expectedRgbaLength) throw new BinaryImageStoreError("binary_readback_mismatch", "image QA sample length is invalid", 422);
    return { width, height, colorType: 6, pixels, channels: 4 };
  } catch {
    // Miniflare does not implement raw Images output, so local tests use a
    // tiny PNG fallback. Production uses the raw path to minimize Worker CPU.
    try {
      const transformed = await images.input(new Blob([bytes]).stream())
        .transform({ width, height, fit: "squeeze" })
        .output({ format: "image/png", anim: false });
      const output = await readBoundedImageStream(transformed.image(), 64 * 1024);
      const info = readPng(output);
      if (info.width !== width || info.height !== height) throw new BinaryImageStoreError("binary_readback_mismatch", "image QA sample dimensions are invalid", 422);
      const decoded = await inflatePngPixels(info);
      return { width, height, colorType: info.colorType, ...decoded };
    } catch (error) {
      if (error instanceof BinaryImageStoreError) throw error;
      throw imageTransformationServiceError(error);
    }
  }
}

export async function verifyPngOpaqueCoverageWithImagesBinding(images: ImagesBinding, bytes: Uint8Array, expectedWidth: number, expectedHeight: number): Promise<boolean> {
  try {
    const info = readPngHeader(bytes);
    if (info.width !== expectedWidth || info.height !== expectedHeight) return false;
    const sample = await samplePngPixels(images, bytes, 94, 40);
    let opaque = 0;
    for (let index = 0; index < sample.width * sample.height; index += 1) {
      const at = index * sample.channels;
      const alpha = sample.colorType === 4 ? sample.pixels[at + 1] : sample.colorType === 6 ? sample.pixels[at + 3] : 255;
      if (alpha === 255) opaque += 1;
    }
    return opaque / (sample.width * sample.height) >= OPAQUE_PIXEL_THRESHOLD;
  } catch (error) {
    if (error instanceof ImageTransformationServiceError) throw error;
    return false;
  }
}

export async function verifyPngWhiteBackgroundWithImagesBinding(images: ImagesBinding, bytes: Uint8Array, expectedWidth: number, expectedHeight: number): Promise<boolean> {
  try {
    const info = readPngHeader(bytes);
    if (info.width !== expectedWidth || info.height !== expectedHeight) return false;
    const width = 96;
    const height = 54;
    const sample = await samplePngPixels(images, bytes, width, height);
    const borderWidth = Math.max(1, Math.floor(width * WHITE_BACKGROUND_BORDER_FRACTION));
    const borderHeight = Math.max(1, Math.floor(height * WHITE_BACKGROUND_BORDER_FRACTION));
    let opaque = 0;
    let white = 0;
    let nonWhite = 0;
    let borderPixels = 0;
    let borderOpaque = 0;
    let borderWhite = 0;
    for (let index = 0; index < width * height; index += 1) {
      const at = index * sample.channels;
      const x = index % width;
      const y = Math.floor(index / width);
      const isBorder = x < borderWidth || x >= width - borderWidth || y < borderHeight || y >= height - borderHeight;
      if (isBorder) borderPixels += 1;
      const alpha = sample.colorType === 4 ? sample.pixels[at + 1] : sample.colorType === 6 ? sample.pixels[at + 3] : 255;
      if (alpha !== 255) continue;
      opaque += 1;
      const red = sample.pixels[at];
      const green = sample.colorType === 0 || sample.colorType === 4 ? red : sample.pixels[at + 1];
      const blue = sample.colorType === 0 || sample.colorType === 4 ? red : sample.pixels[at + 2];
      const isWhite = red >= WHITE_BACKGROUND_MIN_CHANNEL && green >= WHITE_BACKGROUND_MIN_CHANNEL && blue >= WHITE_BACKGROUND_MIN_CHANNEL;
      if (isWhite) white += 1; else nonWhite += 1;
      if (isBorder) {
        borderOpaque += 1;
        if (isWhite) borderWhite += 1;
      }
    }
    return opaque / (width * height) >= OPAQUE_PIXEL_THRESHOLD && nonWhite > 0 && white / opaque >= WHITE_BACKGROUND_MIN_COVERAGE && borderPixels > 0 &&
      borderOpaque / borderPixels >= OPAQUE_PIXEL_THRESHOLD && borderWhite / borderOpaque >= WHITE_BACKGROUND_BORDER_THRESHOLD;
  } catch (error) {
    if (error instanceof ImageTransformationServiceError) throw error;
    return false;
  }
}

export async function verifyPngWhiteBackground(bytes: Uint8Array, expectedWidth: number, expectedHeight: number): Promise<boolean> {
  try {
    return await verifyPngWhiteBackgroundUnsafe(bytes, expectedWidth, expectedHeight);
  } catch {
    return false;
  }
}

async function verifyPngWhiteBackgroundUnsafe(bytes: Uint8Array, expectedWidth: number, expectedHeight: number): Promise<boolean> {
  const info = readPng(bytes);
  if (info.width !== expectedWidth || info.height !== expectedHeight) return false;
  const { pixels, channels } = await inflatePngPixels(info);
  let opaque = 0;
  let white = 0;
  let nonWhite = 0;
  let borderPixels = 0;
  let borderOpaque = 0;
  let borderWhite = 0;
  const borderWidth = Math.max(1, Math.floor(info.width * WHITE_BACKGROUND_BORDER_FRACTION));
  const borderHeight = Math.max(1, Math.floor(info.height * WHITE_BACKGROUND_BORDER_FRACTION));
  for (let index = 0; index < info.width * info.height; index += 1) {
    const at = index * channels;
    const alpha = info.colorType === 4 ? pixels[at + 1] : info.colorType === 6 ? pixels[at + 3] : 255;
    const red = pixels[at];
    const green = info.colorType === 0 || info.colorType === 4 ? red : pixels[at + 1];
    const blue = info.colorType === 0 || info.colorType === 4 ? red : pixels[at + 2];
    const x = index % info.width;
    const y = Math.floor(index / info.width);
    const isBorder = x < borderWidth || x >= info.width - borderWidth || y < borderHeight || y >= info.height - borderHeight;
    if (isBorder) borderPixels += 1;
    if (alpha !== 255) continue;
    opaque += 1;
    const isWhite = red >= WHITE_BACKGROUND_MIN_CHANNEL && green >= WHITE_BACKGROUND_MIN_CHANNEL && blue >= WHITE_BACKGROUND_MIN_CHANNEL;
    if (isWhite) white += 1; else nonWhite += 1;
    if (isBorder) {
      borderOpaque += 1;
      if (isWhite) borderWhite += 1;
    }
  }
  return opaque / (info.width * info.height) >= OPAQUE_PIXEL_THRESHOLD &&
    nonWhite > 0 && white / opaque >= WHITE_BACKGROUND_MIN_COVERAGE && borderPixels > 0 &&
    borderOpaque / borderPixels >= OPAQUE_PIXEL_THRESHOLD &&
    borderWhite / borderOpaque >= WHITE_BACKGROUND_BORDER_THRESHOLD;
}

export async function verifyPngOpaqueCoverage(bytes: Uint8Array, expectedWidth: number, expectedHeight: number): Promise<boolean> {
  try {
    return await verifyPngOpaqueCoverageUnsafe(bytes, expectedWidth, expectedHeight);
  } catch {
    return false;
  }
}

async function verifyPngOpaqueCoverageUnsafe(bytes: Uint8Array, expectedWidth: number, expectedHeight: number): Promise<boolean> {
  const info = readPng(bytes);
  if (info.width !== expectedWidth || info.height !== expectedHeight) return false;
  const { pixels, channels } = await inflatePngPixels(info);
  let opaque = 0;
  for (let index = 0; index < info.width * info.height; index += 1) {
    const at = index * channels;
    const alpha = info.colorType === 4 ? pixels[at + 1] : info.colorType === 6 ? pixels[at + 3] : 255;
    if (alpha === 255) opaque += 1;
  }
  return opaque / (info.width * info.height) >= OPAQUE_PIXEL_THRESHOLD;
}

function assertKey(key: string): void {
  if (!key || key.includes("..") || key.includes("\\") || !key.startsWith("editorial/v3/")) throw new BinaryImageStoreError("binary_key_invalid", "binary key is outside the visual namespace", 400);
}

function metadataMatches(actual: Record<string, string>, expected: Record<string, string>): boolean {
  const keys = Object.keys(expected);
  return Object.keys(actual).length === keys.length && keys.every((key) => actual[key] === expected[key]);
}

function metadataFor(value: BinaryImageMetadata): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function parseStoredMetadata(value: Record<string, string>, key: string): BinaryImageMetadata {
  const width = Number(value.width);
  const height = Number(value.height);
  const byteLength = Number(value.byte_length);
  if (value.storage_ref !== `r2://${key}` || value.mime !== "image/png" ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(byteLength) ||
      typeof value.byte_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.byte_hash) ||
      !value.user_id || !value.workspace_id || !value.run_id || !value.frozen_payload_hash || !value.slot_id) {
    throw new BinaryImageStoreError("binary_reconciliation_required", "stored binary metadata is not sufficient to reconcile", 503);
  }
  return {
    storage_ref: value.storage_ref,
    byte_hash: value.byte_hash,
    byte_length: byteLength,
    mime: "image/png",
    width,
    height,
    user_id: value.user_id,
    workspace_id: value.workspace_id,
    run_id: value.run_id,
    frozen_payload_hash: value.frozen_payload_hash,
    slot_id: value.slot_id,
  };
}

async function readExact(bucket: BinaryImageBucket, key: string, expected: BinaryImageMetadata): Promise<Uint8Array> {
  let object: R2ObjectBody | null;
  try { object = await bucket.get(key); } catch { throw new BinaryImageStoreError("binary_reconciliation_required", "binary object read is unknown", 503); }
  if (!object) throw new BinaryImageStoreError("binary_reconciliation_required", "binary object is not readable", 503);
  let head: R2Object | null;
  try { head = await bucket.head(key); } catch { throw new BinaryImageStoreError("binary_reconciliation_required", "binary head read is unknown", 503); }
  if (!head) throw new BinaryImageStoreError("binary_reconciliation_required", "binary head is missing", 503);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await object.arrayBuffer()); } catch { throw new BinaryImageStoreError("binary_reconciliation_required", "binary body read is unknown", 503); }
  const actualMetadata = object.customMetadata || {};
  const headMetadata = head.customMetadata || {};
  if (!metadataMatches(actualMetadata, metadataFor(expected)) || !metadataMatches(headMetadata, metadataFor(expected)) || head.size !== bytes.byteLength || bytes.byteLength !== expected.byte_length || await sha256(bytes) !== expected.byte_hash) throw new BinaryImageStoreError("binary_readback_mismatch", "binary metadata or hash is not exact", 500);
  const dimensions = readPngDimensions(bytes);
  if (dimensions.width !== expected.width || dimensions.height !== expected.height) throw new BinaryImageStoreError("binary_readback_mismatch", "binary dimensions are not exact", 422);
  return bytes;
}

export async function putImmutableBinaryImage(bucket: BinaryImageBucket, key: string, bytes: Uint8Array, expected: Omit<BinaryImageMetadata, "byte_hash" | "byte_length" | "storage_ref">): Promise<{ status: "created" | "replayed"; metadata: BinaryImageMetadata }> {
  const metadata = await describeImmutableBinaryImage(key, bytes, expected);
  let head: R2Object | null;
  try { head = await bucket.head(key); } catch { throw new BinaryImageStoreError("binary_reconciliation_required", "binary head is unavailable", 503); }
  if (head) {
    const existingMetadata = head.customMetadata || {};
    if (existingMetadata.byte_hash && existingMetadata.byte_hash !== metadata.byte_hash) throw new BinaryImageStoreError("binary_conflict", "immutable binary key contains different bytes");
    if (existingMetadata.byte_length && existingMetadata.byte_length !== String(metadata.byte_length)) throw new BinaryImageStoreError("binary_conflict", "immutable binary key contains different length");
    const existing = await readExact(bucket, key, metadata);
    if (existing.every((value, index) => value === bytes[index]) && existing.byteLength === bytes.byteLength) return { status: "replayed", metadata };
    throw new BinaryImageStoreError("binary_conflict", "immutable binary key contains different bytes");
  }
  try {
    const result = await bucket.put(key, bytes, { httpMetadata: { contentType: "image/png" }, customMetadata: metadataFor(metadata), onlyIf: { etagDoesNotMatch: "*" } });
    if (!result) throw new Error("binary put outcome is unknown");
  } catch {
    try {
      const replay = await readExact(bucket, key, metadata);
      if (replay.every((value, index) => value === bytes[index]) && replay.byteLength === bytes.byteLength) return { status: "replayed", metadata };
      throw new BinaryImageStoreError("binary_conflict", "immutable binary write conflicted");
    } catch (error) {
      if (error instanceof BinaryImageStoreError && error.code === "binary_conflict") throw error;
      throw new BinaryImageStoreError("binary_reconciliation_required", "binary write outcome is unknown", 503);
    }
  }
  await readExact(bucket, key, metadata);
  return { status: "created", metadata };
}

export async function describeImmutableBinaryImage(key: string, bytes: Uint8Array, expected: Omit<BinaryImageMetadata, "byte_hash" | "byte_length" | "storage_ref">): Promise<BinaryImageMetadata> {
  assertKey(key);
  if (key !== visualBinaryKey(expected.user_id, expected.workspace_id, expected.run_id, expected.frozen_payload_hash, expected.slot_id)) throw new BinaryImageStoreError("binary_owner_conflict", "binary key is not canonical for the visual scope", 403);
  const dimensions = readPngDimensions(bytes);
  if (dimensions.width !== expected.width || dimensions.height !== expected.height) throw new BinaryImageStoreError("binary_readback_mismatch", "image dimensions do not match the slot", 422);
  return { ...expected, storage_ref: `r2://${key}`, byte_hash: await sha256(bytes), byte_length: bytes.byteLength };
}

export async function readImmutableBinaryImage(bucket: BinaryImageBucket, key: string, expected: BinaryImageMetadata): Promise<Uint8Array> {
  assertKey(key);
  if (key !== visualBinaryKey(expected.user_id, expected.workspace_id, expected.run_id, expected.frozen_payload_hash, expected.slot_id) || expected.storage_ref !== `r2://${key}`) throw new BinaryImageStoreError("binary_owner_conflict", "binary storage ref is not canonical", 403);
  return readExact(bucket, key, expected);
}

export async function readExistingImmutableBinaryImage(bucket: BinaryImageBucket, key: string, expectedScope: BinaryImageScope): Promise<BinaryImageRead | null> {
  assertKey(key);
  if (key !== visualBinaryKey(expectedScope.user_id, expectedScope.workspace_id, expectedScope.run_id, expectedScope.frozen_payload_hash, expectedScope.slot_id)) throw new BinaryImageStoreError("binary_owner_conflict", "binary key is not canonical for the visual scope", 403);
  let head: R2Object | null;
  try { head = await bucket.head(key); } catch { throw new BinaryImageStoreError("binary_reconciliation_required", "binary head read is unknown", 503); }
  if (!head) return null;
  const metadata = parseStoredMetadata(head.customMetadata || {}, key);
  if (metadata.user_id !== expectedScope.user_id || metadata.workspace_id !== expectedScope.workspace_id || metadata.run_id !== expectedScope.run_id || metadata.frozen_payload_hash !== expectedScope.frozen_payload_hash || metadata.slot_id !== expectedScope.slot_id) throw new BinaryImageStoreError("binary_owner_conflict", "binary object is outside the expected visual scope", 403);
  const bytes = await readExact(bucket, key, metadata);
  return { bytes, metadata };
}
