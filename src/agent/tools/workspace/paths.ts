import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AUTH_FILE, PATHS } from "../../../../config.ts";
import { isWorkspaceRootSyntax } from "../../../core/workspace.ts";
import { comparisonPath } from "../file-access.ts";
import { isSensitivePath } from "../fs-shared.ts";
import { workspacePolicy } from "./policy.ts";

/**
 * THE WORKSPACE PATH GUARD — the security boundary for every agent-authored
 * file operation. Not a UI restriction: every tool resolves its paths here,
 * on the server, at call time, and refuses anything this module cannot prove
 * is inside the configured workspace.
 *
 * Layers (all must pass):
 *  1. Syntax: no NUL/control characters, no UNC/device namespaces, no `..`,
 *     no NTFS stream/drive-relative `:` forms, no Windows-reserved names, no
 *     trailing dot/space segments (they silently alias other names on NTFS).
 *  2. Lexical containment against BOTH the configured root and its canonical
 *     (realpath) form, with Windows-style case-insensitive comparison.
 *  3. Link refusal: every EXISTING component below the root is lstat'ed; a
 *     symbolic link or Windows junction is refused outright — even one that
 *     points back inside the workspace. (Node reports junctions as symlinks.)
 *     OneDrive "files on demand" placeholders are NOT symlinks and keep working.
 *  4. Canonical containment: the realpath of the target (or of its deepest
 *     existing ancestor plus the not-yet-existing tail) must still sit inside
 *     the canonical root. Catches 8.3 short names, case games and anything
 *     the link walk could miss.
 *  5. Protected locations: credential files, .env files, sensitive home
 *     folders (fs-shared.isSensitivePath) and the app's own data/auth folders
 *     are never reachable, even if the workspace were misconfigured to
 *     overlap them (assessWorkspaceRoot refuses such a root outright).
 *
 * Known limit (documented in docs/workspace-files.md): path checks cannot
 * defeat a hostile process that swaps a directory for a link between this
 * check and the following syscall. Mutations re-resolve immediately before
 * acting and write via temp-file + rename to narrow the window.
 */

export type WorkspaceErrorCode =
	| "unavailable"
	| "invalid-path"
	| "outside-workspace"
	| "link"
	| "protected"
	| "not-found"
	| "exists"
	| "wrong-type"
	| "too-large"
	| "permission"
	| "locked"
	| "io"
	| "binary"
	| "conflict"
	| "not-approved";

/** The message is written for the MODEL: it states what failed and what to do. */
export class WorkspaceError extends Error {
	readonly code: WorkspaceErrorCode;
	constructor(code: WorkspaceErrorCode, message: string) {
		super(message);
		this.name = "WorkspaceError";
		this.code = code;
	}
}

const CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";
const MAX_SEGMENT_LENGTH = 255;
const MAX_RELATIVE_LENGTH = 240;
const WINDOWS_MAX_PATH = 259;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ILLEGAL_SEGMENT_CHARS = /[<>:"|?*]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function pathKey(p: string): string {
	const normalized = comparisonPath(p);
	return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized;
}

/** Segment-aware containment (never a string-prefix test: `/ws2` is not in `/ws`). */
export function isInside(parent: string, child: string, allowEqual = true): boolean {
	const rel = path.relative(pathKey(parent), pathKey(child));
	if (rel === "") return allowEqual;
	return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** `child` relative to `parent`, keeping the child's ORIGINAL letter case. */
function relativeKeepingCase(parent: string, child: string): string | null {
	if (!isInside(parent, child)) return null;
	const parentKey = pathKey(parent);
	const childAbs = path.resolve(child);
	const childKey = pathKey(childAbs);
	if (childKey === parentKey) return "";
	if (childKey.length === childAbs.length && parentKey.length <= childAbs.length) {
		return childAbs.slice(parentKey.length).replace(/^[\\/]+/, "");
	}
	return path.relative(parentKey, childKey);
}

function toPosix(p: string): string {
	return p.split(path.sep).join("/");
}

// ─── Workspace root ──────────────────────────────────────────────────────────

export type RootAssessment =
	| { ok: true; real: string }
	| { ok: false; code: "invalid" | "missing" | "not-directory" | "not-writable" | "protected" | "unreadable"; message: string };

/** Protected app-private folders the workspace may never overlap. */
function appPrivateFolders(): string[] {
	return [PATHS.data, path.dirname(AUTH_FILE)];
}

/** Roots the workspace may never be, contain, or sit inside. Shared by the
 *  live assessment and the pre-creation check. Returns a message or null. */
function rootOverlapProblem(real: string): string | null {
	let home: string | null = null;
	try { home = fs.realpathSync.native(os.homedir()); } catch { home = null; }
	if (home && isInside(real, home)) {
		return "The workspace cannot be your home folder or a folder that contains it. Choose a dedicated subfolder.";
	}
	for (const folder of appPrivateFolders()) {
		let protectedReal = folder;
		try { protectedReal = fs.realpathSync.native(folder); } catch { /* not created yet: lexical form still protects */ }
		if (isInside(protectedReal, real) || isInside(real, protectedReal)) {
			return "The workspace cannot overlap LearnHarness's own data or credentials. Choose a different folder.";
		}
	}
	if (isSensitivePath(real)) return "The workspace is a protected location and cannot be used.";
	return null;
}

/** For "Create folder": the same protections as assessWorkspaceRoot, applied
 *  to a folder that does not exist yet (nearest existing ancestor + the rest).
 *  Returns a problem message, or null when creating it would be acceptable. */
export function prospectiveRootProblem(rootRaw: string): string | null {
	const syntax = isWorkspaceRootSyntax(rootRaw);
	if (!syntax.ok) return syntax.error;
	if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(rootRaw)) {
		return `The workspace path "${rootRaw}" is a Windows path but this server is not running on Windows.`;
	}
	let existing = path.resolve(rootRaw);
	const rest: string[] = [];
	while (!fs.existsSync(existing)) {
		rest.unshift(path.basename(existing));
		const parent = path.dirname(existing);
		if (parent === existing) return "The drive or parent folder for this workspace does not exist.";
		existing = parent;
	}
	let base: string;
	try {
		base = fs.realpathSync.native(existing);
		if (!fs.statSync(base).isDirectory()) return "A parent of the workspace path is a file, not a folder.";
	} catch {
		return "A parent of the workspace path cannot be opened.";
	}
	for (const segment of rest) {
		try { validateSegment(segment, "workspace"); } catch (error) { return (error as Error).message; }
	}
	return rootOverlapProblem(path.join(base, ...rest));
}

/** Is this folder usable as a workspace RIGHT NOW? Used by every tool call
 *  (fresh, so a deleted/replaced/relinked folder is noticed) and by the
 *  Settings status route. Never creates anything. */
export function assessWorkspaceRoot(rootRaw: string): RootAssessment {
	const syntax = isWorkspaceRootSyntax(rootRaw);
	if (!syntax.ok) return { ok: false, code: "invalid", message: syntax.error };
	if (process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(rootRaw)) {
		return { ok: false, code: "invalid", message: `The workspace path "${rootRaw}" is a Windows path but this server is not running on Windows.` };
	}
	const configured = path.resolve(rootRaw);
	let real: string;
	try {
		real = fs.realpathSync.native(configured);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { ok: false, code: "missing", message: `The workspace folder does not exist: ${configured}. Create it in Settings → Agent → Workspace (or choose another folder).` };
		}
		return { ok: false, code: "unreadable", message: `The workspace folder cannot be opened (${code ?? "unknown error"}): ${configured}.` };
	}
	try {
		if (!fs.statSync(real).isDirectory()) return { ok: false, code: "not-directory", message: `The workspace path is not a folder: ${configured}.` };
		fs.accessSync(real, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return { ok: false, code: "not-writable", message: `The workspace folder is not readable and writable (${code ?? "permission denied"}): ${configured}.` };
	}
	const overlap = rootOverlapProblem(real);
	if (overlap) return { ok: false, code: "protected", message: overlap };
	return { ok: true, real };
}

/** The active workspace's canonical root, or a WorkspaceError the model can
 *  relay to the learner verbatim. */
export function requireWorkspaceRoot(): { configured: string; real: string } {
	const policy = workspacePolicy();
	if (!policy.root) {
		throw new WorkspaceError("unavailable", `Workspace unavailable: ${policy.error ?? "no workspace is configured"} Tell the learner to set it in Settings → Agent → Workspace.`);
	}
	const assessment = assessWorkspaceRoot(policy.root);
	if (!assessment.ok) throw new WorkspaceError("unavailable", `Workspace unavailable: ${assessment.message}`);
	return { configured: path.resolve(policy.root), real: assessment.real };
}

// ─── Target resolution ───────────────────────────────────────────────────────

export interface WorkspaceTarget {
	/** Canonical workspace root. */
	root: string;
	/** Canonical absolute path of the target (existing parts canonicalised). */
	absolute: string;
	/** Workspace-relative path with forward slashes ("" for the root). */
	relative: string;
	exists: boolean;
	/** lstat of the target when it exists (no links are ever followed). */
	stat: fs.Stats | null;
	isRoot: boolean;
}

export interface ResolveOptions {
	/** Allow the workspace root itself as a target (list_directory only). */
	allowRoot?: boolean;
	/** Fail with not-found when the target does not exist. */
	mustExist?: boolean;
	/** Used in error messages: which argument was this? */
	label?: string;
}

function validateSegment(segment: string, label: string): void {
	if (segment === "..") {
		throw new WorkspaceError("invalid-path", `${label}: parent-directory segments ('..') are not allowed. Use a path relative to the workspace root.`);
	}
	if (CONTROL_CHARS.test(segment)) throw new WorkspaceError("invalid-path", `${label}: control characters are not allowed in paths.`);
	if (ILLEGAL_SEGMENT_CHARS.test(segment)) {
		throw new WorkspaceError("invalid-path", `${label}: "${segment}" contains a character that is not allowed in file names (< > : " | ? *).`);
	}
	if (/[ .]$/.test(segment)) {
		throw new WorkspaceError("invalid-path", `${label}: "${segment}" must not end with a space or a period.`);
	}
	if (RESERVED_NAME.test(segment)) {
		throw new WorkspaceError("invalid-path", `${label}: "${segment}" is a reserved Windows device name.`);
	}
	if (segment.length > MAX_SEGMENT_LENGTH) throw new WorkspaceError("invalid-path", `${label}: a path segment is longer than ${MAX_SEGMENT_LENGTH} characters.`);
}

function outside(label: string, raw: string): WorkspaceError {
	return new WorkspaceError(
		"outside-workspace",
		`${label}: "${raw}" is outside the workspace. File tools only work inside the workspace folder; use a path relative to it (for example "notes/limits.md").`,
	);
}

/**
 * Resolve ONE agent-supplied path to a verified location inside the
 * workspace, or throw a WorkspaceError. The only door file tools may use.
 */
export function resolveWorkspaceTarget(rawInput: unknown, options: ResolveOptions = {}): WorkspaceTarget {
	const label = options.label ?? "path";
	if (typeof rawInput !== "string") throw new WorkspaceError("invalid-path", `${label} must be a string.`);
	const raw = rawInput;
	const { configured, real: root } = requireWorkspaceRoot();

	if (raw.length > 1024) throw new WorkspaceError("invalid-path", `${label} is too long.`);
	if (CONTROL_CHARS.test(raw)) throw new WorkspaceError("invalid-path", `${label}: control characters are not allowed in paths.`);
	if (raw.startsWith("\\\\") || raw.startsWith("//")) {
		throw new WorkspaceError("invalid-path", `${label}: network (UNC) and device paths are not allowed.`);
	}

	const drivePrefix = /^[A-Za-z]:[\\/]/.test(raw);
	const rooted = path.isAbsolute(raw) || drivePrefix || raw.startsWith("/") || raw.startsWith("\\");
	let segments: string[];

	if (rooted) {
		// A rooted path is accepted only when it is lexically inside the workspace.
		if (!path.isAbsolute(raw)) throw outside(label, raw); // e.g. a drive path on POSIX, or "\foo" on POSIX
		if (!drivePrefix && raw.slice(1).includes(":")) throw new WorkspaceError("invalid-path", `${label}: ':' is not allowed in paths.`);
		if (drivePrefix && raw.slice(2).includes(":")) throw new WorkspaceError("invalid-path", `${label}: ':' is not allowed after the drive letter.`);
		if (raw.split(/[\\/]+/).includes("..")) {
			throw new WorkspaceError("invalid-path", `${label}: parent-directory segments ('..') are not allowed. Use a path relative to the workspace root.`);
		}
		const candidate = path.resolve(raw);
		const rel = relativeKeepingCase(configured, candidate) ?? relativeKeepingCase(root, candidate);
		if (rel === null) throw outside(label, raw);
		segments = rel.split(/[\\/]+/).filter((s) => s.length > 0);
	} else {
		if (raw.includes(":")) {
			throw new WorkspaceError("invalid-path", `${label}: ':' is not allowed in paths (drive-relative and stream names are refused).`);
		}
		segments = raw.split(/[\\/]+/).filter((s) => s.length > 0 && s !== ".");
	}

	for (const segment of segments) validateSegment(segment, label);
	if (segments.join("/").length > MAX_RELATIVE_LENGTH) {
		throw new WorkspaceError("invalid-path", `${label}: the path is longer than ${MAX_RELATIVE_LENGTH} characters.`);
	}

	if (segments.length === 0) {
		if (!options.allowRoot) {
			throw new WorkspaceError("invalid-path", `${label}: this operation cannot target the workspace root itself. Name a file or folder inside it.`);
		}
		return { root, absolute: root, relative: "", exists: true, stat: fs.lstatSync(root), isRoot: true };
	}

	// Walk existing components with lstat: refuse links, stop at the first missing one.
	let current = root;
	let exists = true;
	let stat: fs.Stats | null = null;
	let existingDepth = 0;
	for (let i = 0; i < segments.length; i++) {
		const next = path.join(current, segments[i]!);
		let st: fs.Stats;
		try {
			st = fs.lstatSync(next);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") { exists = false; break; }
			if (code === "ENOTDIR") throw new WorkspaceError("wrong-type", `${label}: a parent in "${segments.slice(0, i + 1).join("/")}" is a file, not a folder.`);
			throw describeFsError(error, "access", segments.slice(0, i + 1).join("/"));
		}
		if (st.isSymbolicLink()) {
			throw new WorkspaceError("link", `${label}: "${segments.slice(0, i + 1).join("/")}" is a symbolic link or junction. Links are never followed by workspace tools.`);
		}
		if (i < segments.length - 1 && !st.isDirectory()) {
			throw new WorkspaceError("wrong-type", `${label}: "${segments.slice(0, i + 1).join("/")}" is a file, not a folder.`);
		}
		current = next;
		stat = st;
		existingDepth = i + 1;
	}

	let absolute: string;
	try {
		const base = fs.realpathSync.native(current);
		absolute = exists ? base : path.join(base, ...segments.slice(existingDepth));
	} catch (error) {
		throw describeFsError(error, "resolve", segments.join("/"));
	}
	if (!isInside(root, absolute)) throw outside(label, raw);
	if (absolute.length > WINDOWS_MAX_PATH && process.platform === "win32") {
		throw new WorkspaceError("invalid-path", `${label}: the full path is longer than the Windows limit of ${WINDOWS_MAX_PATH} characters. Use a shorter path.`);
	}
	if (isSensitivePath(absolute) || appPrivateFolders().some((folder) => isInside(folder, absolute))) {
		throw new WorkspaceError("protected", `${label}: "${segments.join("/")}" is a protected location and cannot be accessed.`);
	}
	if (!exists && options.mustExist) {
		throw new WorkspaceError("not-found", `${label}: "${segments.join("/")}" does not exist. Use list_directory to see what is in the workspace.`);
	}
	const relative = relativeKeepingCase(root, absolute) ?? segments.join("/");
	return { root, absolute, relative: toPosix(relative), exists, stat: exists ? stat : null, isRoot: false };
}

// ─── Error translation ───────────────────────────────────────────────────────

/** Map an fs failure to an explicit, model-actionable message. */
export function describeFsError(error: unknown, action: string, relative: string): WorkspaceError {
	if (error instanceof WorkspaceError) return error;
	const code = (error as NodeJS.ErrnoException)?.code;
	const where = relative ? `"${relative}"` : "the workspace";
	switch (code) {
		case "ENOENT":
			return new WorkspaceError("not-found", `Cannot ${action} ${where}: it does not exist.`);
		case "EEXIST":
			return new WorkspaceError("exists", `Cannot ${action} ${where}: something with that name already exists.`);
		case "ENOTDIR":
			return new WorkspaceError("wrong-type", `Cannot ${action} ${where}: a parent in the path is a file, not a folder.`);
		case "EISDIR":
			return new WorkspaceError("wrong-type", `Cannot ${action} ${where}: it is a folder, not a file.`);
		case "ENOTEMPTY":
			return new WorkspaceError("conflict", `Cannot ${action} ${where}: the folder is not empty.`);
		case "EACCES":
		case "EPERM":
		case "EROFS":
			return new WorkspaceError("permission", `Cannot ${action} ${where}: permission denied (read-only file or folder, or blocked by Windows, antivirus or OneDrive). The operation was NOT performed.`);
		case "EBUSY":
		case "ETXTBSY":
			return new WorkspaceError("locked", `Cannot ${action} ${where}: the file is locked by another program (for example Word, Obsidian or OneDrive sync). Ask the learner to close it, then retry. The operation was NOT performed.`);
		case "ENOSPC":
			return new WorkspaceError("io", `Cannot ${action} ${where}: the disk is full.`);
		case "ENAMETOOLONG":
			return new WorkspaceError("invalid-path", `Cannot ${action} ${where}: the path is too long.`);
		case "EMFILE":
		case "ENFILE":
			return new WorkspaceError("io", `Cannot ${action} ${where}: too many files are open; retry shortly.`);
		case "EXDEV":
			return new WorkspaceError("io", `Cannot ${action} ${where}: the move crosses file systems.`);
		default:
			return new WorkspaceError("io", `Cannot ${action} ${where}: ${(error as Error)?.message ?? "unknown error"}${code ? ` (${code})` : ""}. The operation may not have completed; verify with list_directory.`);
	}
}
