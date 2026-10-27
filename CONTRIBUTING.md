# Contributing to FineVibe

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

1. **Node v24** is required — see `.nvmrc`. Use `nvm use` to switch.
   The published npm launcher accepts Node 18+, but source development uses Node 24.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build and run:
   ```bash
   npm start
   ```

   `npm start` compiles all three targets (main, preload, renderer) before
   launching. The standalone build and check commands live under [Testing](#testing).

There is **no hot reload** — changes require a full rebuild and app restart.

## Testing

All four checks below must pass before a change is complete:

```bash
npm run build               # Compile all three targets (main, preload, renderer)
npm test                    # Run all tests once
npx tsc -p tsconfig.renderer.json --noEmit   # Renderer typecheck
git diff --check            # No whitespace errors in the diff
```

Vitest conveniences:

```bash
npm run test:watch    # Watch mode (re-runs on file changes)
npm run test:coverage # Coverage report (terminal + HTML at coverage/index.html)
```

Tests use [Vitest](https://vitest.dev/) and are co-located with source files as `*.test.ts`.

## Code Style

No lint tooling is configured yet (planned). For now:

- Use 2-space indentation
- Follow existing patterns in the codebase

## Commit Messages

Commits use a structured prefix so release notes can be generated automatically.
Format: `<prefix> <concise lowercase description>` — one line, no trailing period.

| Release notes section | Prefixes |
|---|---|
| Features | `add`, `feat`, `implement`, `introduce`, `support` |
| Fixes | `fix`, `resolve`, `patch`, `correct` |
| Changes | `improve`, `update`, `remove`, `refactor`, `bump` — plus anything unmatched |

Examples:

```
add dark mode support
fix session resume on restart
refactor PTY lifecycle management
```

Keep the prefix as the first word on its own — don't follow it with a `:` or a
scope. The generator strips only the leading keyword, so a message like
`feat : thing - description` would appear in the changelog with the `:` and scope
still attached.

## Documentation

The contract docs (providers, hosts, session lifecycle, security boundaries, performance,
UI conventions, packaging, feature reference) are indexed in
[docs/README.md](docs/README.md). A change that invalidates a claim in one of them updates
that doc in the same commit.

## Releases and Packaging

Releases are cut by the `Release` workflow (`workflow_dispatch` on
`.github/workflows/release.yml`); it bumps the version, generates
`CHANGELOG.md`, tags, and publishes installers for macOS, Linux (deb +
AppImage) and Windows. See [docs/packaging.md](docs/packaging.md) for the
artifact matrix, deb build requirements (Linux-only), and how to build an
ad-hoc Ubuntu package without releasing.

## Pull Request Workflow

**Before you start:** for anything beyond a small bugfix, typo, or doc change, please open an issue (or comment on an existing one) first to confirm the change is wanted and agree on the approach. This saves you from building something we can't merge.

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes and add tests where appropriate
4. Run all four checks from [Testing](#testing) — `npm run build`, `npm test`, the renderer typecheck (`npx tsc -p tsconfig.renderer.json --noEmit`), and `git diff --check` — to verify nothing is broken
5. Open a PR against `main`

## Reporting Issues

We use [GitHub issue templates](https://github.com/elirantutia/vibeyard/issues/new/choose) to streamline reports. Pick the template that fits:

- **Bug Report** — for something broken or not working as expected. The template asks for your OS, FineVibe version, CLI provider/version, reproduction steps, and expected vs actual behavior.
- **Feature Request** — for suggesting a new feature or improvement. Describe the idea, motivation, and any alternatives you've considered.
- **Documentation Issue** — for reporting errors, gaps, or unclear sections in the docs.

Blank issues are disabled — please use one of the templates above.
