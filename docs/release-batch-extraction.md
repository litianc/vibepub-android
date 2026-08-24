# Release Batch Extraction

The current mixed workspace is an extraction source, not a commit candidate. Keep a recoverable stash before extracting any change, then start each ticket from the latest accepted `main` commit in its own branch and worktree.

Release Batch scope and order are maintained in [GitHub Spec #22](https://github.com/litianc/vibepub-android/issues/22) and its implementation Issues #23 through #32. Do not duplicate that work plan in the repository.

## Extraction Rules

1. Preserve the mixed workspace with a named stash that includes untracked files.
2. Create a clean branch and worktree from the latest accepted `main` commit.
3. Extract only the files and hunks required by the current ticket.
4. Run focused checks, the relevant full test suite, and `scripts/check-repository-hygiene.sh`.
5. Review the ticket diff against its `main` fixed point before integration.
6. Never commit generated APKs, raw logs, screenshots, UI dumps, credentials, or downloaded general-purpose Skills.

Approved APKs belong in GitHub Releases. Redacted evidence that must be kept belongs on the relevant GitHub Issue.
