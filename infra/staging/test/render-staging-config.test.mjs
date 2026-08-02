import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { renderConfigs, StagingManifestError, validateManifest, verifyRenderedConfigs, writeRenderedConfigs } from "../render-staging-config.mjs";
import { STAGING_DATA_ATTESTATION, validateStagingDataAttestation } from "../validate-staging-data-attestation.mjs";
import { validateStagingMiningReadiness } from "../validate-staging-mining-readiness.mjs";
import { fetchWorkersSubdomain, validateStagingOriginAttestation } from "../attest-staging-origin.mjs";
import { deploymentEvidence, requireActiveDeploymentEvidence } from "../record-staging-deployment-evidence.mjs";
import { captureDeploymentBaseline } from "../capture-staging-deployment-baseline.mjs";
import { verifyStagingHealth } from "../verify-staging-health.mjs";

const fixturePath = new URL("../fixtures/staging-resource-manifest.synthetic.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

function clone() {
  return structuredClone(fixture);
}

function deployManifest() {
  const value = clone();
  value.mode = "deploy";
  value.main.public_base_url = "https://vibepub-api-staging.account-staging.workers.dev";
  return value;
}

function dataEvidence() {
  return {
    schema_version: "vibepub-staging-data-evidence.v1",
    main: {
      database_name: "vibepub-db-staging",
      database_id: "11111111-1111-4111-8111-111111111111",
      backup_id: "d1-backup-main-20260722",
      applied_migrations: [
        "0001_dedupe_recordings", "0002_recording_experience_fields", "0003_recording_processing_stage",
        "0004_recording_duration_ms", "0005_recording_cover_image_url", "0006_recording_source_type",
        "0007_recording_style_profiles", "0008_multi_user_auth", "0009_mining_input_claims",
        "0010_editorial_visual_pipeline", "0011_five_agent_publication_projection",
      ],
      schema_evidence_hash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    writing: {
      database_name: "writing-agent-db-staging",
      database_id: "22222222-2222-4222-8222-222222222222",
      backup_id: "d1-backup-writing-20260722",
      applied_migrations: ["0001_style_profiles"],
      schema_evidence_hash: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  };
}

function errorCode(callback) {
  assert.throws(callback, error => error instanceof StagingManifestError);
  try { callback(); } catch (error) { return error.code; }
  throw new Error("expected manifest error");
}

test("renders five complete isolated staging Wrangler targets from a synthetic manifest", async () => {
  const output = await mkdtemp(resolve(tmpdir(), "vibepub-staging-config-"));
  const paths = await writeRenderedConfigs(clone(), output, "dry-run");
  assert.equal(paths.length, 5);
  const configs = Object.fromEntries(await Promise.all(paths.map(async path => [path.split("/").at(-1), await readFile(path, "utf8")] )));

  assert.match(configs["main.wrangler.toml"], /name = "vibepub-api-staging"/);
  assert.match(configs["main.wrangler.toml"], /main = "\.\.\/.*infra\/worker\/src\/index\.ts"/);
  assert.match(configs["main.wrangler.toml"], /workers_dev = true\npreview_urls = false/);
  assert.match(configs["main.wrangler.toml"], /\[limits\]\ncpu_ms = 10_000/);
  assert.doesNotMatch(configs["main.wrangler.toml"], /^routes\s*=/m);
  assert.match(configs["main.wrangler.toml"], /FIVE_AGENT_PUBLISHING_V3 = "false"/);
  assert.match(configs["main.wrangler.toml"], /WECHAT_DRAFT_SYNC_V3_ALLOWLIST = ""/);
  assert.match(configs["main.wrangler.toml"], /WECHAT_MEDIA_URL_HOST_ALLOWLIST = ""/);
  assert.match(configs["main.wrangler.toml"], /service = "writing-agent-staging"/);
  assert.match(configs["main.wrangler.toml"], /name = "five-agent-publishing-workflow-staging"/);
  for (const name of ["writing.wrangler.toml", "review.wrangler.toml", "image.wrangler.toml", "wechat.wrangler.toml"]) {
    assert.match(configs[name], /workers_dev = false/);
    assert.match(configs[name], /preview_urls = false/);
    assert.doesNotMatch(configs[name], /vibepub-db"\n.*0804a462-4413-4eaf-bfab-60531eef06be/s);
  }
  for (const content of Object.values(configs)) assert.doesNotMatch(content, /\[env\./);
});

test("rejects missing fields and non-staging resource names", () => {
  const missing = clone();
  delete missing.main.workflows;
  assert.equal(errorCode(() => validateManifest(missing)), "manifest_shape_invalid");

  const productionName = clone();
  productionName.image.name = "image-generation-adapter";
  assert.equal(errorCode(() => validateManifest(productionName)), "staging_resource_name_invalid");
});

test("rejects checked-in production resource overlap and mismatched staging service bindings", () => {
  const productionOverlap = clone();
  productionOverlap.main.d1.id = "0804a462-4413-4eaf-bfab-60531eef06be";
  assert.equal(errorCode(() => validateManifest(productionOverlap)), "staging_resource_id_invalid");

  const serviceConflict = clone();
  serviceConflict.main.services.wechat = "other-adapter-staging";
  assert.equal(errorCode(() => validateManifest(serviceConflict)), "staging_service_binding_conflict");
});

test("rejects synthetic or placeholder deployment manifests", () => {
  assert.equal(errorCode(() => validateManifest(clone(), "deploy")), "synthetic_deploy_forbidden");

  const placeholder = clone();
  placeholder.mode = "deploy";
  placeholder.main.public_base_url = "https://vibepub-staging.invalid";
  assert.equal(errorCode(() => validateManifest(placeholder, "deploy")), "placeholder_deploy_forbidden");
});

test("rejects enabled V3 flags, populated allowlists, production routes, and credentials", () => {
  const enabled = clone();
  enabled.main.v3_flags.visual = true;
  assert.equal(errorCode(() => validateManifest(enabled)), "staging_flags_must_be_off");

  const allowlisted = clone();
  allowlisted.main.allowlists.wechat_draft = "user:workspace";
  assert.equal(errorCode(() => validateManifest(allowlisted)), "staging_allowlists_must_be_empty");

  const routed = clone();
  routed.main.routes = [{ pattern: "vibepub.litianc.cn", custom_domain: true }];
  assert.equal(errorCode(() => validateManifest(routed)), "production_route_forbidden");

  const credential = clone();
  credential.main.api_key = "sk-test-not-allowed";
  assert.equal(errorCode(() => validateManifest(credential)), "manifest_secret_forbidden");

  const credentialValue = clone();
  credentialValue.review.name = "sk-live-value-not-allowed";
  assert.equal(errorCode(() => validateManifest(credentialValue)), "manifest_secret_forbidden");
});

test("rendering is deterministic and never writes generated files into the repository", () => {
  const first = renderConfigs(clone());
  const second = renderConfigs(clone());
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), [
    "image.wrangler.toml",
    "main.wrangler.toml",
    "review.wrangler.toml",
    "wechat.wrangler.toml",
    "writing.wrangler.toml",
  ]);
});

test("renders source paths relative to the target config directory", () => {
  const tempOutput = "/tmp/vibepub-wave2e-rendered-config";
  const configs = renderConfigs(clone(), "dry-run", tempOutput);
  assert.match(configs["writing.wrangler.toml"], /main = "\.\.\/.*infra\/writing-agent\/src\/index\.ts"/);
  assert.doesNotMatch(configs["writing.wrangler.toml"], /main = "\.\.\/\.\.\/writing-agent\/src\/index\.ts"/);
});

test("requires an exact workers.dev staging public origin outside the synthetic dry-run fixture", () => {
  const deploy = deployManifest();
  assert.equal(validateManifest(deploy, "deploy").main.public_base_url, deploy.main.public_base_url);
  assert.equal(deploy.main.public_base_url, "https://vibepub-api-staging.account-staging.workers.dev");

  for (const value of [
    "https://wrong-staging.account-staging.workers.dev",
    "https://vibepub-api-staging.account-staging.workers.dev/path",
    "https://vibepub-api-staging.account-staging.workers.dev./",
    "https://vibepub-api-staging.localhost.workers.dev",
    "https://vibepub.litianc.cn",
    "https://api.vibepub.litianc.cn",
    "https://localhost",
    "https://127.0.0.1",
  ]) {
    const invalid = structuredClone(deploy);
    invalid.main.public_base_url = value;
    assert.equal(errorCode(() => validateManifest(invalid, "deploy")), "staging_public_base_invalid", value);
  }
});

test("binds the protected staging origin to the exact account-scoped Workers subdomain", () => {
  const manifest = deployManifest();
  const accountId = "0123456789abcdef0123456789abcdef";
  const response = { success: true, result: { subdomain: "account-staging" } };
  assert.deepEqual(
    validateStagingOriginAttestation(manifest, manifest.main.public_base_url, accountId, response),
    { manifest_sha_bound: true, origin_attested: true },
  );

  for (const [expectedOrigin, id, apiResponse, expectedCode] of [
    ["https://vibepub-api-staging.other-account.workers.dev", accountId, response, "staging_origin_mismatch"],
    [manifest.main.public_base_url, "not-an-account-id", response, "staging_account_id_invalid"],
    [manifest.main.public_base_url, accountId, { success: true, result: { subdomain: "other-account" } }, "staging_workers_subdomain_mismatch"],
    [manifest.main.public_base_url, accountId, { success: false, result: { subdomain: "account-staging" } }, "staging_workers_subdomain_mismatch"],
  ]) {
    assert.equal(
      errorCode(() => validateStagingOriginAttestation(manifest, expectedOrigin, id, apiResponse)),
      expectedCode,
    );
  }
});

test("fetches the account Workers subdomain without putting the API token in arguments", async () => {
  const accountId = "a".repeat(32);
  let seen = null;
  const response = await fetchWorkersSubdomain(accountId, "synthetic-cloudflare-token", async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ success: true, result: { subdomain: "account-staging" } }), { status: 200 });
  });
  assert.deepEqual(response, { success: true, result: { subdomain: "account-staging" } });
  assert.equal(seen.url, `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`);
  assert.equal(seen.init.redirect, "manual");
  assert.equal(seen.init.headers.authorization, "Bearer synthetic-cloudflare-token");
});

test("rejects staging resource aliases and validates the exact dynamic render before deploy", async () => {
  const duplicateWorker = clone();
  duplicateWorker.review.name = duplicateWorker.writing.name;
  duplicateWorker.main.services.review = duplicateWorker.writing.name;
  assert.equal(errorCode(() => validateManifest(duplicateWorker)), "staging_worker_name_conflict");

  const duplicateBucket = clone();
  duplicateBucket.wechat.results_bucket = duplicateBucket.image.results_bucket;
  assert.equal(errorCode(() => validateManifest(duplicateBucket)), "staging_bucket_name_conflict");

  const duplicateWorkflow = clone();
  duplicateWorkflow.main.workflows.five_agent = duplicateWorkflow.main.workflows.editorial;
  assert.equal(errorCode(() => validateManifest(duplicateWorkflow)), "staging_workflow_name_conflict");

  const dbAlias = clone();
  dbAlias.writing.d1.id = dbAlias.main.d1.id;
  assert.equal(errorCode(() => validateManifest(dbAlias)), "staging_main_writing_database_conflict");

  const output = await mkdtemp(resolve(tmpdir(), "vibepub-staging-verify-"));
  await writeRenderedConfigs(clone(), output);
  await assert.doesNotReject(() => verifyRenderedConfigs(clone(), output));
  await writeFile(resolve(output, "main.wrangler.toml"), "tampered", "utf8");
  await assert.rejects(() => verifyRenderedConfigs(clone(), output), error => error.code === "staging_rendered_config_conflict");
});

test("requires protected additive-D1 evidence before an approved staging deployment", () => {
  const manifest = deployManifest();
  const evidence = dataEvidence();
  const summary = validateStagingDataAttestation(manifest, evidence, STAGING_DATA_ATTESTATION);
  assert.equal(summary.main_migrations.at(-1), "0011_five_agent_publication_projection");
  assert.deepEqual(summary.writing_migrations, ["0001_style_profiles"]);

  assert.equal(errorCode(() => validateStagingDataAttestation(manifest, evidence, "approved")), "staging_data_attestation_required");
  const missingBackup = dataEvidence();
  missingBackup.main.backup_id = "";
  assert.equal(errorCode(() => validateStagingDataAttestation(manifest, missingBackup, STAGING_DATA_ATTESTATION)), "staging_data_evidence_invalid");
  const wrongMigration = dataEvidence();
  wrongMigration.main.applied_migrations.pop();
  assert.equal(errorCode(() => validateStagingDataAttestation(manifest, wrongMigration, STAGING_DATA_ATTESTATION)), "staging_data_migration_mismatch");
});

test("Mining readiness is schema-exact, staging-only, and binds the approved main origin and R2 bucket", () => {
  const manifest = deployManifest();
  const readiness = {
    schema_version: "vibepub-staging-mining-readiness.v1",
    environment: "staging",
    public_base_url: manifest.main.public_base_url,
    r2_bucket_name: manifest.main.files_bucket,
    handoff_enabled: true,
    unscheduled: true,
  };
  assert.deepEqual(validateStagingMiningReadiness(manifest, readiness), {
    public_base_url: manifest.main.public_base_url,
    r2_bucket_name: manifest.main.files_bucket,
  });
  for (const mutate of [
    value => { value.handoff_enabled = false; },
    value => { value.environment = "production"; },
    value => { value.public_base_url = "https://other.account-staging.workers.dev"; },
    value => { value.extra = true; },
  ]) {
    const invalid = structuredClone(readiness);
    mutate(invalid);
    assert.equal(errorCode(() => validateStagingMiningReadiness(manifest, invalid)), "staging_mining_config_invalid");
  }
});

test("records structurally proven deployment identifiers and requires one fully active version after deploy", () => {
  assert.deepEqual(deploymentEvidence([]), { active_deployment_id: null, created_on: null, active_versions: [] });
  assert.throws(() => requireActiveDeploymentEvidence(deploymentEvidence([])), /exactly one active version at 100 percent/);
  const active = deploymentEvidence([
    { id: "active", created_on: "2026-07-22T11:00:00Z", versions: [{ version_id: "version-100", percentage: 100 }] },
  ]);
  assert.deepEqual(requireActiveDeploymentEvidence(active), active);
  assert.deepEqual(deploymentEvidence([
    { id: "older", created_on: "2026-07-21T10:00:00Z", versions: [{ version_id: "old-version", percentage: 100 }] },
    { id: "newer", created_on: "2026-07-22T10:00:00Z", versions: [{ version_id: "canary", percentage: 10 }, { version_id: "stable", percentage: 90 }] },
  ]), {
    active_deployment_id: "newer",
    created_on: "2026-07-22T10:00:00Z",
    active_versions: [{ version_id: "canary", percentage: 10 }, { version_id: "stable", percentage: 90 }],
  });
  assert.throws(() => deploymentEvidence({}), /unsupported JSON shape/);
  assert.throws(() => deploymentEvidence([{ id: "missing-version", created_on: "2026-07-22T10:00:00Z", versions: [] }]), /non-empty versions/);
  assert.throws(() => deploymentEvidence([{ id: "", created_on: "2026-07-22T10:00:00Z", versions: [{ version_id: "version", percentage: 100 }] }]), /missing id/);
  assert.throws(() => deploymentEvidence([{ id: "empty-version", created_on: "2026-07-22T10:00:00Z", versions: [{ version_id: "", percentage: 100 }] }]), /invalid active version/);
  for (const versions of [
    [{ version_id: "canary", percentage: 10 }, { version_id: "stable", percentage: 90 }],
    [{ version_id: "first", percentage: 50 }, { version_id: "second", percentage: 50 }],
    [{ version_id: "inactive", percentage: 0 }, { version_id: "active", percentage: 100 }],
    [{ version_id: "duplicate", percentage: 50 }, { version_id: "duplicate", percentage: 50 }],
    [{ version_id: "inactive", percentage: 0 }],
  ]) {
    const split = deploymentEvidence([{ id: "split", created_on: "2026-07-22T12:00:00Z", versions }]);
    assert.throws(() => requireActiveDeploymentEvidence(split), /exactly one active version at 100 percent/);
  }
  assert.deepEqual(captureDeploymentBaseline(1, "", "Error code 10007: Worker script not found"), {
    active_deployment_id: null,
    created_on: null,
    active_versions: [],
    first_deployment: true,
  });
  assert.deepEqual(captureDeploymentBaseline(1, "", "workers.api.error.script_not_found [code: 10007]"), {
    active_deployment_id: null,
    created_on: null,
    active_versions: [],
    first_deployment: true,
  });
  assert.throws(() => captureDeploymentBaseline(1, "", "workers.api.error.script_not_found [code: 10008]"), /wrangler deployments list failed/);
  assert.throws(() => captureDeploymentBaseline(1, "", "network timeout"), /wrangler deployments list failed/);

  const version = { commit: "a".repeat(40), ref: "codex/wave2e", deployed_at: "2026-07-22T12:00:00Z" };
  const health = {
    ok: true,
    service: "vibepub-api",
    version,
    adapters: {
      writing: { service: "writing-agent", version },
      review: { service: "editorial-review-agent", version },
      image: { service: "image-generation-adapter", version },
      wechat: { service: "wechat-publishing-adapter", version },
    },
  };
  assert.equal(verifyStagingHealth(health, version.commit, version.ref).adapters.image.commit, version.commit);
  health.adapters.wechat.version = { ...version, commit: "b".repeat(40) };
  assert.throws(() => verifyStagingHealth(health, version.commit, version.ref), /wechat adapter/);
  health.adapters.wechat.version = version;
  health.adapters.review.version = { ...version, ref: "wrong-ref" };
  assert.throws(() => verifyStagingHealth(health, version.commit, version.ref), /review adapter/);
});
