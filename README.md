# Vibeyard — `leo-3889` fork

> **Fork notice.** This is a working fork of
> **[elirantutia/vibeyard](https://github.com/elirantutia/vibeyard)**.
>
> For the product as its authors describe it — features, screenshots, install
> guides for macOS / Linux / Windows — go to the
> **[upstream README](https://github.com/elirantutia/vibeyard#readme)**.
> A verbatim copy is kept in this repo at
> [`README.upstream.md`](README.upstream.md) so you can read it without leaving
> the fork.

| | |
|---|---|
| **Upstream** | [elirantutia/vibeyard](https://github.com/elirantutia/vibeyard) |
| **This fork** | [leo-3889/vibeyard](https://github.com/leo-3889/vibeyard) |
| **Delta** | 9 commits ahead of `upstream/main` (`19bc19f`) |
| **Open upstream PR** | [#167](https://github.com/elirantutia/vibeyard/pull/167) |

Everything on this fork's `main` is either already proposed upstream or on its way
there. This README covers **only** what the fork adds and why. For how Vibeyard
works, read [upstream](https://github.com/elirantutia/vibeyard#readme).

---

## What this fork is for

**1. Drive more than one AI CLI.**
Upstream ships four backends — Claude Code, Codex CLI, GitHub Copilot, Gemini CLI.
This fork adds **Pi** and **Oh my Pi**, bringing the registry to six. The point is
not those two specific tools; it is proving that the `CliProvider` abstraction can
absorb a CLI the original authors never targeted without forking the UI.

**2. Make hook-less CLIs first-class rather than second-class.**
Most of Vibeyard's live state — status, cost, title — arrives through Claude Code's
hook and statusLine system. CLIs without one used to render as dead boxes. This fork
adds a **polled transcript sync** (`src/main/session-transcript-sync.ts`) driven by
declared capabilities (`selfTitles`, `polledStatus`), so a CLI with no hook system
still reports working / completed / waiting and still gets a session title. A new
CLI plugs in by declaring the capability and implementing one reader — no watcher,
IPC channel, or renderer change.

**3. Treat profiles as a per-tool concept, not a Claude concept.**
Upstream's multi-login story is Claude-shaped. Here, profiles belong to whichever
coding tool you picked, with **one default per tool**, resolved through a single
chain at session-creation time and pinned to the session. The sidebar badge reads
`Tool · Profile` from that same resolution, so the UI cannot advertise a profile
the next session won't actually get.

**4. Windows as a first-class target.**
This fork is developed and verified on Windows 11 (build 26200). That is a
deliberate difference in emphasis: path handling, `cmd.exe` argument limits,
keychain-vs-credential-store behaviour, and installer shape all get exercised here
rather than assumed.

**5. Contribute back instead of fork-and-forget.**
The delta is structured as reviewable, upstream-shaped commits and is submitted as
[PR #167](https://github.com/elirantutia/vibeyard/pull/167). Fork-only identity
material — this README included — is kept **off** the upstream PR on purpose.

## What this fork does *not* do

- No fork-only branding, telemetry, analytics, or phone-home.
- No config lock-in, no changed data format, no migration that blocks going back to upstream.
- No upstream feature removed or disabled.
- No divergence in how the app behaves for existing Claude Code users.

## Known limits, stated plainly

- **Cost and context tracking are still Claude Code only.** `costTracking` and
  `contextWindow` are `false` for every other backend, including the two added
  here. The fork did not change that; it just stopped the README from implying
  otherwise.
- **macOS and Linux are unverified in this delta.** No platform-specific code was
  added beyond the existing `src/main/platform.ts` helpers, but neither OS was
  exercised. Treat them as expected-good, not confirmed-good.
- **`pi` and `omp` must be resolvable on `PATH`** or the provider stays hidden.
  That is upstream's `resolveBinary` behaviour, not a fork quirk.

## Keeping this fork in sync

```bash
git remote rename origin upstream   # if you clone this fork
git remote add origin https://github.com/leo-3889/vibeyard.git

git fetch upstream
git checkout main
git merge --ff-only upstream/main  # or rebase, if the fork has local commits
```

This fork's `main` intentionally sits ahead of `upstream/main` by the fork delta.
Once [#167](https://github.com/elirantutia/vibeyard/pull/167) merges, that gap
closes to just the fork-only README commit.

## Install and build

Unchanged from upstream — see
[upstream install instructions](https://github.com/elirantutia/vibeyard#install)
and [`CONTRIBUTING.md`](CONTRIBUTING.md). Requires Node v24 (see `.nvmrc`).

```bash
npm install
npm start     # compiles main + preload + renderer, then launches
npm test      # vitest
```

## Contributing

Issues and PRs against this fork are welcome. Anything that is a general
improvement — not fork-specific identity — gets forwarded upstream so everyone
gets it, and that preference is the main reason this fork exists in the open rather
than locally.

---

*Vibeyard is an independent project and is not affiliated with or endorsed by
Anthropic. This fork carries no additional affiliation either.*
