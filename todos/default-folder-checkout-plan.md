# Plan: default projects folder + git-URL project creation ("Checkout and create")

Date: 2026-10-21 · Status: todo · Owner: TBD

## Request

1. **Settings** should have a **default projects folder**: a root directory under which
   new projects are created, so the user no longer types a full path for every project.
2. **Add project** should accept a **GitHub or Codeberg URL**. From the URL, derive the
   **project name** and a **subfolder location** (`<default folder>/<repo-name>`). When a
   URL is entered, the create button becomes **"Checkout and create"** and cloning is
   performed before the project is registered.

## Current behavior (investigated)

Add-project modal: `src/renderer/components/sidebar.ts:482-619` `promptNewProject()` —
fields name / path / optional profile via `showModal()` (`components/modal.ts:74-83`;
custom confirm label is already supported through `ModalOptions.confirmLabel`,
`modal.ts:59-61`). Path browse uses `window.vibeyard.fs.browseDirectory()`; completion
validates with `fs.expandPath` + `fs.isDirectory` and refuses non-existent directories
(`sidebar.ts:516-521`, i18n key `sidebar.newProject.directoryNotExist`), then calls
`appState.addProject(name, projectPath, profile)` (`state.ts:419`). Name auto-fills from
the browsed directory via `deriveProjectName(path)` unless manually edited
(`sidebar.ts:527-535`).

Settings: `src/renderer/components/preferences-modal.ts` — section registry
(`preferences/general-section.ts` etc. via `preferences/section.ts`); persisted settings
live in `appState.preferences`. No projects-root / default-folder preference exists today.

Main process: `src/main/ipc-handlers.ts` has `fs:expandPath` (419) and
`fs:browseDirectory` (771) — **no git-clone IPC exists** (`grep clone` → no matches in
ipc-handlers). A new handler is needed.

## Work items

### 1. Default projects folder (settings)

- New preference, e.g. `preferences.defaultProjectsFolder: string` (empty = unset,
  preserve current free-path behavior), edited in the General section with a text input +
  browse button (reuse `fs.browseDirectory`).
- In `promptNewProject()`: when the setting is set, pre-fill the path field as
  `<default folder>/<name>` and sync it while the name is edited (same
  `nameManuallyEdited` style guard, applied to both fields).
- Backfill in `state/persistence.ts` `ensureProjectDefaults` so the field is defined on
  load.

### 2. URL-based creation ("Checkout and create")

- Detect GitHub/Codeberg URLs in the path field (also accept `git@github.com:…`,
  `https://…/repo`, trailing `.git`). Host allowlist: `github.com`, `codeberg.org`
  (+ `www.` variants).
- Derive repo name from the last URL path segment (strip `.git`) → fills project name
  and target path `<default folder>/<repo-name>`.
- While a valid URL is present, `showModal(..., { confirmLabel: t('…checkoutAndCreate') })`
  → button reads **"Checkout and create"**; skip the `isDirectory` validation for URLs.
- New IPC `fs:cloneRepo(url, destPath)` in `ipc-handlers.ts` + preload bridge:
  spawn `git clone <url> <dest>` (git availability check; surface stderr on failure).
  Reject when `destPath` exists and is non-empty.
- Flow: URL → clone into target → `addProject(name, target, profile)`. Clone is the
  slow step: disable the confirm button and show progress/state in the modal
  (`setModalError` for failures) before closing.
- URL entry with no default folder set: prompt for the parent folder (browse dialog)
  or block with a modal error pointing at the new setting — decide during
  implementation; browse-prompt fallback is the friendlier default.

### 3. i18n + tests

- New keys under `sidebar.newProject.*` (e.g. `urlPlaceholder`, `checkoutAndCreate`,
  `cloning`, `cloneFailed`, `invalidUrl`) and `preferences.general.*` for the setting.
- Tests: URL parser (github/codeberg/ssh/.git/trailing slash), name+subfolder
  derivation, button-label switch, clone-failure path; extend
  `sidebar-preferences.test.ts` stubs as needed.

## Acceptance

- Setting a default folder pre-fills the new-project path and persists across restarts.
- Pasting `https://github.com/owner/repo` (or Codeberg / ssh form) fills name `repo`
  and path `<default folder>/repo`; button reads "Checkout and create"; confirm clones
  the repo and opens the project. Clone failure shows an inline error, modal stays open.
- Existing manual path/name flow unchanged when no URL is entered.
