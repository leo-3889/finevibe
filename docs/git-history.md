# Git history and remote constraints

Standing operational constraint, not a one-off task. It binds every branch, every
history-touching operation, and every push in this repository. Scope: git history and
remotes only — no code, no tests.

Provenance: recorded 2026-10-21, kept in the maintainer's local-only work queue as
`todos/archives/fork-rebuildable-on-origin.md` (gitignored, so invisible to a fresh
clone), and summarized in `CLAUDE.md` as "Git history constraint (standing)". This file
is the public statement of the same rule; when the two disagree, the constraint itself
has not changed — the doc has, and this file wins as the published contract.

## The rule

The fork `leo-3889/finevibe` MUST always be able to rebuild/rebase onto `origin`
(`elirantutia/vibeyard` main) if ever asked.

- **NEVER** force-push or history-rewrite
  `feat/multi-provider-status-and-profile-scoping`, and never rewrite the pre-rename
  commits. That branch backs open upstream PR #167: its published history is not ours to
  change, and a rewrite breaks the PR as seen from `origin`.
- Keep `origin` fetchable. The rebase target has to stay reachable for the constraint to
  mean anything; do not prune the remote, its refs, or the fetched objects the fork
  descends from.

## The remotes, and which one pushes

| Remote | URL | Push |
|---|---|---|
| `origin` | `https://github.com/elirantutia/vibeyard.git` | **refused** — the push URL is disabled by this constraint; `origin` is fetch-only |
| `fork` | `git@github.com:leo-3889/finevibe.git` | the published fork; every local push from a developer machine goes here |

Consequences that read as surprises:

- `git push origin <anything>` from a working tree of this fork is a constraint
  violation, not a convenience. Local pushes name `fork` (see
  [the release procedure](release.md), step 6 of `/release`).
- The Release workflow's own `git push origin main` is legitimate and is **not** an
  exception to make a note of: inside a GitHub Actions runner, `origin` is the GitHub
  repository the workflow runs in, not the upstream URL above.
- Fetching, rebasing, and merging from `origin` stay allowed — the constraint is about
  what leaves the machine, plus keeping `origin`'s objects reachable.

## Rebuild recipe

Cut a temp branch, rebase it onto upstream, gate it, then fast-forward `main`:

1. Cut a temp branch off `main`.
2. `git fetch origin && git rebase origin/main` on the temp branch.
3. Run the full gate at the rebased tip — vitest, tsc ×4, `npm run build`,
   `git diff --check` (the same legs as `dev/audit/gate.sh`).
4. Fast-forward `main` onto the rebased tip. No merge commit, no force.
5. Push.

Any run of this recipe that needs a force-push, a merge commit, or a rewrite to finish
means the constraint is already broken: fix the history question first, never the recipe.

## Related

- [Release procedure](release.md) — what the release push targets, and why.
- [README "Sync"](../README.md#sync) — the clone-side remote layout for a contributor
  working on the fork.
- `CLAUDE.md` — the one-paragraph contributor-guide summary of this file.
