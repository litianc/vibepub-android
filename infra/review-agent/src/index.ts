export const REVIEW_PROTOCOL_VERSION = "vibepub.editorial.review.v1";
export const REVIEWER_VERSION = "editorial-review.adapter.1.0.0";
export const REVIEW_RULE_PINS = {
  dbs_ai_check: { id: "dbs-ai-check", version: "1.0.0" },
  humanizer: { id: "humanizer-zh", version: "1.0.0" },
} as const;

type ReviewEnv = { REVIEW_AGENT_TOKEN?: string };

type DraftBlock = {
  block_id: string;
  kind: string;
  order: number;
  text: string;
  text_hash: string;
  claim_ids: string[];
  image_ref_ids: string[];
};

const CLAIM_CLASSIFICATIONS = new Set(["author_view", "source_fact", "external_fact"]);
const CLAIM_VERIFICATION_STATUSES = new Set(["not_required", "pending", "verified", "failed"]);

function validClaimClassification(value: unknown): value is string {
  return typeof value === "string" && CLAIM_CLASSIFICATIONS.has(value);
}

function validClaimVerificationStatus(value: unknown): value is string {
  return typeof value === "string" && CLAIM_VERIFICATION_STATUSES.has(value);
}

export type ReviewDraftRequest = {
  protocol_version: string;
  article_id: string;
  run_id: string;
  input_artifact_id: string;
  input_payload_hash: string;
  input_payload: Record<string, unknown>;
  recording_id: number;
  review_round: 1 | 2;
  title: string;
  body: string;
  blocks: DraftBlock[];
};

export type ReviewReport = {
  article_id: string;
  run_id: string;
  recording_id: number;
  input_artifact_id: string;
  input_payload_hash: string;
  review_round: 1 | 2;
  decision: "pass" | "revise" | "block";
  findings: Array<{
    finding_id: string;
    severity: "P0" | "P1" | "P2";
    code: string;
    target: string;
    evidence: { text_hash: string; start: number; end: number };
    evidence_hash: string;
    suggested_action: string | null;
    requires_human: boolean;
  }>;
  revision_targets: string[];
  suggested_actions: string[];
  reviewer_version: string;
  rules_pins: typeof REVIEW_RULE_PINS;
};

export class ReviewAgentError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "ReviewAgentError";
  }
}

const HASH_RE = /^sha256:[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

async function secureEquals(expected: string, candidate: string): Promise<boolean> {
  if (!candidate) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function validateClaimLedger(value: unknown, blocks: DraftBlock[]): void {
  if (!Array.isArray(value) || value.length > 256) throw new ReviewAgentError("input_payload_claim_ledger_conflict", 409);
  const blockIds = new Set(blocks.map(block => block.block_id));
  const expectedByBlock = new Map<string, string[]>();
  const actualByBlock = new Map<string, string[]>();
  const claimIds = new Set<string>();

  for (const block of blocks) {
    if (new Set(block.claim_ids).size !== block.claim_ids.length) throw new ReviewAgentError("input_payload_claim_ledger_conflict", 409);
    expectedByBlock.set(block.block_id, [...block.claim_ids]);
  }

  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ReviewAgentError("input_payload_claim_ledger_conflict", 409);
    const claim = raw as Record<string, unknown>;
    if (!validId(claim.claim_id) || !validId(claim.block_id) || !blockIds.has(claim.block_id)
      || claimIds.has(claim.claim_id)
      || !validClaimClassification(claim.classification)
      || !validClaimVerificationStatus(claim.verification_status)) {
      throw new ReviewAgentError("input_payload_claim_ledger_conflict", 409);
    }
    claimIds.add(claim.claim_id);
    const claims = actualByBlock.get(claim.block_id) || [];
    claims.push(claim.claim_id);
    actualByBlock.set(claim.block_id, claims);
  }

  for (const block of blocks) {
    const expected = [...(expectedByBlock.get(block.block_id) || [])].sort();
    const actual = [...(actualByBlock.get(block.block_id) || [])].sort();
    if (expected.length !== actual.length || expected.some((claimId, index) => claimId !== actual[index])) {
      throw new ReviewAgentError("input_payload_claim_ledger_conflict", 409);
    }
  }
}

async function normalizeRequest(value: unknown): Promise<ReviewDraftRequest> {
  if (!value || typeof value !== "object") throw new ReviewAgentError("invalid_review_request", 400);
  const record = value as Record<string, unknown>;
  if (record.protocol_version !== REVIEW_PROTOCOL_VERSION) throw new ReviewAgentError("protocol_version_conflict", 409);
  if (!validId(record.article_id) || !validId(record.run_id) || !validId(record.input_artifact_id) || !validHash(record.input_payload_hash)
    || !Number.isSafeInteger(record.recording_id) || Number(record.recording_id) < 1) {
    throw new ReviewAgentError("invalid_review_request", 400);
  }
  if (record.review_round !== 1 && record.review_round !== 2) throw new ReviewAgentError("invalid_review_request", 400);
  if (typeof record.title !== "string" || record.title.length === 0 || typeof record.body !== "string" || record.body.length === 0 || record.title.length > 2_000 || record.body.length > 500_000) {
    throw new ReviewAgentError("invalid_review_request", 400);
  }
  if (!Array.isArray(record.blocks) || record.blocks.length === 0 || record.blocks.length > 200) throw new ReviewAgentError("invalid_review_request", 400);
  const inputPayload = record.input_payload ?? record.draft_payload;
  if (!inputPayload || typeof inputPayload !== "object" || Array.isArray(inputPayload)) throw new ReviewAgentError("input_payload_required", 400);
  if (await sha256(canonical(inputPayload)) !== record.input_payload_hash) throw new ReviewAgentError("input_payload_hash_mismatch", 409);
  const payload = inputPayload as Record<string, unknown>;
  if (payload.article_id !== record.article_id || payload.run_id !== record.run_id || payload.recording_id !== record.recording_id || payload.title !== record.title || payload.body !== record.body) throw new ReviewAgentError("input_payload_identity_conflict", 409);
  const blocks = record.blocks.map((raw, index) => {
    if (!raw || typeof raw !== "object") throw new ReviewAgentError("invalid_review_request", 400);
    const block = raw as Record<string, unknown>;
    if (block.block_id !== `block_v1_${index + 1}` || block.order !== index || typeof block.text !== "string" || !/^(paragraph|heading|quote|list|code|table)$/.test(String(block.kind))) {
      throw new ReviewAgentError("invalid_review_request", 400);
    }
    if (!validHash(block.text_hash) || !Array.isArray(block.claim_ids) || block.claim_ids.length > 64 || block.claim_ids.some(item => !validId(item)) || !Array.isArray(block.image_ref_ids) || block.image_ref_ids.length > 32 || block.image_ref_ids.some(item => !validId(item))) {
      throw new ReviewAgentError("invalid_review_request", 400);
    }
    return {
      block_id: block.block_id,
      kind: String(block.kind),
      order: index,
      text: block.text,
      text_hash: block.text_hash,
      claim_ids: [...block.claim_ids] as string[],
      image_ref_ids: [...block.image_ref_ids] as string[],
    };
  });
  if (!Array.isArray(payload.blocks) || canonical(payload.blocks) !== canonical(blocks)) throw new ReviewAgentError("input_payload_blocks_conflict", 409);
  validateClaimLedger(payload.claim_ledger, blocks);
  if (record.body !== blocks.map(block => block.text).join("\n\n")) throw new ReviewAgentError("invalid_review_request", 400);
  for (const block of blocks) {
    if (block.text_hash !== await sha256(block.text)) throw new ReviewAgentError("invalid_review_request", 400);
  }
  return {
    protocol_version: REVIEW_PROTOCOL_VERSION,
    article_id: record.article_id,
    run_id: record.run_id,
    input_artifact_id: record.input_artifact_id,
    input_payload_hash: record.input_payload_hash,
    input_payload: payload,
    recording_id: Number(record.recording_id),
    review_round: record.review_round,
    title: record.title,
    body: record.body,
    blocks,
  };
}

async function reviewDraft(input: ReviewDraftRequest): Promise<ReviewReport> {
  const findings: ReviewReport["findings"] = [];
  const blocks = [{ block_id: "@title", text: input.title }, ...input.blocks];
  const evidenceFor = async (text: string) => ({ text_hash: await sha256(text), start: 0, end: text.length });
  const findingFor = async (severity: "P0" | "P1" | "P2", code: string, target: string, text: string, suggestedAction: string | null, requiresHuman: boolean) => ({
    finding_id: `finding_${(await sha256(`${input.input_artifact_id}:${code}:${target}`)).slice(-24)}`,
    severity,
    code,
    target,
    evidence: await evidenceFor(text),
    evidence_hash: await sha256(text),
    suggested_action: suggestedAction,
    requires_human: requiresHuman,
  });
  for (const block of blocks) {
    const text = block.text;
    if (/(身份证|银行卡|密码|api[_ -]?key|authorization|bearer\s+)/i.test(text)) {
      findings.push(await findingFor("P0", "privacy_or_credential_risk", block.block_id, text, "remove_sensitive_data", true));
    }
    if (/(作为AI|在当今社会|综上所述|值得注意的是)/.test(text)) {
      findings.push(await findingFor("P1", "ai_style_signal", block.block_id, text, "remove_ai_cue", false));
    }
  }
  if (/\b\d{4}-\d{1,2}-\d{1,2}\b/.test(input.body)) {
    findings.push(await findingFor("P2", "date_claim_requires_source_check", "@body", input.body, "verify_claim_if_external", false));
  }
  const hasP0 = findings.some(finding => finding.severity === "P0");
  const p1Findings = findings.filter(finding => finding.severity === "P1");
  const hasP1 = p1Findings.length > 0;
  const decision = hasP0 || input.review_round === 2 && hasP1
    ? "block"
    : hasP1
      ? "revise"
      : "pass";
  const target = [...new Set(p1Findings.map(finding => finding.target))].sort();
  const targetBlockIds = target.filter(value => value !== "@title");
  return {
    article_id: input.article_id,
    run_id: input.run_id,
    input_artifact_id: input.input_artifact_id,
    input_payload_hash: input.input_payload_hash,
    recording_id: input.recording_id,
    review_round: input.review_round,
    decision,
    findings,
    revision_targets: target,
    suggested_actions: [...new Set(p1Findings.map(finding => finding.suggested_action).filter((value): value is string => Boolean(value)))],
    reviewer_version: REVIEWER_VERSION,
    rules_pins: REVIEW_RULE_PINS,
  };
}

export function createReviewAgentWorker() {
  return {
    async fetch(request: Request, env: ReviewEnv): Promise<Response> {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/internal/v3/review") return json({ error: { code: "not_found" } }, 404);
      const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || request.headers.get("x-review-agent-token")?.trim() || "";
      if (!env.REVIEW_AGENT_TOKEN || !await secureEquals(env.REVIEW_AGENT_TOKEN, token)) return json({ error: { code: "unauthorized" } }, 401);
      try {
        const input = await normalizeRequest(await request.json());
        return json({ protocol_version: REVIEW_PROTOCOL_VERSION, result: await reviewDraft(input) }, 200);
      } catch (error) {
        if (error instanceof ReviewAgentError) return json({ error: { code: error.code } }, error.status);
        return json({ error: { code: "review_failed" } }, 500);
      }
    },
  };
}

export default createReviewAgentWorker();
