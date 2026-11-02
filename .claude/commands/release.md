Perform a full release: generate release notes, bump version, commit, tag, and push.

## Instructions

### 1. Run tests

- Run `npm test` and ensure all tests pass before proceeding. If any test fails, stop and report the failure to the user.

### 2. Determine the new version

- The argument specifies the version bump type or an explicit version.
- If the argument is `major`, `minor`, or `patch`, calculate the new version by bumping the corresponding part of the current version in `package.json`.
- If the argument is an explicit version (e.g., `0.3.0` or `v0.3.0`), use that. Strip any leading `v`.
- If no argument is provided, default to `patch`.

### 3. Generate release notes

- Run the `/release-notes` skill with the new version to generate and prepend the changelog entry to `CHANGELOG.md`.

### 4. Bump the version and commit

- Use `npm version <major|minor|patch|explicit-version> --no-git-tag-version` to bump `package.json` and `package-lock.json` without creating a git tag yet.
- Stage `package.json`, `package-lock.json`, and `CHANGELOG.md`.
- Commit with the message: `release: v<version>`

### 5. Create the git tag

- Create an annotated tag: `git tag -a v<version> -m "v<version>"`

### 6. Confirm before pushing

- Show the user a summary of what was done:
  - Version: old → new
  - Changelog entries generated
  - Commit hash
  - Tag name
- Ask the user to confirm before pushing. If confirmed, push to the **fork** remote
  (this repo's `origin` is the upstream `elirantutia/vibeyard` checkout URL and pushing
  it is refused by the standing fork-rebuild constraint — see
  [docs/git-history.md](../../docs/git-history.md)):
  - `git push fork main`
  - `git push fork v<version>`
- If the `fork` remote is not configured, show `git remote -v` and ask the user which
  remote publishes this fork before pushing anything.
- If denied, inform the user the commit and tag are local and can be undone.

Pushing the tag publishes nothing by itself: the artifact matrix, the GitHub Release and
the npm publish all come from the **Release** workflow, which is
`workflow_dispatch`-only (`.github/workflows/release.yml`). Inside that runner, the
workflow's own `git push origin …` is correct — there `origin` is the GitHub repo the
workflow runs in, not the upstream URL. The full sequence, including the
`artifacts_only` gate leg, is documented in [docs/release.md](../../docs/release.md).

$ARGUMENTS
