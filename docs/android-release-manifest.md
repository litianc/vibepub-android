# Android Release Manifest

Local and downloaded APKs are excluded from source control. GitHub Releases is the durable installation source.

## Latest Recorded Legacy Release

- **Source of Truth**: GitHub Releases
- **Latest Version**: `build-20260630-140513-4eb064d`
- **Published**: 2026-06-30T14:05:21Z
- **Release Commit**: `4eb064d685911d47024b4b88cee2f5c0d8399694`
- **Release Digest**: `f3f060036cba079e96c0c72e900cfe91f5b42a9c17eb877d8b1e340d56ade38f`
- **APK URL**: <https://github.com/litianc/vibepub-android/releases/download/build-20260630-140513-4eb064d/app-debug.apk>

This historical asset predates managed Android versions. New release assets use
the contract `VibePub-<version-name>-<version-code>-<git-commit>.apk`, for example
`VibePub-0.2.0-3-0123456789ab.apk`.

## Managed Candidate (Not Published)

The source currently defines candidate `0.2.0 (3)`. It has no published release
URL or digest. It becomes the current published manifest entry only when
[“验收并发布第一个 Release Batch” Issue](https://github.com/litianc/vibepub-android/issues/26)
receives authorization and publishes the actual managed APK. Until then, the
legacy release above remains the latest published APK.

For internal testing and dogfooding, download an approved APK from GitHub Releases. Do not commit a local APK snapshot.
