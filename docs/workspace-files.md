# Workspace files

> Custom build (2026-11). This feature is **not** part of the upstream LearnHarness release. It adds a write-capable, workspace-confined file toolset for the Teacher, Practitioner and Prober.

The read-only learner-source tools (`read`, `ls`, `find`, `grep`) can look at files anywhere under your home folder, but they never change anything. The **workspace tools** are the opposite: they can create, edit, rename and (with your approval) delete files, but only inside **one folder you choose**.

## Set up the workspace

1. Open **Settings → Agent → Workspace**.
2. Type the full folder path, or press **Browse…** in the desktop app. Press **Save**.
3. The line under the field tells you whether the folder is usable. If it does not exist yet, press **Create folder**.
4. **Use default** restores the built-in default: `C:\Users\hp\OneDrive\Documents\code understood masterclass`.

The setting is stored in `settings.json` in LearnHarness's data folder, so it survives restarts and updates in both the development server and the packaged app. Folder status is re-checked on every tool call: if the folder is deleted, renamed, set read-only or goes offline, the tools refuse with a clear message instead of guessing.

A workspace can **never** be: a drive root, your whole home folder (or a parent of it), a network share, or any folder that overlaps LearnHarness's own data or credential folders.

## The tools

| Tool | What it does | Approval |
| --- | --- | --- |
| `list_directory` | Lists a folder (default: the workspace root; the absolute workspace path is shown). | no |
| `read_file` | Reads a UTF-8 text file, up to 5 MiB; pages with `offset`/`limit`. | no |
| `write_file` | Creates a **new** file (missing parent folders are created). Fails if the file exists. `overwrite=true` replaces an existing file entirely. | **overwrite only** |
| `edit_file` | Replaces exact text. `old_string` must match exactly once (or set `replace_all`). Preserves CRLF/LF line endings and a UTF-8 BOM. | no |
| `append_file` | Adds text to the end of a file; fails on a missing file unless `create_if_missing` (so a typo cannot spawn a duplicate). | no |
| `create_directory` | Creates a folder and missing parents; succeeds if it already exists. | no |
| `rename_path` | Renames or moves a file or folder inside the workspace. Never overwrites. States source and destination. | no |
| `delete_file` | Deletes **one file**. Folders are never deleted by agents. | **always** |

Every operation reports success only after the filesystem confirms it (size re-checked after writes, existence re-checked after deletes). Failures say what happened and whether anything changed.

Limits: one call writes at most 1 MiB; edit handles files up to 2 MiB; read and append up to 5 MiB. Text files only — binary and non-UTF-8 files are refused, never rewritten.

## How confirmation works

`delete_file` and `write_file` with `overwrite=true` **block the agent** and open a dialog in the app window showing the exact file, its full location, size, last-modified time and a preview of the current (and, for an overwrite, the replacement) content. Nothing changes until you press **Delete file** / **Replace file**.

- The safe button (**Keep file** / **Keep original**) has focus, so pressing Enter never approves. **Esc** also means *keep*.
- If you decline, or do not answer within 10 minutes, or cancel the turn, the file is untouched and the agent is told so; it will not retry.
- If the file changes on disk while the dialog is open, the operation is refused and you are asked to try again.
- The dialog text is built by the server from the validated operation, never from the model's words. The approval endpoint is only reachable by the trusted app window (the same desktop-capability gate as every other `/api` route), so a model cannot approve its own request, and tool arguments have no "approved" flag to forge.

Creating files, editing, appending, creating folders and renaming run without a dialog (they are reversible or additive), but they are still confined to the workspace.

## Security model

Path validation is a server-side boundary, not a UI restriction. Every path an agent supplies goes through `resolveWorkspaceTarget` ([`src/agent/tools/workspace/paths.ts`](../src/agent/tools/workspace/paths.ts)):

1. **Syntax** — NUL/control characters, `..` anywhere, UNC (`\\server\…`) and device (`\\?\`) paths, `:` (drive-relative and NTFS stream names), Windows-reserved names (`CON`, `NUL`, `COM1`…), trailing dots/spaces, over-long names and paths are refused.
2. **Lexical containment** — absolute paths are accepted only if they are inside the workspace; comparison is case-insensitive on Windows.
3. **Links are never followed** — every existing component below the root is checked with `lstat`; a symbolic link or **Windows junction** anywhere on the path is refused, even if it points back inside the workspace. (OneDrive files-on-demand placeholders are not links and work normally.)
4. **Canonical containment** — the real path must still lie inside the canonical workspace root.
5. **Protected locations** — `.env` files, credential and subscription files, sensitive home folders (`.ssh` etc.) and LearnHarness's own data/auth folders are unreachable, and invisible in listings.
6. **Safe writes** — changes go to a temp file beside the target and are renamed into place, so a crash cannot leave a half-written file; every mutation re-validates the path and confirms the file did not change since it was read.
7. **No bulk destruction** — there is no recursive delete, no folder delete, and the workspace root cannot be renamed, deleted or overwritten.

Known limits (be honest about them): path checks cannot stop a hostile local process that swaps a folder for a link in the microseconds between the check and the operation; a rename on Windows/POSIX replaces nothing but is not atomic against a concurrent creator of the destination name; and text you let an agent read can be sent to your configured model provider, as with any LearnHarness file tool. Deletion is permanent (no Recycle Bin).

## Which agents have the tools

The Teacher, Practitioner and Prober, always on (they are not part of the user's tool toggles). Research, demo, visual, PDF, extraction and graph workers never receive them — a source-scan test pins this. Prompt guidance lives in [`shared/35-workspace-files.md`](../src/agent/prompts/shared/35-workspace-files.md), [`teacher/60-workspace.md`](../src/agent/prompts/teacher/60-workspace.md), [`prober/20-workspace.md`](../src/agent/prompts/prober/20-workspace.md) and [`practice/20-workspace.md`](../src/agent/prompts/practice/20-workspace.md); the practitioner prompt also forbids writing a problem's solution into any file before `conclude`.

## Build and install on Windows

Build **on Windows** (the release guide requires building on the target OS). Two PowerShell scripts in [`scripts/windows/`](../scripts/windows/) cover it:

1. **Back up your data first** — close LearnHarness, then:
   `powershell -ExecutionPolicy Bypass -File scripts\windows\backup-learnharness-data.ps1`
   It copies `%APPDATA%\LearnHarness` (chats, graph, settings, provider config, credentials) to `C:\Users\hp\Development\learnharness-backups\LearnHarness-userdata_<timestamp>`, re-hashes every file on both sides, and prints `VERIFIED` only when all match. It never changes the original. The backup holds your credentials: keep it outside OneDrive.
2. **Build the installer**:
   `powershell -ExecutionPolicy Bypass -File scripts\windows\build-windows-installer.ps1`
   It runs the repository's pipeline (`npm ci`, type-check, lint, workspace tests, `npm run build`, provider and server smoke tests, `electron-builder --win --x64`) and prints the installer path, size and SHA-256 (`dist\LearnHarness-<version>-x64-setup.exe`).
3. **Install** by running that installer. It is a per-user installer; your data stays in `%APPDATA%\LearnHarness` and the new build reads it as-is (no migration was added). Settings → Agent → Workspace is saved in the same `settings.json`.
4. **Turn off automatic updates** (Settings → Updates). The custom build carries the upstream version number, so the updater could otherwise replace it with an upstream release that lacks this feature.

No API key or credential is bundled: the build copies source and the curated standalone server only, and `scripts/build-server.mjs` refuses known data/credential leaks.

To restore a backup, close LearnHarness and copy the backup's contents over `%APPDATA%\LearnHarness`.

## Troubleshooting

| Message | What to do |
| --- | --- |
| "The workspace folder does not exist" | Settings → Agent → Workspace → **Create folder**, or choose another folder. |
| "…cannot overlap LearnHarness's own data" / "home folder" | Choose a dedicated subfolder (for example inside Documents). |
| "permission denied (read-only file or folder, or blocked by Windows, antivirus or OneDrive)" | Check the folder is not read-only; if it is in OneDrive, make sure the file is not marked "online-only" and sync is not paused; try another folder to confirm. |
| "the file is locked by another program" | Close the file in Word/Obsidian/etc. (or wait for OneDrive to finish syncing) and ask again. |
| "is a symbolic link or junction" | Workspace tools never follow links. Use real folders inside the workspace. |
| "outside the workspace" | The agent used a path outside the folder. Ask for a path relative to the workspace root. |
| No approval dialog appears | Keep the LearnHarness window open and in front; the request times out after 10 minutes and the file is left alone. |
| "the full path is longer than the Windows limit" | Use a shorter workspace path or shorter names. |

## For developers

- Agent layer: [`src/agent/tools/workspace/`](../src/agent/tools/workspace/) — `policy.ts` (injected policy + approval seams, fail-closed), `paths.ts` (the guard), `fileops.ts` (the eight operations), `tools.ts` (schemas; sequential execution). Composition: `src/agent/tools.ts` (teacher, prober) and `src/agent/tools/practice.ts`.
- Core/store/server: `src/core/workspace.ts` (setting syntax + default), `agent.workspace` in `src/core/settings.ts`, strict reader `readWorkspaceSettings` in `src/store/settings.ts`, `src/server/workspace.ts` (policy + status + create), `src/server/workspace-approvals.ts` (broker, globalThis-backed), routes under `app/api/workspace/`, wiring in `chat-handler.ts`.
- UI: `components/workspace-approval-dialog.tsx` (mounted in `app/layout.tsx`), `components/settings/workspace-row.tsx`, tool cards in `components/artifacts/`.
- Tests: `tests/workspace-fileops.test.ts`, `tests/workspace-integration.test.ts`, `tests/workspace-ui.test.tsx`. All use temporary directories and a synthetic HOME/data/auth location. The Windows-junction test runs only on Windows (`skip` elsewhere); the real-permission test is skipped when run as root or on Windows.
