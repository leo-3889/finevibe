---
name: plan-status-audit
description: This skill MUST be used whenever the task involves the repo's work queue — `todos/*-plan.md`, the full-audit P-id registry, `todos/AUDIT_STATUS.md`, "what is done / remaining / open", "check todos and plans", status snapshots, commit-splitting for large sweeps, or committing while other agents share the working tree. Use when the user asks what is finished, what is left, whether a plan landed, what to commit next, or to reconcile the plan with git history.
---

# Status auditing and commit discipline

## Preflight: `todos/` is local-only

`todos/` is **gitignored** (`.gitignore:42`) while this skill is committed. On a fresh
clone `ls todos/` is empty and there is nothing to audit — say so, and audit git history +
`docs/` instead. Everything below assumes the owner's tree, where the queue exists:
`ls todos/ && git check-ignore -v todos` proves which case you are in.

## Rule 0: never trust a plan header

`todos/*-plan.md` headers (`Status: planned, not implemented`, `Status: todo · Owner: TBD`)
are written once and never updated. Implementation lands right after them. Every plan in
`todos/` read "planned, not implemented" while its commits were already on `rebuild`. The
registry in `todos/full-audit-2026-10-20-plan.md` was quoted as "158 rows, all open" when
it was already partly committed. **Reconcile against git, then report.**

Never quote a census you did not just measure — print it with the commands:

```bash
P=todos/full-audit-2026-10-20-plan.md
grep -oE '\b(P[0-9]+-[0-9]+|C-[0-9]+)\b' $P | sort -u | wc -l   # distinct ids
grep -cE '\| [A-Z] \| open \|' $P                               # rows still open
grep -oE '\| [A-Z] \| [a-z-]+ \|' $P | awk '{print $4}' | sort | uniq -c | sort -rn
```

Measured 2026-10-24: 172 distinct ids, 139 rows `open`, plus rows whose status column is
prose (`**decided: FORK identity**`, `decision`, `approval`) — the histogram only counts
machine-shaped statuses, so it under-counts decisions by design. Quote the numbers with
the date.

## Recipe: truthful status snapshot

1. Enumerate the queue: `ls todos/` (one file per feature plan, ids in the filename and in
   the plan rows).
2. For each plan, extract the steps' code anchors (`file.ts:NN` / symbol names) and grep
   the tree for them — e.g. plan 47–49 claims a Codex `planModeStartupInput` flag; grepping
   `planModeStartupInput|pendingPromptTrigger` proves it never landed.
3. Map plan → commits by subject: `git log --oneline -25` (subjects carry plan ids, e.g.
   `feat(projects): default projects folder + git-URL checkout (65-67)`).
4. Registry rows: ids live in the **first table cell**, bolded or not —
   `grep -oE '\b(P[0-9]+-[0-9]+|C-[0-9]+)\b' $P | sort -u` (172 ids). The bold-only pattern
   `\*\*(P[0-9]-[0-9]+|C-[0-9]+)\*\*` matches 11 of them: it under-counts ~15×, so never use
   it for a census. Statuses: `grep -cE '\| [A-Z] \| open \|' $P`.
   Read §1.1 "Commit map" (one task per commit, mirrored in the session todo list) and §7
   "Wave A/B/C/D" gates (12-task checklist, wave exit = 3 checks + the extras in §6). Rows
   are keyed by stable ids (`P1-19`, `C-5`) — cite the id, not the row number.
5. Report in three buckets: **landed** (commit + test), **open code work** (anchored),
   **open verification** (`npm start` smoke / packaged-app evidence). Never merge the last
   two into "done".

Anchors go stale after refactors (a 2026-10-19 row cited `ipc-handlers.ts:4621-4625`, now
`:6215` after the registrar split). Re-derive from the tree; do not re-cite a dead line.

## SHA citation rule (`todos/AUDIT_STATUS.md` convention)

Every SHA printed in `docs/` must pass
`git merge-base --is-ancestor <sha> rebuild`. The 2026-10-19/20 program's commits
(`f61453b` and the `audit-2026-10-19` / `feat/rename` lineage) are **objects in the repo
but not ancestors of `rebuild`** — the rebuild rebase re-hashed that history, so cite such
SHAs as "the program's gate anchor", never as an ancestry claim. Verify with
`git log -1 --format=%s` before quoting a subject for a SHA.

Docs must be **self-contained**: never link to a sibling agent workspace
(`../finevibe-llm/...`); that folder is dissolved and gone. Check for stray refs with
`git grep -n "finevibe-llm" $(git rev-parse --abbrev-ref HEAD)` — zero today, keep it that
way. When a workspace holding per-finding evidence is dissolved, record the durable
findings + commits in `todos/AUDIT_STATUS.md` and state plainly that the evidence no longer
exists (see the 2026-10-21 salvage section).

## Commit discipline

**One commit per feature.** For a large sweep (product rename, toolchain add):

1. `git status --porcelain` → classify: pure renames, config, toolchain, docs.
2. Check for **build-breaking pairs** first. A `git mv a.ts b.ts` commit fails `tsc` on
   its own when importers are updated in a later commit — so rename pair + importers must
   share one commit. Decide the split by what compiles, not by tidiness.
3. `git add <paths>` per group; commit. Verify rename recording with
   `git show --stat -M HEAD` (`bin/vibeyard.js => bin/finevibe.js` recorded, not
   delete+add).

**Other agents share this working tree and the index.** Consequences, all observed:

- **Always** run `git diff --cached --name-only` before committing and `git show --stat
  HEAD` after. A plain `git add <file> && git commit <file>` commits **every** pre-staged
  change (git ignores pathspecs when the index is involved). This swept a concurrent
  session's in-progress Icons section into an audit commit; undone with
  `git commit --amend` + `git reset <path>` + re-commit.
- If a concurrent session has staged someone else's renames (e.g. a doc move), give them
  their own commit and strip them from yours (`git reset todos/audits/x.md` after the first
  commit, then re-commit).
- `.git/index.lock` contention appears mid-command: bounded retry loop on
  `git add`/`git commit`, never a blind single retry.
- Files that change *while you work* (a doc gaining a section between read and commit) must
  go in with your commit, not be reverted.

**Hunk surgery** (commit only part of a file, e.g. the audits pointer in a doc an agent is
also editing): stage the whole file, dump hunks, drop the ones to keep unstaged, stage the
rest, restore the file. **Illustrative shape, not a runnable script** — it hardcodes one
doc, one filter string, and `/tmp` paths that do not exist on a Windows host (use a repo
path under the tree, e.g. `.hunk.patch`). Read the emitted hunks and choose; do not paste
it blind:

```bash
git add docs/packaging.md && git diff --cached docs/packaging.md > .hunk.patch
python - <<'PY'   # Windows: no `split` binary
import re
t=open('.hunk.patch',encoding='utf-8').read().split('\n')
h=re.split(r'(?m)^@@ ', '\n'.join(t[4:]))
out=[h[0]]+[b for b in h[1:] if 'Icons' not in b.split('\n')[0]]
open('.hunk2.patch','w',encoding='utf-8').write('\n'.join(out))
PY
git apply --cached --unidiff-zero .hunk2.patch
git checkout -- docs/packaging.md   # keep the rest in the worktree
```

## Verification before reporting

Gate legs: `npm run build` → `npm run typecheck` → `npx vitest run` → `git diff --check`
(also `npx tsc -p tsconfig.renderer.json --noEmit`; `dev/audit/gate.sh` runs them N times).
6 chrome-import tests fail on a Windows dev box with a `NODE_MODULE_VERSION 145 / 137`
mismatch — host ABI, not code (see the `windows-packaging` skill). Expect `npm start` /
packaged-app smoke to be blocked here; report those rows as **unverified**, never as
passing, and say which leg produced each number.

## Standing facts (re-measure before quoting)

- `rebuild` is the integration branch and exists on **no remote** — verify with
  `git branch -r --contains rebuild` (empty today). Ahead of `fork/main` by
  `git rev-list --count fork/main..rebuild` (9 today; the number moves with every rebase —
  it was 111 when this skill was written, and the 2026-10-19/20 program's history was
  re-hashed by the rewrite). No push without asking.
- Remotes today: `fork` = `https://github.com/leo-3889/finevibe.git` (push), `origin` =
  `https://github.com/elirantantia/vibeyard.git` (fetch; push is refused by config).
- `todos/fork-rebuildable-on-origin.md` (local-only, gitignored): upstream's PR #167 breaks if the
  `feature/*` branches under it are rebuilt — rebuilding is allowed **only** as a
  force-push plus a coordinated PR #167 update.
- The 2026-10-19/20 agent workspace was dissolved 2026-10-21; per-finding evidence is gone,
  findings stay closed via their commits.
