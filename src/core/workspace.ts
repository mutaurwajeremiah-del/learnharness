/**
 * WORKSPACE SETTINGS (custom build, 2026-11): the one folder the learner-facing
 * agents may CREATE, EDIT, RENAME and (with approval) DELETE files in.
 *
 * This is deliberately separate from `fileAccess` (read-only, whole-home
 * learner sources). Pure core: syntax only — no fs, no os. Whether the folder
 * exists, is writable, or overlaps app-private data is decided at the IO layer
 * (agent/tools/workspace/paths.ts) at the moment of each operation.
 */

/** Used only while `agent.workspace` is absent from settings.json. The
 *  learner can change it in Settings → Agent → Workspace. */
export const DEFAULT_WORKSPACE_ROOT = "C:\\Users\\hp\\OneDrive\\Documents\\code understood masterclass";

export interface WorkspaceSettings {
	/** Absolute path of the workspace folder (local drive path or POSIX absolute). */
	root: string;
}

export type WorkspaceSettingsResult =
	| { ok: true; settings: WorkspaceSettings }
	| { ok: false; error: string };

const MAX_ROOT_LENGTH = 240;

/** Windows drive letter + separator, or a POSIX absolute path. UNC shares and
 *  device namespaces (\\?\, \\.\) are refused: a network share or raw device
 *  path cannot be canonicalised or compared reliably. */
export function isWorkspaceRootSyntax(value: string): { ok: true } | { ok: false; error: string } {
	if (value.length === 0) return { ok: false, error: "workspace.root must not be empty" };
	if (value.length > MAX_ROOT_LENGTH) return { ok: false, error: `workspace.root must be at most ${MAX_ROOT_LENGTH} characters` };
		if (/[\u0000-\u001f]/.test(value)) return { ok: false, error: "workspace.root must not contain control characters" };
	if (value.startsWith("\\\\") || value.startsWith("//")) {
		return { ok: false, error: "workspace.root must be a local folder, not a network share or device path" };
	}
	const drive = /^[A-Za-z]:[\\/]/.test(value);
	const posix = value.startsWith("/");
	if (!drive && !posix) return { ok: false, error: "workspace.root must be an absolute path, e.g. C:\\Users\\you\\Documents\\notes" };
	if (/^[A-Za-z]:[\\/]?$/.test(value) || value === "/") {
		return { ok: false, error: "workspace.root cannot be a drive root; choose a dedicated folder" };
	}
	// A colon is only legal as the drive-letter separator (blocks NTFS alternate data streams).
	if (value.slice(drive ? 2 : 0).includes(":")) return { ok: false, error: "workspace.root must not contain ':' after the drive letter" };
	if (/(^|[\\/])\.\.([\\/]|$)/.test(value)) return { ok: false, error: "workspace.root must not contain '..' segments" };
	return { ok: true };
}

/** The strict parser shared by the settings write route and the store reader:
 *  a malformed workspace must never silently decay into the default folder. */
export function parseWorkspaceSettings(raw: unknown): WorkspaceSettingsResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "workspace must be an object" };
	const value = raw as Record<string, unknown>;
	if (Object.keys(value).some((key) => key !== "root")) return { ok: false, error: "workspace contains unsupported fields" };
	if (typeof value.root !== "string") return { ok: false, error: "workspace.root must be a string" };
	const root = value.root.trim();
	const syntax = isWorkspaceRootSyntax(root);
	if (!syntax.ok) return syntax;
	return { ok: true, settings: { root } };
}
