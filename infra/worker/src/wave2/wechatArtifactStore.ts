import { canonicalJson, sha256 } from "./artifactContracts";
import { toWechatArtifactMetadata, type WechatArtifactObject } from "./wechatContracts";

export type WechatArtifactBucket = Pick<R2Bucket, "get" | "head" | "put">;

export class WechatArtifactStoreError extends Error {
  constructor(
    public readonly code: "wechat_artifact_conflict" | "wechat_artifact_reconciliation_required" | "wechat_artifact_readback_mismatch",
    message: string,
    public readonly status = 409,
  ) { super(message); }
}

function objectBytes(object: WechatArtifactObject): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ envelope: object.envelope, payload: object.payload }));
}

function objectMetadata(object: WechatArtifactObject): Record<string, string> {
  const metadata = toWechatArtifactMetadata(object);
  return {
    schema_version: metadata.schema_version,
    artifact_id: metadata.artifact_id,
    kind: metadata.kind,
    run_id: metadata.run_id,
    article_id: metadata.article_id,
    recording_id: String(metadata.recording_id),
    user_id: metadata.user_id,
    workspace_id: metadata.workspace_id,
    producer_role: metadata.producer.role,
    producer_version: metadata.producer.version,
    payload_hash: metadata.payload_hash,
    payload_length: String(metadata.payload_length),
    storage_ref: metadata.storage_ref,
    idempotency_key: metadata.idempotency_key,
    created_at: metadata.created_at,
  };
}

function matches(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

export async function readExactWechatArtifact(bucket: WechatArtifactBucket, object: WechatArtifactObject): Promise<void> {
  let body: R2ObjectBody | null;
  let head: R2Object | null;
  try { [body, head] = await Promise.all([bucket.get(object.envelope.artifact_key), bucket.head(object.envelope.artifact_key)]); }
  catch { throw new WechatArtifactStoreError("wechat_artifact_reconciliation_required", "wechat artifact readback is unknown", 503); }
  if (!body || !head) throw new WechatArtifactStoreError("wechat_artifact_reconciliation_required", "wechat artifact is unavailable", 503);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await body.arrayBuffer()); } catch { throw new WechatArtifactStoreError("wechat_artifact_reconciliation_required", "wechat artifact bytes are unreadable", 503); }
  const expected = objectBytes(object);
  if (bytes.byteLength !== expected.byteLength || !bytes.every((value, index) => value === expected[index])) {
    throw new WechatArtifactStoreError("wechat_artifact_conflict", "wechat artifact bytes conflict", 409);
  }
  const metadata = objectMetadata(object);
  const payloadHash = await sha256(new TextEncoder().encode(canonicalJson(object.payload)));
  if (!matches(body.customMetadata || {}, metadata) || !matches(head.customMetadata || {}, metadata) || head.size !== bytes.byteLength || payloadHash !== object.envelope.payload_hash) {
    throw new WechatArtifactStoreError("wechat_artifact_readback_mismatch", "wechat artifact metadata is invalid", 500);
  }
}

export async function putImmutableWechatArtifact(bucket: WechatArtifactBucket, object: WechatArtifactObject): Promise<{ status: "created" | "replayed"; metadata: ReturnType<typeof toWechatArtifactMetadata> }> {
  let existing: R2Object | null;
  try { existing = await bucket.head(object.envelope.artifact_key); } catch { throw new WechatArtifactStoreError("wechat_artifact_reconciliation_required", "wechat artifact head is unknown", 503); }
  if (existing) {
    await readExactWechatArtifact(bucket, object);
    return { status: "replayed", metadata: toWechatArtifactMetadata(object) };
  }
  try {
    const written = await bucket.put(object.envelope.artifact_key, objectBytes(object), {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: objectMetadata(object),
    });
    if (!written) throw new Error("conditional put outcome unknown");
  } catch (error) {
    try {
      await readExactWechatArtifact(bucket, object);
      return { status: "replayed", metadata: toWechatArtifactMetadata(object) };
    } catch (readError) {
      if (readError instanceof WechatArtifactStoreError && readError.code === "wechat_artifact_conflict") throw readError;
      throw new WechatArtifactStoreError("wechat_artifact_reconciliation_required", "wechat artifact write outcome is unknown", 503);
    }
  }
  await readExactWechatArtifact(bucket, object);
  return { status: "created", metadata: toWechatArtifactMetadata(object) };
}
