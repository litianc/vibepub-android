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

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

type PngInfo = { width: number; height: number; bitDepth: number; colorType: number; interlace: number; idat: Uint8Array[] };

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
  const info = readPng(bytes);
  return { width: info.width, height: info.height };
}

const WHITE_BACKGROUND_THRESHOLD = 0.98;
const OPAQUE_PIXEL_THRESHOLD = 0.98;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
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
  if (info.width !== expectedWidth || info.height !== expectedHeight || info.bitDepth !== 8 || info.interlace !== 0 || ![0, 2, 4, 6].includes(info.colorType) || info.idat.length === 0) return false;
  const compressed = new Uint8Array(info.idat.reduce((total, item) => total + item.byteLength, 0));
  let cursor = 0;
  for (const item of info.idat) { compressed.set(item, cursor); cursor += item.byteLength; }
  let raw: Uint8Array;
  try { raw = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer()); }
  catch { return false; }
  const channels = info.colorType === 0 ? 1 : info.colorType === 2 ? 3 : info.colorType === 4 ? 2 : 4;
  const bytesPerPixel = channels;
  const rowBytes = info.width * bytesPerPixel;
  if (raw.byteLength !== info.height * (rowBytes + 1)) return false;
  const previous = new Uint8Array(rowBytes);
  let white = 0;
  let opaque = 0;
  let nonWhite = 0;
  for (let y = 0; y < info.height; y += 1) {
    const filter = raw[y * (rowBytes + 1)];
    if (filter > 4) return false;
    const row = new Uint8Array(rowBytes);
    const start = y * (rowBytes + 1) + 1;
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const value = raw[start + x];
      row[x] = filter === 0 ? value : filter === 1 ? (value + left) & 255 : filter === 2 ? (value + up) & 255 : filter === 3 ? (value + Math.floor((left + up) / 2)) & 255 : (value + paeth(left, up, upperLeft)) & 255;
    }
    for (let x = 0; x < info.width; x += 1) {
      const at = x * bytesPerPixel;
      const alpha = info.colorType === 4 ? row[at + 1] : info.colorType === 6 ? row[at + 3] : 255;
      const red = row[at];
      const green = info.colorType === 0 || info.colorType === 4 ? red : row[at + 1];
      const blue = info.colorType === 0 || info.colorType === 4 ? red : row[at + 2];
      if (alpha !== 255) continue;
      opaque += 1;
      if (red === 255 && green === 255 && blue === 255) white += 1; else nonWhite += 1;
    }
    previous.set(row);
  }
  return opaque / (info.width * info.height) >= OPAQUE_PIXEL_THRESHOLD && opaque > 0 && nonWhite > 0 && white / opaque >= WHITE_BACKGROUND_THRESHOLD;
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
  if (info.width !== expectedWidth || info.height !== expectedHeight || info.bitDepth !== 8 || info.interlace !== 0 || ![0, 2, 4, 6].includes(info.colorType) || info.idat.length === 0) return false;
  const compressed = new Uint8Array(info.idat.reduce((total, item) => total + item.byteLength, 0));
  let cursor = 0;
  for (const item of info.idat) { compressed.set(item, cursor); cursor += item.byteLength; }
  let raw: Uint8Array;
  try { raw = new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer()); }
  catch { return false; }
  const channels = info.colorType === 0 ? 1 : info.colorType === 2 ? 3 : info.colorType === 4 ? 2 : 4;
  const bytesPerPixel = channels;
  const rowBytes = info.width * bytesPerPixel;
  if (raw.byteLength !== info.height * (rowBytes + 1)) return false;
  const previous = new Uint8Array(rowBytes);
  let opaque = 0;
  for (let y = 0; y < info.height; y += 1) {
    const filter = raw[y * (rowBytes + 1)];
    if (filter > 4) return false;
    const row = new Uint8Array(rowBytes);
    const start = y * (rowBytes + 1) + 1;
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upperLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
      const value = raw[start + x];
      row[x] = filter === 0 ? value : filter === 1 ? (value + left) & 255 : filter === 2 ? (value + up) & 255 : filter === 3 ? (value + Math.floor((left + up) / 2)) & 255 : (value + paeth(left, up, upperLeft)) & 255;
    }
    for (let x = 0; x < info.width; x += 1) {
      const at = x * bytesPerPixel;
      const alpha = info.colorType === 4 ? row[at + 1] : info.colorType === 6 ? row[at + 3] : 255;
      if (alpha === 255) opaque += 1;
    }
    previous.set(row);
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
