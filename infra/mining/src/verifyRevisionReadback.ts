import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { downloadFile } from "./r2.js";

const HASH = /^sha256:[a-f0-9]{64}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("revision_readback_invalid");
  return value as Record<string, unknown>;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function verifyRevisionReadbackEvidence(
  requestValue: unknown,
  transcriptValue: unknown,
  expected: { revisionId: string; childVersionId: string; minimumVerifiedAt: string },
): Record<string, unknown> {
  const request = object(requestValue);
  const transcript = object(transcriptValue);
  const requestRevisionId = String(request.revisionId || request.revision_id || "");
  if (!expected.revisionId || requestRevisionId !== expected.revisionId || transcript.articleVersionId !== expected.childVersionId || transcript.articleVersionNo !== 2) {
    throw new Error("revision_readback_identity_invalid");
  }
  const history = Array.isArray(transcript.revisionHistory) ? transcript.revisionHistory : [];
  const entry = history.map(object).find(item => item.revisionId === expected.revisionId && item.articleVersionId === expected.childVersionId && item.articleVersionNo === 2);
  if (!entry) throw new Error("revision_readback_identity_invalid");
  const readback = object(entry.wechatDraftReadback);
  if (readback.verified !== true || !HASH.test(String(readback.mediaIdHash || "")) ||
      !HASH.test(String(readback.expectedTitleHash || "")) || !HASH.test(String(readback.titleHash || "")) ||
      !HASH.test(String(readback.expectedContentHash || "")) || !HASH.test(String(readback.contentHash || ""))) {
    throw new Error("revision_readback_unverified");
  }
  if (readback.expectedTitleHash !== readback.titleHash || readback.expectedContentHash !== readback.contentHash) {
    throw new Error("revision_readback_mismatch");
  }
  const verifiedAt = String(readback.verifiedAt || "");
  const verifiedMs = Date.parse(verifiedAt);
  const minimumMs = Date.parse(expected.minimumVerifiedAt);
  if (!Number.isFinite(verifiedMs) || !Number.isFinite(minimumMs) || verifiedMs < minimumMs) throw new Error("revision_readback_stale");
  return {
    verified: true,
    revision_id_hash: digest(expected.revisionId),
    child_version_id_hash: digest(expected.childVersionId),
    media_id_hash: readback.mediaIdHash,
    title_hash: readback.titleHash,
    content_hash: readback.contentHash,
    verified_at: verifiedAt,
  };
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  return index < 0 ? "" : String(args[index + 1] || "");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const requestKey = option(args, "--revision-request-key");
  const childVersionId = option(args, "--child-version-id");
  const minimumVerifiedAt = option(args, "--minimum-verified-at");
  const output = option(args, "--out");
  if (!/^users\/[A-Za-z0-9._:-]+\/revision-requests\/[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+\.json$/.test(requestKey) || requestKey.includes("..") || !childVersionId || !minimumVerifiedAt || !output) {
    throw new Error("revision_readback_input_invalid");
  }
  const request = JSON.parse((await downloadFile(requestKey)).toString("utf8"));
  const transcriptKey = String(request.transcriptKey || request.transcript_key || "");
  if (!/^users\/[A-Za-z0-9._:-]+\/transcripts\/[A-Za-z0-9._:-]+\.json$/.test(transcriptKey) || transcriptKey.includes("..")) {
    throw new Error("revision_readback_input_invalid");
  }
  const transcript = JSON.parse((await downloadFile(transcriptKey)).toString("utf8"));
  const evidence = verifyRevisionReadbackEvidence(request, transcript, {
    revisionId: String(request.revisionId || request.revision_id || ""), childVersionId, minimumVerifiedAt,
  });
  await writeFile(resolve(output), JSON.stringify(evidence, null, 2), "utf8");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : "revision_readback_failed");
    process.exit(1);
  });
}
