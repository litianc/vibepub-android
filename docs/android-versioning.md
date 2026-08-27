# VibePub Android Version Management

## One Version Source

`android/version.properties` is the only Android version source.

- `VERSION_NAME` is the user-facing `major.minor.patch` version.
- `VERSION_CODE` is Android's strictly increasing install version.

Gradle puts both values into APK metadata. Settings reads the generated
`BuildConfig` values, so it shows what is inside the installed APK.

## Public Command

Read or validate the current version:

```bash
node scripts/manage-android-version.mjs show
node scripts/manage-android-version.mjs check
```

Bump both fields together:

```bash
node scripts/manage-android-version.mjs bump patch
node scripts/manage-android-version.mjs bump minor
node scripts/manage-android-version.mjs bump major
```

Compare against an earlier version file:

```bash
node scripts/manage-android-version.mjs check-against /path/to/version.properties
```

Compare a release candidate against downloaded GitHub Releases metadata:

```bash
node scripts/manage-android-version.mjs check-releases /path/to/releases.json
```

`VERSION_CODE` must increase. `VERSION_NAME` may stay the same, but it must keep
the `major.minor.patch` format. Pull requests compare with their base, direct
main pushes compare with the pre-push commit. Tag and manual release candidates
compare with the highest `VERSION_CODE` found in a published, non-draft GitHub
Release asset whose state is `uploaded` and whose name matches the managed APK
contract. Drafts, unpublished records, incomplete uploads, and malformed names
are ignored. Prereleases count when they are published. If no valid published
asset exists, the first managed release candidate is accepted.

Android release jobs share one concurrency group and never cancel a running job.
After the APK build, the workflow fetches published releases again and repeats
the public check immediately before release creation. This closes the normal
concurrent-publish race while still allowing ordinary commits after a version
bump and rejecting a delayed stale branch.

## APK Identity

Each release APK carries the Git commit in manifest metadata and `BuildConfig`.
Settings displays it next to the embedded version. The release workflow uses the
same command output for a filename such as:

```text
VibePub-0.2.0-3-0123456789ab.apk
```

Official tag `vX.Y.Z` must match `VERSION_NAME`. Release APKs require the stable
signing secrets; the workflow fails instead of publishing a differently signed
candidate.

Every release job uses the protected GitHub Environment `android-release`.
Configure that Environment with a required reviewer so manual and tag-triggered
publishing cannot continue until the recorded release approval is granted.

The expected public signing-certificate SHA-256 fingerprint is pinned in
`android/release-certificate.sha256`. Verify a final APK with:

```bash
VIBEPUB_AAPT=/path/to/aapt \
VIBEPUB_APKSIGNER=/path/to/apksigner \
node scripts/manage-android-version.mjs verify-apk \
  /path/to/VibePub-0.2.0-3-<commit>.apk <full-git-commit>
```

This command verifies the filename, embedded `versionName`, `versionCode`, Git
commit, APK signature, and pinned certificate fingerprint. The release workflow
runs it on the copied final APK before artifact upload or release creation.

Real-device installation and startup evidence remains pending until an Android
device is connected.
