import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readWorkflow(name) {
  return readFileSync(path.join(repositoryRoot, ".github", "workflows", name), "utf8");
}

test("Android validation checks committed baselines for pull requests and main pushes", () => {
  const workflow = readWorkflow("android-tests.yml");

  assert.match(workflow, /if: github\.event_name == 'pull_request' \|\| github\.event_name == 'push'/);
  assert.match(
    workflow,
    /BASE_REF: \$\{\{ github\.event_name == 'pull_request' && github\.event\.pull_request\.base\.sha \|\| github\.event\.before \}\}/,
  );
  assert.match(workflow, /node scripts\/manage-android-version\.mjs check-git-ref "\$BASE_REF"/);
});

test("tag and manual release candidates check published managed APKs", () => {
  const workflow = readWorkflow("android-internal-build.yml");
  const releaseFetch = 'gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100"';
  const releaseCheck =
    'node scripts/manage-android-version.mjs check-releases "$RUNNER_TEMP/android-releases.json"';
  const firstFetchIndex = workflow.indexOf(releaseFetch);
  const firstValidationIndex = workflow.indexOf(releaseCheck);
  const lastFetchIndex = workflow.lastIndexOf(releaseFetch);
  const lastValidationIndex = workflow.lastIndexOf(releaseCheck);
  const buildIndex = workflow.indexOf("gradle -p android :app:assembleRelease");
  const internalReleaseIndex = workflow.indexOf("uses: softprops/action-gh-release@v2");
  const officialReleaseIndex = workflow.lastIndexOf("uses: softprops/action-gh-release@v2");

  assert.match(
    workflow,
    /concurrency:\s+group: android-release-publish\s+cancel-in-progress: false/,
  );
  assert.doesNotMatch(workflow, /HEAD\^/);
  assert.notEqual(firstFetchIndex, -1, "release workflow must read published GitHub Releases");
  assert.notEqual(firstValidationIndex, -1, "release workflow must use the public release check");
  assert.notEqual(buildIndex, -1, "release workflow must build a release APK");
  assert.ok(firstFetchIndex < firstValidationIndex, "published releases must be read before validation");
  assert.ok(firstValidationIndex < buildIndex, "initial version validation must run before build");
  assert.ok(buildIndex < lastFetchIndex, "published releases must be refreshed after build");
  assert.ok(lastFetchIndex < lastValidationIndex, "refreshed releases must be checked");
  assert.ok(lastValidationIndex < internalReleaseIndex, "race check must run before internal release");
  assert.ok(lastValidationIndex < officialReleaseIndex, "race check must run before official release");
  assert.notEqual(firstFetchIndex, lastFetchIndex, "release metadata must be fetched twice");
  assert.notEqual(firstValidationIndex, lastValidationIndex, "release baseline must be checked twice");
});

test("test infrastructure runs workflow contract tests for release workflow changes", () => {
  const workflow = readWorkflow("test-infrastructure.yml");
  const pathEntry = '- ".github/workflows/android-internal-build.yml"';

  assert.equal(workflow.split(pathEntry).length - 1, 2);
  assert.match(
    workflow,
    /node --test scripts\/manage-android-version\.test\.mjs scripts\/android-version-workflows\.test\.mjs/,
  );
});

test("release workflow verifies the copied APK identity and pinned certificate", () => {
  const workflow = readWorkflow("android-internal-build.yml");
  const testInfrastructure = readWorkflow("test-infrastructure.yml");
  const certificatePathEntry = '- "android/release-certificate.sha256"';
  const fingerprint = readFileSync(
    path.join(repositoryRoot, "android", "release-certificate.sha256"),
    "utf8",
  ).trim();
  const copyIndex = workflow.indexOf(
    'cp android/app/build/outputs/apk/release/app-release.apk "dist/$ARTIFACT_NAME"',
  );
  const verifyIndex = workflow.indexOf(
    'node scripts/manage-android-version.mjs verify-apk "dist/$ARTIFACT_NAME" "$GITHUB_SHA"',
  );
  const uploadIndex = workflow.indexOf("name: Upload APK artifact");
  const releaseIndex = workflow.indexOf("uses: softprops/action-gh-release@v2");

  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.match(workflow, /VIBEPUB_AAPT="\$ANDROID_HOME\/build-tools\/36\.0\.0\/aapt"/);
  assert.match(
    workflow,
    /VIBEPUB_APKSIGNER="\$ANDROID_HOME\/build-tools\/36\.0\.0\/apksigner"/,
  );
  assert.equal(testInfrastructure.split(certificatePathEntry).length - 1, 2);
  assert.ok(copyIndex < verifyIndex, "the final copied APK must exist before verification");
  assert.ok(verifyIndex < uploadIndex, "an unverified APK must not be uploaded");
  assert.ok(verifyIndex < releaseIndex, "an unverified APK must not be published");
});
