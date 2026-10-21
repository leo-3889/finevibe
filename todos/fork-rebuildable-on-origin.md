# Fork must stay rebuildable on origin `elirantutia/vibeyard`

Standing operational constraint, not a one-off task. It binds every branch, every
history-touching operation, and every push in this repository.

Status: standing.
Date: recorded 2026-10-21 (salvaged into the tracked plan set from the agent workspace
that held the 2026-10-19/20 audit-program records; the rule predates that program).
Scope: git history and remotes only. No code, no tests.

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

## Rebuild recipe

1. Cut a temp branch off `main`.
2. `git fetch origin && git rebase origin/main` on the temp branch.
3. Run the full gate at the rebased tip — vitest, tsc ×4, `npm run build`,
   `git diff --check` (the same legs as `dev/audit/gate.sh`).
4. Fast-forward `main` onto the rebased tip. No merge commit, no force.
5. Push.

Any run of this recipe that needs a force-push, a merge commit, or a rewrite to finish
means the constraint is already broken: fix the history question first, never the recipe.
