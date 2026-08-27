# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- Create, read, comment on, label, assign, and close issues with `gh issue`.
- Infer the repository from `git remote -v`; this workspace points to `litianc/vibepub-android`.
- Pull requests are not a triage request surface.
- Refer to issues by their linked title in user-facing text, not only by number.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `litianc/vibepub-android`.

## When a skill says "fetch the relevant ticket"

Read the issue and its comments with `gh issue view <number> --comments`.

## Wayfinding operations

- Map: one issue labelled `wayfinder:map`.
- Child ticket: a GitHub sub-issue of the map. If sub-issues are unavailable, use a task list in the map and add `Part of #<map>` to the child.
- Ticket labels: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- Blocking: use GitHub's native issue dependencies. If unavailable, add `Blocked by: #<number>` to the child.
- Frontier: open, unblocked, unassigned child issues, in map order.
- Claim: assign the issue to the Agent driver before work starts.
- Resolve: add the answer as a comment, close the issue, then add a linked one-line gist to the map's Decisions so far section.
