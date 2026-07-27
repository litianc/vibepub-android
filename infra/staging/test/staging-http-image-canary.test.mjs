import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  buildCanaryGrant,
  deriveCanaryIdentity,
  renderCanaryConfigs,
  StagingHttpCanaryError,
  validateCanaryGrant,
  verifyCanaryConfigs,
  writeCanaryConfigs,
} from "../staging-http-image-canary.mjs";
import {
  probeClosedCanary,
  startCanaryHandoff,
  StagingHttpCanaryRequestError,
} from "../staging-http-image-canary-request.mjs";
import {
  queryStagingD1,
  StagingD1QueryError,
  validateReadOnlySql,
} from "../query-staging-d1.mjs";

const fixture = JSON.parse(await readFile(new URL("../fixtures/staging-resource-manifest.synthetic.json", import.meta.url), "utf8"));
const workflow = await readFile(new URL("../../../.github/workflows/wave2e-http-image-canary.yml", import.meta.url), "utf8");

function sourceFixture() {
  const filename = "VibePub-2026-07-28-Text-canary.txt";
  const payload = {
    filename,
    userId: "canary_user",
    workspaceId: "canary_workspace",
    text: "用户说挺好，往往意味着你问错了。\n\n真正的问题要让对方讲出最近一次具体经历。",
    titleHint: "用户说挺好，往往意味着你问错了",
    source: "staging_canary",
    submittedAt: "2026-07-28T00:00:00.000Z",
    styleProfileId: null,
    styleProfileVersion: null,
    styleProfileName: null,
    styleProfileDescription: null,
    styleProfileBody: null,
    layoutProfileId: null,
    layoutProfileVersion: null,
  };
  const sourceKey = `users/canary_user/text-submissions/${filename}`;
  const recording = [{
    id: 42,
    user_id: "canary_user",
    workspace_id: "canary_workspace",
    filename,
    r2_key: sourceKey,
    source_type: "TEXT",
    article_title: payload.titleHint,
    style_profile_id: null,
    style_profile_version: null,
    layout_profile_id: null,
    layout_profile_version: null,
  }];
  return { payload, sourceKey, recording, sourceBytes: Buffer.from(JSON.stringify(payload, null, 2)) };
}

function identityFixture() {
  const source = sourceFixture();
  return deriveCanaryIdentity({
    sourceBytes: source.sourceBytes,
    recording: source.recording,
    sourceKey: source.sourceKey,
    userId: "canary_user",
    workspaceId: "canary_workspace",
  });
}

function errorCode(callback) {
  assert.throws(callback, error => error instanceof StagingHttpCanaryError);
  try { callback(); } catch (error) { return error.code; }
  throw new Error("expected canary error");
}

test("derives one deterministic staging run and handoff identity from exact source bytes", () => {
  const first = identityFixture();
  const second = identityFixture();
  assert.deepEqual(first, second);
  assert.match(first.source_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.transcript_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.article_id, /^article_v3_[a-f0-9]{64}$/);
  assert.match(first.handoff_id, /^handoff_v3_[a-f0-9]{64}$/);
  assert.match(first.run_id, /^run_v3_[a-f0-9]{64}$/);
});

test("rejects source hash, owner, profile, and recording drift before rendering", () => {
  const source = sourceFixture();
  const base = {
    sourceBytes: source.sourceBytes,
    recording: source.recording,
    sourceKey: source.sourceKey,
    userId: "canary_user",
    workspaceId: "canary_workspace",
  };
  assert.equal(errorCode(() => deriveCanaryIdentity({ ...base, expectedSourceHash: `sha256:${"0".repeat(64)}` })), "canary_source_hash_conflict");
  assert.equal(errorCode(() => deriveCanaryIdentity({ ...base, workspaceId: "other_workspace" })), "canary_recording_invalid");
  assert.equal(errorCode(() => deriveCanaryIdentity({ ...base, recording: [{ ...source.recording[0], style_profile_id: "custom" }] })), "canary_profile_invalid");
});

test("renders only the exact scoped main and image canary while WeChat stays off", () => {
  const now = new Date();
  const identity = identityFixture();
  const grant = buildCanaryGrant(identity, { now, grantSeed: "unit-test", maxOperations: 3 });
  const configs = renderCanaryConfigs(fixture, grant, "dry-run", "/tmp/vibepub-http-canary-test");
  assert.match(configs["main.wrangler.toml"], /FIVE_AGENT_PUBLISHING_V3 = "true"/);
  assert.match(configs["main.wrangler.toml"], /FIVE_AGENT_PUBLISHING_V3_ALLOWLIST = "canary_user:canary_workspace"/);
  assert.match(configs["main.wrangler.toml"], /VISUAL_PRODUCTION_V3 = "true"/);
  assert.match(configs["main.wrangler.toml"], new RegExp(`STAGING_HTTP_IMAGE_CANARY_RUN_ID = "${identity.run_id}"`));
  assert.match(configs["main.wrangler.toml"], /STAGING_HTTP_IMAGE_CANARY_EXPIRES_AT = "/);
  assert.match(configs["main.wrangler.toml"], /WECHAT_DRAFT_SYNC_V3 = "false"/);
  assert.match(configs["image.wrangler.toml"], /IMAGE_PROVIDER_URL = "http:\/\/23\.105\.194\.173:8881\/v1\/images\/generations"/);
  assert.match(configs["image.wrangler.toml"], new RegExp(`IMAGE_PROVIDER_INSECURE_HTTP_RUN_ID = "${identity.run_id}"`));
  assert.match(configs["image.wrangler.toml"], /IMAGE_PROVIDER_INSECURE_HTTP_MAX_OPERATIONS = "3"/);
  assert.doesNotMatch(JSON.stringify(configs), /sk-[a-z0-9]/i);
});

test("rejects expired, overlong, wrong-provider, and over-budget grants", () => {
  const now = new Date();
  const identity = identityFixture();
  const valid = buildCanaryGrant(identity, { now, grantSeed: "unit-test" });
  const expired = { ...valid, expires_at: new Date(now.getTime() - 1).toISOString() };
  assert.equal(errorCode(() => validateCanaryGrant(expired, now)), "canary_expiry_invalid");
  const overlong = { ...valid, expires_at: new Date(now.getTime() + 60 * 60 * 1000 + 1).toISOString() };
  assert.equal(errorCode(() => validateCanaryGrant(overlong, now)), "canary_expiry_invalid");
  const provider = { ...valid, provider: { ...valid.provider, url: "http://23.105.194.173:8880/v1/images/generations" } };
  assert.equal(errorCode(() => validateCanaryGrant(provider, now)), "canary_provider_invalid");
  const budget = { ...valid, max_requests: 10 };
  assert.equal(errorCode(() => validateCanaryGrant(budget, now)), "canary_budget_invalid");
});

test("writes and verifies canary configs and detects any post-render drift", async () => {
  const output = await mkdtemp(resolve(tmpdir(), "vibepub-http-canary-"));
  const grant = buildCanaryGrant(identityFixture(), { grantSeed: "write-test" });
  await writeCanaryConfigs(fixture, grant, output, "dry-run");
  await verifyCanaryConfigs(fixture, grant, output, "dry-run");
  await writeFile(resolve(output, "image.wrangler.toml"), "tampered\n", "utf8");
  await assert.rejects(() => verifyCanaryConfigs(fixture, grant, output, "dry-run"), error => error instanceof StagingHttpCanaryError && error.code === "canary_render_conflict");
});

test("protected canary workflow always restores main before image and proves flag-off", () => {
  assert.match(workflow, /environment: vibepub-staging/);
  assert.match(workflow, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(workflow, /Require workflow dispatch from the repository default branch/);
  assert.match(workflow, /concurrency:\n[\s\S]*vibepub-staging-deploy/);
  assert.match(workflow, /Attest the exact staging origin to this Cloudflare account[\s\S]*attest-staging-origin\.mjs --fetch/);
  assert.match(workflow, /STAGING_ATTESTED_BASE_URL/);
  assert.match(workflow, /Prove the attested origin serves this exact reviewed deployment/);
  assert.match(workflow, /Prove staging cannot trigger the production Mining workflow[\s\S]*GITHUB_PAT must be absent/);
  assert.equal(workflow.match(/query-staging-d1\.mjs/g)?.length, 5);
  assert.doesNotMatch(workflow, /wrangler d1 execute/);
  assert.match(workflow, /canary run already exists/);
  assert.match(workflow, /started\.status !== 202|staging-http-image-canary-request\.mjs start/);
  assert.match(workflow, /Close the main user and visual gates\n\s+if: always\(\)/);
  assert.match(workflow, /Remove the HTTP provider configuration\n\s+if: always\(\)/);
  assert.ok(workflow.indexOf("Close the main user and visual gates") < workflow.indexOf("Remove the HTTP provider configuration"));
  assert.ok(workflow.indexOf("Remove the HTTP provider configuration") < workflow.indexOf("Capture non-secret D1 evidence after cleanup"));
  assert.match(workflow, /Prove the marker is held after the flag-off restore/);
  assert.doesNotMatch(workflow, /WECHAT_DRAFT_SYNC_V3:true/);
  assert.doesNotMatch(workflow, /\bcurl\b/);
  assert.doesNotMatch(workflow, /Authorization: Bearer/);
});

test("queries the exact protected staging D1 through a bounded read-only API call", async () => {
  const manifest = {
    ...fixture,
    mode: "deploy",
    main: {
      ...fixture.main,
      public_base_url: "https://vibepub-api-staging.example.workers.dev",
    },
  };
  let observed;
  const result = await queryStagingD1({
    manifest,
    sql: "SELECT id, state FROM publication_runs WHERE run_id = 'run_v3_test';",
    accountId: "a".repeat(32),
    apiToken: "synthetic-cloudflare-token",
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return new Response(JSON.stringify({
        success: true,
        result: [{ success: true, results: [{ id: 1, state: "visual_ready" }], meta: {} }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(result[0].results, [{ id: 1, state: "visual_ready" }]);
  assert.equal(observed.url, `https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/d1/database/${fixture.main.d1.id}/query`);
  assert.equal(observed.init.headers.authorization, "Bearer synthetic-cloudflare-token");
  assert.equal(observed.init.redirect, "error");
  assert.deepEqual(JSON.parse(observed.init.body), { sql: "SELECT id, state FROM publication_runs WHERE run_id = 'run_v3_test'" });
});

test("rejects mutations, comments, multiple statements, and non-deploy manifests before D1 fetch", async () => {
  const deployManifest = {
    ...fixture,
    mode: "deploy",
    main: {
      ...fixture.main,
      public_base_url: "https://vibepub-api-staging.example.workers.dev",
    },
  };
  for (const sql of [
    "UPDATE publication_runs SET state = 'failed'",
    "SELECT 1; SELECT 2",
    "SELECT 1 -- comment",
  ]) {
    assert.throws(() => validateReadOnlySql(sql), error => error instanceof StagingD1QueryError);
  }
  let calls = 0;
  await assert.rejects(() => queryStagingD1({
    manifest: fixture,
    sql: "SELECT 1",
    accountId: "a".repeat(32),
    apiToken: "synthetic-cloudflare-token",
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}");
    },
  }), error => error instanceof StagingD1QueryError && error.code === "staging_d1_manifest_invalid");
  assert.equal(calls, 0);

  const disguisedProduction = {
    ...deployManifest,
    main: {
      ...deployManifest.main,
      d1: { name: "arbitrary-staging", id: "0804a462-4413-4eaf-bfab-60531eef06be" },
    },
    wechat: {
      ...deployManifest.wechat,
      d1: { name: "arbitrary-staging", id: "0804a462-4413-4eaf-bfab-60531eef06be" },
    },
  };
  await assert.rejects(() => queryStagingD1({
    manifest: disguisedProduction,
    sql: "SELECT 1",
    accountId: "a".repeat(32),
    apiToken: "synthetic-cloudflare-token",
    fetchImpl: async () => {
      calls += 1;
      return new Response("{}");
    },
  }), error => error instanceof StagingD1QueryError && error.code === "staging_d1_manifest_invalid");
  assert.equal(calls, 0);
});

test("uses an environment-only token and accepts only a fresh handoff start", async () => {
  const identity = identityFixture();
  const canary = { identity, grant: buildCanaryGrant(identity, { grantSeed: "request-test" }) };
  const calls = [];
  const responses = [
    new Response(JSON.stringify({ decision: "v3", handoff_id: identity.handoff_id }), { status: 200 }),
    new Response(JSON.stringify({ decision: "accepted", run_id: identity.run_id, replayed: false }), { status: 202 }),
  ];
  const result = await startCanaryHandoff({
    baseUrl: "https://vibepub-api-staging.example.workers.dev",
    attestedBaseUrl: "https://vibepub-api-staging.example.workers.dev",
    canary,
    token: "synthetic-mining-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    },
  });
  assert.equal(result.started.run_id, identity.run_id);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.init.redirect === "manual"));
  assert.ok(calls.every(call => call.init.headers.authorization === "Bearer synthetic-mining-token"));

  await assert.rejects(() => startCanaryHandoff({
    baseUrl: "https://vibepub-api-staging.example.workers.dev",
    attestedBaseUrl: "https://vibepub-api-staging.example.workers.dev",
    canary,
    token: "synthetic-mining-token",
    fetchImpl: async (_url, init) => new Response(JSON.stringify(
      JSON.parse(init.body).handoff_id
        ? { decision: "accepted", run_id: identity.run_id, replayed: true }
        : { decision: "v3", handoff_id: identity.handoff_id },
    ), { status: JSON.parse(init.body).handoff_id ? 200 : 200 }),
  }), error => error instanceof StagingHttpCanaryRequestError && error.code === "canary_start_replayed_or_invalid");

  let mismatchedOriginCalls = 0;
  await assert.rejects(() => startCanaryHandoff({
    baseUrl: "https://vibepub-api-staging.example.workers.dev",
    attestedBaseUrl: "https://other-staging.example.workers.dev",
    canary,
    token: "synthetic-mining-token",
    fetchImpl: async () => {
      mismatchedOriginCalls += 1;
      return new Response("{}", { status: 200 });
    },
  }), error => error instanceof StagingHttpCanaryRequestError && error.code === "canary_base_url_invalid");
  assert.equal(mismatchedOriginCalls, 0);
});

test("proves the exact marker is held after cleanup", async () => {
  const identity = identityFixture();
  const canary = { identity, grant: buildCanaryGrant(identity, { grantSeed: "probe-test" }) };
  const result = await probeClosedCanary({
    baseUrl: "https://vibepub-api-staging.example.workers.dev",
    attestedBaseUrl: "https://vibepub-api-staging.example.workers.dev",
    canary,
    token: "synthetic-mining-token",
    fetchImpl: async () => new Response(JSON.stringify({ decision: "v3_hold", reason: "v3_disabled_after_marker" }), { status: 202 }),
  });
  assert.equal(result.reason, "v3_disabled_after_marker");
});
