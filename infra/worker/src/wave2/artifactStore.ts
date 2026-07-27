import {
  artifactKey,
  canonicalJson,
  sha256,
  toArtifactMetadata,
  validateArtifactKey,
  type ArtifactEnvelope,
  type ArtifactObject,
  type ArtifactMetadata,
} from "./artifactContracts";

export type ArtifactStoreCode =
  | "artifact_conflict"
  | "artifact_reconciliation_required"
  | "artifact_readback_mismatch"
  | "artifact_owner_conflict"
  | "artifact_key_invalid";

export class ArtifactStoreError extends Error {
  constructor(public readonly code: ArtifactStoreCode, message: string, public readonly status = 409) {
    super(message);
    this.name = "ArtifactStoreError";
  }
}

type StoredArtifact = {
  envelope: ArtifactEnvelope;
  metadata: ArtifactMetadata;
  bytes: Uint8Array;
};

export type ArtifactBucket = Pick<R2Bucket, "get" | "head" | "put">;

function metadataFor(envelope: ArtifactEnvelope): Record<string, string> {
  return {
    schema_version: envelope.schema_version,
    artifact_id: envelope.artifact_id,
    artifact_kind: envelope.kind,
    run_id: envelope.run_id,
    article_id: envelope.article_id,
    recording_id: String(envelope.recording_id),
    user_id: envelope.user_id,
    workspace_id: envelope.workspace_id,
    producer_role: envelope.producer.role,
    producer_version: envelope.producer.version,
    workflow_version: envelope.workflow_version,
    policy_version: envelope.policy_version,
    payload_hash: envelope.payload_hash,
    payload_length: String(envelope.payload_length),
    created_at: envelope.created_at,
    storage_ref: envelope.storage_ref,
  };
}

function payloadBytes(object: ArtifactObject): Uint8Array {
  return new TextEncoder().encode(canonicalJson(object.payload));
}

function objectBytes(object: ArtifactObject): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ envelope: object.envelope, payload: object.payload }));
}

function getMetadata(value: R2Object | R2ObjectBody): Record<string, string> {
  return value.customMetadata || {};
}

function metadataMatches(actual: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => actual[key] === value);
}

function exactObjectBytes(bytes: Uint8Array, expected: ArtifactObject): boolean {
  const expectedBytes = objectBytes(expected);
  return bytes.byteLength === expectedBytes.byteLength && bytes.every((value, index) => value === expectedBytes[index]);
}

async function readStored(bucket: ArtifactBucket, key: string, expected: ArtifactObject): Promise<Uint8Array> {
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(key);
  } catch {
    throw new ArtifactStoreError("artifact_reconciliation_required", "artifact cannot be read after write", 503);
  }
  if (!object) throw new ArtifactStoreError("artifact_reconciliation_required", "artifact cannot be read after write", 503);
  let head: R2Object | null;
  try {
    head = await bucket.head(key);
  } catch {
    throw new ArtifactStoreError("artifact_reconciliation_required", "artifact head cannot be read after write", 503);
  }
  if (!head) throw new ArtifactStoreError("artifact_reconciliation_required", "artifact head is missing after write", 503);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await object.arrayBuffer());
  } catch {
    throw new ArtifactStoreError("artifact_reconciliation_required", "artifact bytes cannot be read after write", 503);
  }
  const payload = payloadBytes(expected);
  if (!exactObjectBytes(bytes, expected)) {
    throw new ArtifactStoreError("artifact_readback_mismatch", "stored envelope bytes do not match", 500);
  }
  const expectedMetadata = metadataFor(expected.envelope);
  if (!metadataMatches(getMetadata(object), expectedMetadata)
    || !metadataMatches(getMetadata(head), expectedMetadata)
    || !metadataMatches(getMetadata(object), getMetadata(head))
    || !metadataMatches(getMetadata(head), getMetadata(object))
    || head.size !== bytes.byteLength
    || head.size !== objectBytes(expected).byteLength
    || bytes.byteLength === 0
    || await sha256(payload) !== expected.envelope.payload_hash
    || payload.byteLength !== expected.envelope.payload_length) {
    throw new ArtifactStoreError("artifact_readback_mismatch", "stored artifact metadata or payload hash does not match", 500);
  }
  return bytes;
}

async function inspectExisting(bucket: ArtifactBucket, expected: ArtifactObject): Promise<"same" | "different" | "mismatch" | "unknown"> {
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(expected.envelope.artifact_key);
  } catch {
    return "unknown";
  }
  if (!object) return "unknown";
  let head: R2Object | null;
  try {
    head = await bucket.head(expected.envelope.artifact_key);
  } catch {
    return "unknown";
  }
  if (!head) return "unknown";
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await object.arrayBuffer());
  } catch {
    return "unknown";
  }
  if (!exactObjectBytes(bytes, expected)) return "different";
  const expectedMetadata = metadataFor(expected.envelope);
  if (!metadataMatches(getMetadata(object), expectedMetadata)
    || !metadataMatches(getMetadata(head), expectedMetadata)
    || !metadataMatches(getMetadata(object), getMetadata(head))
    || !metadataMatches(getMetadata(head), getMetadata(object))
    || head.size !== bytes.byteLength
    || await sha256(payloadBytes(expected)) !== expected.envelope.payload_hash
    || payloadBytes(expected).byteLength !== expected.envelope.payload_length) return "mismatch";
  return "same";
}

function assertScope(envelope: ArtifactEnvelope, expectedOwner?: { userId: string; workspaceId: string; runId: string }): void {
  validateArtifactKey(envelope.artifact_key);
  if (envelope.artifact_key !== artifactKey(envelope.user_id, envelope.workspace_id, envelope.run_id, envelope.kind, envelope.artifact_id)) {
    throw new ArtifactStoreError("artifact_key_invalid", "artifact key does not match immutable identity", 400);
  }
  if (expectedOwner && (envelope.user_id !== expectedOwner.userId || envelope.workspace_id !== expectedOwner.workspaceId || envelope.run_id !== expectedOwner.runId)) {
    throw new ArtifactStoreError("artifact_owner_conflict", "artifact is outside the requested owner scope", 403);
  }
}

export async function putImmutableArtifact(
  bucket: ArtifactBucket,
  object: ArtifactObject,
  expectedOwner?: { userId: string; workspaceId: string; runId: string },
): Promise<{ status: "created" | "replayed"; metadata: ArtifactMetadata }> {
  const { envelope } = object;
  assertScope(envelope, expectedOwner);
  const bytes = objectBytes(object);
  let existing: R2Object | null;
  try {
    existing = await bucket.head(envelope.artifact_key);
  } catch {
    throw new ArtifactStoreError("artifact_reconciliation_required", "artifact head is unavailable", 503);
  }
  if (existing) {
    const outcome = await inspectExisting(bucket, object);
    if (outcome === "same") return { status: "replayed", metadata: toArtifactMetadata(object) };
    if (outcome === "different") throw new ArtifactStoreError("artifact_conflict", "immutable artifact key contains different bytes");
    if (outcome === "mismatch") throw new ArtifactStoreError("artifact_readback_mismatch", "existing artifact metadata or size differs", 500);
    throw new ArtifactStoreError("artifact_reconciliation_required", "existing artifact cannot be reconciled", 503);
  }

  let putResult: R2Object | null;
  try {
    putResult = await bucket.put(envelope.artifact_key, bytes, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: metadataFor(envelope),
      onlyIf: { etagDoesNotMatch: "*" },
    });
  } catch {
    let outcome: "same" | "different" | "mismatch" | "unknown";
    try {
      outcome = await inspectExisting(bucket, object);
    } catch {
      outcome = "unknown";
    }
    if (outcome === "same") return { status: "replayed", metadata: toArtifactMetadata(object) };
    if (outcome === "different") throw new ArtifactStoreError("artifact_conflict", "immutable artifact write conflicted");
    if (outcome === "mismatch") throw new ArtifactStoreError("artifact_readback_mismatch", "existing artifact metadata or size differs", 500);
    throw new ArtifactStoreError("artifact_reconciliation_required", "artifact write outcome is unknown", 503);
  }
  if (!putResult) {
    const outcome = await inspectExisting(bucket, object);
    if (outcome === "same") return { status: "replayed", metadata: toArtifactMetadata(object) };
    if (outcome === "different") throw new ArtifactStoreError("artifact_conflict", "immutable artifact write conflicted");
    if (outcome === "mismatch") throw new ArtifactStoreError("artifact_readback_mismatch", "existing artifact metadata or size differs", 500);
    throw new ArtifactStoreError("artifact_reconciliation_required", "artifact write outcome is unknown", 503);
  }
  await readStored(bucket, envelope.artifact_key, object);
  return { status: "created", metadata: toArtifactMetadata(object) };
}

export async function readImmutableArtifact(
  bucket: ArtifactBucket,
  expected: ArtifactObject,
  expectedOwner?: { userId: string; workspaceId: string; runId: string },
): Promise<StoredArtifact> {
  const { envelope } = expected;
  assertScope(envelope, expectedOwner);
  const bytes = await readStored(bucket, envelope.artifact_key, expected);
  return { envelope, metadata: toArtifactMetadata(expected), bytes };
}

export function toD1ArtifactMirror(object: ArtifactObject): Record<string, unknown> {
  const metadata = toArtifactMetadata(object);
  const formattingPin = metadata.skill_pins.formatting || metadata.skill_pins.writing || null;
  return {
    artifact_id: metadata.artifact_id,
    run_id: metadata.run_id,
    article_id: metadata.article_id,
    recording_id: metadata.recording_id,
    user_id: metadata.user_id,
    workspace_id: metadata.workspace_id,
    kind: metadata.kind,
    payload_hash: metadata.payload_hash,
    storage_ref: metadata.storage_ref,
    input_artifact_ids_json: JSON.stringify(metadata.input_artifact_ids),
    skill_id: formattingPin?.id || null,
    skill_version: formattingPin?.version || null,
    style_profile_body_hash: metadata.payload_summary.style_profile_body_hash || null,
    producer_role: metadata.producer.role,
    producer_version: metadata.producer.version,
    schema_version: metadata.schema_version,
    workflow_version: metadata.workflow_version,
    policy_version: metadata.policy_version,
    created_at: metadata.created_at,
    summary: metadata.payload_summary,
  };
}
