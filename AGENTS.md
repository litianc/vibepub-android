# VibePub Workspace Conventions

## Feature Ledger

When a code commit changes product functionality, user experience, backend workflow, release behavior, or validation infrastructure, update `docs/feature-ledger.md` before committing.

Each entry should use Asia/Shanghai time and one concise sentence describing the capability added or changed.

## Multi-Agent Git And Release Ownership

- Sub-agents may edit and test only inside their assigned worktree.
- Sub-agents must not push to GitHub, merge branches, or deploy any environment unless the user explicitly authorizes that specific sub-agent.
- The supervising coordinator Agent reviews and integrates sub-agent work.
- Only the supervising coordinator Agent may push to GitHub or deploy staging and production after the required user authorization.

## Agent skills

### Issue tracker

Work plans and decision tickets live in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default engineering skill labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single project context with a root `CONTEXT.md` and system decisions under `docs/adr/`, created only when needed. See `docs/agents/domain.md`.
