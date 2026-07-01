import { S3Client, ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import crypto from "crypto";

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const BUCKET_NAME = process.env.R2_BUCKET_NAME || 'vibepub-files';

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

export async function listUnprocessedFiles(): Promise<string[]> {
  const command = new ListObjectsV2Command({
    Bucket: BUCKET_NAME,
  });
  
  const response = await s3.send(command);
  if (!response.Contents) {
    return [];
  }
  
  // Audio files uploaded by the app (e.g. .m4a or .mp3)
  return response.Contents.map(c => c.Key!).filter(k =>
    k.startsWith('inbox/') && (k.endsWith('.m4a') || k.endsWith('.mp3')),
  );
}

export async function downloadFile(key: string): Promise<Buffer> {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });
  
  const response = await s3.send(command);
  const stream = response.Body as NodeJS.ReadableStream;
  
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    stream.on('error', err => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export async function createPresignedDownloadUrl(key: string, expiresInSeconds = 900): Promise<string> {
  const host = `${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const canonicalUri = `/${encodePathSegment(BUCKET_NAME)}/${key.split("/").map(encodePathSegment).join("/")}`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${R2_ACCESS_KEY_ID}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = toCanonicalQuery(query);
  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(getSigningKey(R2_SECRET_ACCESS_KEY, dateStamp, "auto", "s3"), stringToSign);

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export async function deleteFile(key: string): Promise<void> {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
  });
  await s3.send(command);
}

export async function uploadTranscript(key: string, data: string): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: data,
    ContentType: "application/json",
  });
  await s3.send(command);
}

export async function uploadCoverImage(key: string, imageBuffer: Buffer): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    Body: imageBuffer,
    ContentType: "image/png",
    CacheControl: "private, max-age=86400",
  });
  await s3.send(command);
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!*'()]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function toCanonicalQuery(query: Record<string, string>): string {
  return Object.keys(query)
    .sort()
    .map(key => `${encodePathSegment(key)}=${encodePathSegment(query[key])}`)
    .join("&");
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return hmac(key, value).toString("hex");
}

function getSigningKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}
