import { canonicalJson, sha256 } from "./artifactContracts";
import { toVisualArtifactMetadata, type VisualArtifactObject } from "./visualContracts";

export type VisualJsonBucket = Pick<R2Bucket, "get" | "head" | "put">;

export class VisualArtifactStoreError extends Error {
  constructor(public readonly code: "visual_artifact_conflict" | "visual_artifact_reconciliation_required" | "visual_artifact_readback_mismatch", message: string, public readonly status = 409) {
    super(message);
    this.name = "VisualArtifactStoreError";
  }
}

function bytes(object: VisualArtifactObject): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ envelope: object.envelope, payload: object.payload }));
}

function metadata(object: VisualArtifactObject): Record<string, string> {
  const value = toVisualArtifactMetadata(object);
  return {
    schema_version: value.schema_version,
    artifact_id: value.artifact_id,
    kind: value.kind,
    run_id: value.run_id,
    article_id: value.article_id,
    recording_id: String(value.recording_id),
    user_id: value.user_id,
    workspace_id: value.workspace_id,
    producer_role: value.producer.role,
    producer_version: value.producer.version,
    payload_hash: value.payload_hash,
    payload_length: String(value.payload_length),
    storage_ref: value.storage_ref,
    binary_storage_ref: value.binary_storage_ref || "",
    idempotency_key: value.idempotency_key,
    created_at: value.created_at,
  };
}

function matches(actual: Record<string, string>, expected: Record<string, string>): boolean {
  const keys = Object.keys(expected);
  return Object.keys(actual).length === keys.length && keys.every(key => actual[key] === expected[key]);
}

async function readExact(bucket: VisualJsonBucket, object: VisualArtifactObject): Promise<Uint8Array> {
  let body: R2ObjectBody | null;
  try { body = await bucket.get(object.envelope.artifact_key); } catch { throw new VisualArtifactStoreError("visual_artifact_reconciliation_required", "visual artifact body is unknown", 503); }
  if (!body) throw new VisualArtifactStoreError("visual_artifact_reconciliation_required", "visual artifact body is unavailable", 503);
  let head: R2Object | null;
  try { head = await bucket.head(object.envelope.artifact_key); } catch { throw new VisualArtifactStoreError("visual_artifact_reconciliation_required", "visual artifact head is unknown", 503); }
  if (!head) throw new VisualArtifactStoreError("visual_artifact_reconciliation_required", "visual artifact head is unavailable", 503);
  let stored: Uint8Array;
  try { stored = new Uint8Array(await body.arrayBuffer()); } catch { throw new VisualArtifactStoreError("visual_artifact_reconciliation_required", "visual artifact bytes are unknown", 503); }
  const expected = bytes(object);
  if (stored.byteLength !== expected.byteLength || !stored.every((value, index) => value === expected[index])) throw new VisualArtifactStoreError("visual_artifact_conflict", "visual artifact bytes differ", 409);
  if (!matches(body.customMetadata || {}, metadata(object)) || !matches(head.customMetadata || {}, metadata(object)) || head.size !== stored.byteLength || await sha256(new TextEncoder().encode(canonicalJson(object.payload))) !== object.envelope.payload_hash || object.envelope.payload_length !== new TextEncoder().encode(canonicalJson(object.payload)).byteLength) throw new VisualArtifactStoreError("visual_artifact_readback_mismatch", "visual artifact metadata or hash differs", 500);
  return stored;
}

export async function putImmutableVisualArtifact(bucket: VisualJsonBucket, object: VisualArtifactObject): Promise<{ status: "created" | "replayed"; metadata: ReturnType<typeof toVisualArtifactMetadata> }> {
  const expected = bytes(object);
  let head: R2Object | null;
  try { head = await bucket.head(object.envelope.artifact_key); } catch { throw new VisualArtifactStoreError("visual_artifact_reconciliation_required", "visual artifact head is unavailable", 503); }
  if (head) { await readExact(bucket, object); return { status: "replayed", metadata: toVisualArtifactMetadata(object) }; }
  try {
    const result = await bucket.put(object.envelope.artifact_key, expected, { httpMetadata: { contentType: "application/json; charset=utf-8" }, customMetadata: metadata(object), onlyIf: { etagDoesNotMatch: "*" } });
    if (!result) throw new Error("unknown");
  } catch {
    try { await readExact(bucket, object); return { status: "replayed", metadata: toVisualArtifactMetadata(object) }; }
    catch (error) {
      if (error instanceof VisualArtifactStoreError && error.code === "visual_artifact_conflict") throw error;
      throw new VisualArtifactStoreError("visual_artifact_reconciliation_required", "visual artifact write outcome is unknown", 503);
    }
  }
  await readExact(bucket, object);
  return { status: "created", metadata: toVisualArtifactMetadata(object) };
}

export async function readImmutableVisualArtifact(bucket: VisualJsonBucket, object: VisualArtifactObject): Promise<Uint8Array> {
  return readExact(bucket, object);
}
