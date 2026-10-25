# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in FineVibe, please report it through [GitHub Security Advisories](https://github.com/elirantutia/vibeyard/security/advisories/new).

**Please do not open a public issue for security vulnerabilities.**

We will acknowledge your report within 72 hours and aim to release a fix within 7 days for critical issues.

## Scope

FineVibe is a local Electron desktop application with privileged main-process access to local projects and terminal sessions. It also has opt-in WebRTC terminal sharing, an embedded webview, Chrome-cookie import, and outbound GitHub/MCP connections. Treat remote peers, web pages, CLI output, project files and imported browser data as separate trust domains.

## Known Limitations

- **Release signatures** — The macOS build config enables signing and notarization when release secrets are present. This repository check does not verify the signature of any published binary. Verify the specific artifact before relying on that protection.
- **P2P sharing** — A host chooses read-only or read-write mode. Read-write permits remote terminal commands. A generated 128-bit share key protects connection codes and authenticates the peer; keep both the key and codes private. Connectivity and security across real networks still require runtime verification.
- **Web content and cookies** — Embedded pages run in a webview; Chrome import reads cookies, not passwords. Imported cookies and project sessions should be treated as sensitive account data.
- **Electron sandbox** — The main window runs with `contextIsolation: true` and `sandbox: true`; the preload is restricted to sandbox-safe Electron modules (`webPreferences` in `src/main/main.ts`, `sandbox`), so it cannot import local CommonJS helpers. Keep both flags on and preserve the sandbox-safe preload when changing the Electron privilege boundary; see [security boundaries](docs/security-boundaries.md).
// pi-lens-ignore: MD013/line-length
- **Search index** — The current source build stores extracted user text and working directories as plaintext JSON under Electron user data in `search-index-v3` (`searchIndexDir` in `src/main/session-search-index.ts`). Hashed filenames do not encrypt contents. Treat this directory as local conversation data. Close the app before removing it to rebuild the index; see [storage and limits](docs/performance.md).
- **Hook files** — Inter-process hook data is written below `os.tmpdir()/vibeyard`, which resolves differently on each OS. Keep the directory and session-file validation in place.
