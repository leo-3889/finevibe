# FineVibe - An enhanced Vibeyard

> **Fork notice.** FineVibe is a fork of
> **[elirantutia/vibeyard](https://github.com/elirantutia/vibeyard)**.
> For the product as its authors describe it, read the
> **[upstream README](https://github.com/elirantutia/vibeyard#readme)** —
> a verbatim copy lives here as
> [`README.upstream.md`](README.upstream.md).

| | |
|---|---|
| **Upstream** | [elirantutia/vibeyard](https://github.com/elirantutia/vibeyard) |
| **This fork** | [leo-3889/vibeyard](https://github.com/leo-3889/vibeyard) |
| **Upstream PR** | [#167](https://github.com/elirantutia/vibeyard/pull/167) |

This README covers only what the fork adds. Everything else is upstream's.

---

## What this fork is for

**Drive more than one AI CLI.** Upstream ships four backends. This fork adds
**Pi** and **Oh my Pi** — six total. The goal isn't those two tools; it's proving
the `CliProvider` abstraction absorbs a CLI the original authors never targeted.

**Make hook-less CLIs first-class.** Live state normally arrives via Claude's hooks.
CLIs without them rendered as dead boxes. A **polled transcript sync**
(`session-transcript-sync.ts`) driven by declared capabilities fixes that.
Pi and OMP use provider-specific transcript discovery and shared session sync.

**Make profiles per tool, not per Claude.** One default per coding tool, resolved
once at session creation and pinned. The `Tool · Profile` badge reads that same
resolution, so the UI can't promise a profile the next session won't get.

**Treat Windows as first-class.** Built and checked on Windows 11: path
handling, `cmd.exe` argument limits, credential-store behaviour, installer shape.

**Contribute back.** The multi-provider work is tracked in
[#167](https://github.com/elirantutia/vibeyard/pull/167).

## What it does *not* do

- **FineVibe names the fork, not the app.** Same product name, UI, and data inside.
- No fork-only telemetry, analytics, or phone-home.
- No config lock-in or migration that blocks a return to upstream.
- No upstream feature removed or disabled.

## Known limits

- **Cost and context tracking stay Claude-only.** `costTracking` / `contextWindow`
  are `false` for every other backend, including the two added here.
- **macOS and Linux are unverified in this delta.** No new platform-specific code
  beyond `src/main/platform.ts`, but neither OS was exercised.
- **`pi` and `omp` must be on `PATH`** or the provider stays hidden — upstream
  behaviour, not a fork quirk.

## Sync

```bash
git remote rename origin upstream    # if you clone this fork
git remote add origin https://github.com/leo-3889/vibeyard.git
git fetch upstream && git checkout main
git merge --ff-only upstream/main   # rebase if the fork has local commits
```

Once #167 merges, `main` sits ahead of upstream by just the fork-only README.

## Install

Unchanged from upstream — see
[upstream install](https://github.com/elirantutia/vibeyard#install) and
[`CONTRIBUTING.md`](CONTRIBUTING.md). Node v24 required (`.nvmrc`).

```bash
npm install
npm start     # builds main + preload + renderer, then launches
npm test      # vitest
```

## Contributing

PRs here are welcome. Anything generally useful gets forwarded upstream — that
preference is why this fork is public rather than local.

---

*Vibeyard is independent of Anthropic. This fork carries no added affiliation.*
