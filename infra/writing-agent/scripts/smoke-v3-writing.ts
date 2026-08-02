import {
  runV3WritingAdapter,
  V3_PROTOCOL_VERSION,
  V3WritingError,
  type V3WriteRequest,
} from "../src/v3Adapter";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function arrayShape(value: unknown): { type: string; count?: number } {
  return Array.isArray(value) ? { type: "array", count: value.length } : { type: typeof value };
}

function modelShape(value: unknown): JsonRecord {
  const payload = record(value);
  if (!payload) return { type: Array.isArray(value) ? "array" : typeof value };
  const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
  const claims = Array.isArray(payload.claim_ledger) ? payload.claim_ledger : [];
  return {
    type: "object",
    keys: Object.keys(payload).sort(),
    title_type: typeof payload.title,
    body_type: typeof payload.body,
    title_candidates: arrayShape(payload.title_candidates),
    selected_title_type: typeof payload.selected_title,
    selected_title_matches_title: payload.selected_title === payload.title,
    cover_title: arrayShape(payload.cover_title),
    blocks: {
      ...arrayShape(payload.blocks),
      items: blocks.slice(0, 20).map((item, index) => {
        const block = record(item);
        return block ? {
          index,
          keys: Object.keys(block).sort(),
          block_id_exact: block.block_id === `block_v1_${index + 1}`,
          kind: block.kind,
          order: block.order,
          text_type: typeof block.text,
          text_length: typeof block.text === "string" ? block.text.length : null,
          claim_ids: arrayShape(block.claim_ids),
          image_ref_ids: arrayShape(block.image_ref_ids),
        } : { index, type: Array.isArray(item) ? "array" : typeof item };
      }),
    },
    claim_ledger: {
      ...arrayShape(payload.claim_ledger),
      items: claims.slice(0, 50).map(item => {
        const claim = record(item);
        return claim ? {
          keys: Object.keys(claim).sort(),
          claim_id_type: typeof claim.claim_id,
          block_id_type: typeof claim.block_id,
          classification: claim.classification,
          verification_status: claim.verification_status,
        } : { type: Array.isArray(item) ? "array" : typeof item };
      }),
    },
  };
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

const sourceText = "我们做一个简单的测试。";
const request: V3WriteRequest = {
  protocol_version: V3_PROTOCOL_VERSION,
  job_id: "v3_contract_smoke",
  idempotency_key: "v3_contract_smoke:1",
  mode: "initial",
  article_id: "article_v3_contract_smoke",
  run_id: "run_v3_contract_smoke",
  recording_id: 1,
  source_text: sourceText,
  source_hash: await hash("synthetic original recording bytes"),
  source_text_hash: await hash(sourceText),
  formatting_skill_id: "md_to_wechat",
  formatting_skill_version: "1.0.0",
  style_profile_id: "style_litianc_default",
  style_profile_version: "2026-07-05",
};

const tracedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const envelope = await response.clone().json().catch(() => null) as JsonRecord | null;
  const message = record(Array.isArray(envelope?.choices) ? envelope.choices[0] : null)?.message;
  const content = record(message)?.content;
  let payload: unknown = null;
  if (typeof content === "string") {
    try { payload = JSON.parse(content); } catch { payload = { invalid_json: true, content_length: content.length }; }
  }
  console.log(JSON.stringify({
    http_status: response.status,
    content_type: typeof content,
    model_shape: modelShape(payload),
  }));
  return response;
};

try {
  const result = await runV3WritingAdapter({
    GLM_API_KEY: process.env.GLM_API_KEY,
    GLM_BASE_URL: process.env.GLM_BASE_URL,
    GLM_MODEL: process.env.GLM_MODEL,
  }, request, tracedFetch);
  console.log(JSON.stringify({ ok: true, block_count: result.blocks.length, claim_count: result.claim_ledger.length }));
} catch (error) {
  if (error instanceof V3WritingError) {
    console.error(JSON.stringify({ ok: false, error_code: error.code, status: error.status, retryable: error.retryable }));
  }
  throw error;
}
