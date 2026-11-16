import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { capOutput, formatSize, isSensitivePath, MAX_OUTPUT_BYTES } from "../fs-shared.ts";
import { workspaceApprovalBroker, type WorkspaceApprovalInput } from "./policy.ts";
import { describeFsError, resolveWorkspaceTarget, WorkspaceError, type WorkspaceTarget } from "./paths.ts";

/**
 * The eight workspace operations. Every one resolves its paths through
 * resolveWorkspaceTarget (the security boundary), reports success ONLY after
 * the filesystem confirms it, and throws a WorkspaceError whose message tells
 * the model exactly what happened and what to do next.
 */

export const MAX_WRITE_BYTES = 1024 * 1024; // one tool call writes at most 1 MiB
export const MAX_EDIT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // read / append ceiling
const READ_MAX_LINES = 2000;
const LIST_DEFAULT_LIMIT = 500;
const TEMP_PREFIX = ".lh-tmp-";
const PREVIEW_LINES = 12;
const PREVIEW_CHARS = 800;

export interface OpContext {
	chatId: string;
	toolCallId: string;
	signal?: AbortSignal;
}

// ─── text helpers ────────────────────────────────────────────────────────────

interface DecodedText {
	text: string;
	bom: boolean;
}

function decodeUtf8(buffer: Buffer, relative: string): DecodedText {
	if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) {
		throw new WorkspaceError("binary", `"${relative}" looks like a binary file; workspace tools only handle UTF-8 text files.`);
	}
	const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
	try {
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? buffer.subarray(3) : buffer);
		return { text, bom };
	} catch {
		throw new WorkspaceError("binary", `"${relative}" is not valid UTF-8 text, so it was left untouched.`);
	}
}

function encodeUtf8(text: string, bom: boolean): Buffer {
	const body = Buffer.from(text, "utf-8");
	return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

type Eol = "crlf" | "lf" | "mixed" | "none";

function detectEol(text: string): Eol {
	const crlf = (text.match(/\r\n/g) ?? []).length;
	const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
	if (crlf === 0 && lf === 0) return "none";
	if (crlf > 0 && lf === 0) return "crlf";
	if (lf > 0 && crlf === 0) return "lf";
	return "mixed";
}

/** Make model-supplied text use the file's own line endings (files on Windows
 *  are often CRLF; models emit LF). Mixed files are matched exactly. */
function toEol(value: string, eol: Eol): string {
	if (eol === "crlf") return value.replace(/\r?\n/g, "\r\n");
	if (eol === "lf") return value.replace(/\r\n/g, "\n");
	return value;
}

function countLines(text: string): number {
	return text.length === 0 ? 0 : text.split(/\r\n|\n/).length - (/\n$/.test(text) ? 1 : 0);
}

function preview(text: string): string {
	const lines = text.split(/\r\n|\n/).slice(0, PREVIEW_LINES).join("\n");
	return lines.length > PREVIEW_CHARS ? `${lines.slice(0, PREVIEW_CHARS)}…` : lines;
}

function assertNoNul(content: string, label: string): void {
	if (content.includes("\u0000")) throw new WorkspaceError("binary", `${label} contains a NUL character; only plain text can be written.`);
}

function assertWritable(bytes: number, label: string): void {
	if (bytes > MAX_WRITE_BYTES) {
		throw new WorkspaceError("too-large", `${label} is ${formatSize(bytes)}; a single call may write at most ${formatSize(MAX_WRITE_BYTES)}. Split it into several files or append in parts.`);
	}
}

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

// ─── safe writing ────────────────────────────────────────────────────────────

/** Exclusive create (fails if the name appeared meanwhile). A partial NEW file
 *  is removed on failure; an existing file is never touched here. */
async function createNewFile(target: WorkspaceTarget, data: Buffer): Promise<void> {
	let handle: fsp.FileHandle | undefined;
	let created = false;
	try {
		handle = await fsp.open(target.absolute, "wx", 0o644);
		created = true;
		await handle.writeFile(data);
		await handle.sync();
		await handle.close();
		handle = undefined;
	} catch (error) {
		await handle?.close().catch(() => undefined);
		if (created) await fsp.unlink(target.absolute).catch(() => undefined);
		throw describeFsError(error, "create", target.relative);
	}
}

/** Replace an existing file without ever leaving it half-written: write a temp
 *  file beside it, flush, then rename over the original. */
async function replaceFileAtomically(target: WorkspaceTarget, data: Buffer): Promise<void> {
	const temp = path.join(path.dirname(target.absolute), `${TEMP_PREFIX}${randomUUID()}`);
	let handle: fsp.FileHandle | undefined;
	try {
		handle = await fsp.open(temp, "wx", 0o644);
		await handle.writeFile(data);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fsp.rename(temp, target.absolute);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fsp.unlink(temp).catch(() => undefined);
		throw describeFsError(error, "write", target.relative);
	}
}

async function verifySize(target: WorkspaceTarget, expectedBytes: number, action: string): Promise<void> {
	let stat: fs.Stats;
	try {
		stat = await fsp.lstat(target.absolute);
	} catch (error) {
		throw new WorkspaceError("io", `The ${action} of "${target.relative}" could not be verified (${(error as NodeJS.ErrnoException).code ?? "error"}). Do not assume it succeeded; check with read_file.`);
	}
	if (stat.size !== expectedBytes) {
		throw new WorkspaceError("io", `The ${action} of "${target.relative}" could not be verified: expected ${expectedBytes} bytes on disk but found ${stat.size}. Check with read_file.`);
	}
}

/** The file we validated must be the file we mutate: refuse if it changed. */
async function assertUnchanged(target: WorkspaceTarget, before: fs.Stats): Promise<void> {
	let now: fs.Stats;
	try {
		now = await fsp.lstat(target.absolute);
	} catch {
		throw new WorkspaceError("conflict", `"${target.relative}" disappeared while the operation was in progress. Nothing was changed.`);
	}
	if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
		throw new WorkspaceError("conflict", `"${target.relative}" changed on disk while the operation was in progress (the learner or another program edited it). Nothing was changed; read_file it again and retry.`);
	}
}

async function ensureParentFolders(target: WorkspaceTarget): Promise<string[]> {
	const parent = path.dirname(target.absolute);
	if (fs.existsSync(parent)) return [];
	const missing: string[] = [];
	let cursor = parent;
	while (!fs.existsSync(cursor) && cursor !== target.root) {
		missing.unshift(cursor);
		cursor = path.dirname(cursor);
	}
	try {
		await fsp.mkdir(parent, { recursive: true });
	} catch (error) {
		throw describeFsError(error, "create folder for", target.relative);
	}
	return missing.map((p) => path.relative(target.root, p).split(path.sep).join("/"));
}

// ─── approvals ───────────────────────────────────────────────────────────────

async function requireApproval(input: WorkspaceApprovalInput, signal: AbortSignal | undefined): Promise<void> {
	const broker = workspaceApprovalBroker();
	if (!broker) {
		throw new WorkspaceError("not-approved", "No approval channel is available, so this operation was NOT performed. Tell the learner to do it themselves in File Explorer.");
	}
	const outcome = await broker.request(input, signal);
	if (outcome.status === "approved") return;
	const what = input.operation === "delete_file" ? "deletion" : "overwrite";
	switch (outcome.status) {
		case "denied":
			throw new WorkspaceError("not-approved", `The learner DECLINED the ${what} of "${input.relativePath}". The file was NOT changed. Do not retry; ask the learner what they would like instead.`);
		case "timeout":
			throw new WorkspaceError("not-approved", `The learner did not answer the ${what} request for "${input.relativePath}" in time. The file was NOT changed. Ask them in chat whether to try again.`);
		case "aborted":
			throw new WorkspaceError("not-approved", `The ${what} request for "${input.relativePath}" was cancelled. The file was NOT changed.`);
		default:
			throw new WorkspaceError("not-approved", `The ${what} of "${input.relativePath}" could not be approved (${outcome.reason}). The file was NOT changed.`);
	}
}

// ─── read_file ───────────────────────────────────────────────────────────────

export async function readFileOp(args: { path: string; offset?: number; limit?: number }): Promise<string> {
	const target = resolveWorkspaceTarget(args.path, { mustExist: true });
	if (!target.stat!.isFile()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder. Use list_directory to see its contents.`);
	if (target.stat!.size > MAX_FILE_BYTES) {
		throw new WorkspaceError("too-large", `"${target.relative}" is ${formatSize(target.stat!.size)}; read_file handles files up to ${formatSize(MAX_FILE_BYTES)}.`);
	}
	let buffer: Buffer;
	try {
		buffer = await fsp.readFile(target.absolute);
	} catch (error) {
		throw describeFsError(error, "read", target.relative);
	}
	const { text } = decodeUtf8(buffer, target.relative);
	const allLines = text.split("\n");
	const total = allLines.length;
	const start = args.offset ? Math.max(0, args.offset - 1) : 0;
	if (start >= total) throw new WorkspaceError("invalid-path", `Offset ${args.offset} is beyond the end of the file (${total} lines).`);
	let selected = allLines.slice(start, args.limit !== undefined ? start + args.limit : total);
	let truncatedBy: "lines" | "bytes" | null = null;
	if (selected.length > READ_MAX_LINES) { selected = selected.slice(0, READ_MAX_LINES); truncatedBy = "lines"; }
	while (selected.length > 0 && Buffer.byteLength(selected.join("\n"), "utf-8") > MAX_OUTPUT_BYTES) { selected.pop(); truncatedBy = "bytes"; }
	const end = start + selected.length;
	const body = selected.join("\n");
	if (truncatedBy) return `${body}\n\n[Showing lines ${start + 1}-${end} of ${total} (${truncatedBy === "lines" ? `${READ_MAX_LINES} line limit` : `${formatSize(MAX_OUTPUT_BYTES)} limit`}). Use offset=${end + 1} to continue.]`;
	return total - end > 0 ? `${body}\n\n[${total - end} more lines in file. Use offset=${end + 1} to continue.]` : body;
}

// ─── list_directory ──────────────────────────────────────────────────────────

export async function listDirectoryOp(args: { path?: string; limit?: number }): Promise<string> {
	const target = resolveWorkspaceTarget(args.path ?? "", { allowRoot: true, mustExist: true });
	if (!target.stat!.isDirectory()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a file, not a folder. Use read_file.`);
	let entries: fs.Dirent[];
	try {
		entries = await fsp.readdir(target.absolute, { withFileTypes: true });
	} catch (error) {
		throw describeFsError(error, "list", target.relative);
	}
	entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
	const limit = Math.max(1, args.limit ?? LIST_DEFAULT_LIMIT);
	const lines: string[] = [];
	let limited = false;
	for (const entry of entries) {
		if (entry.name.startsWith(TEMP_PREFIX)) continue;
		const full = path.join(target.absolute, entry.name);
		if (isSensitivePath(full)) continue; // protected names are invisible, not merely unreadable
		if (lines.length >= limit) { limited = true; break; }
		if (entry.isSymbolicLink()) { lines.push(`${entry.name}  [link — not followed]`); continue; }
		if (entry.isDirectory()) { lines.push(`${entry.name}/`); continue; }
		try {
			lines.push(`${entry.name}  (${formatSize((await fsp.stat(full)).size)})`);
		} catch {
			lines.push(entry.name);
		}
	}
	const header = `Workspace: ${target.root}\nFolder: ${target.relative || "(workspace root)"}`;
	if (lines.length === 0) return `${header}\n\nFolder is empty.`;
	const { content, truncated } = capOutput(lines);
	const notices = [limited ? `${limit} entries limit` : "", truncated ? `${formatSize(MAX_OUTPUT_BYTES)} limit` : ""].filter(Boolean);
	return `${header}\n\n${content}${notices.length ? `\n\n[Truncated: ${notices.join(", ")}]` : ""}`;
}

// ─── write_file ──────────────────────────────────────────────────────────────

export async function writeFileOp(args: { path: string; content: string; overwrite?: boolean }, ctx: OpContext): Promise<string> {
	assertNoNul(args.content, "content");
	const bytes = Buffer.byteLength(args.content, "utf-8");
	assertWritable(bytes, "content");
	const target = resolveWorkspaceTarget(args.path);

	if (!target.exists) {
		const createdFolders = await ensureParentFolders(target);
		const fresh = resolveWorkspaceTarget(args.path); // re-validate after mkdir
		await createNewFile(fresh, Buffer.from(args.content, "utf-8"));
		await verifySize(fresh, bytes, "creation");
		return `Created ${fresh.relative} (${formatSize(bytes)}, ${countLines(args.content)} lines).${createdFolders.length ? ` Also created folder(s): ${createdFolders.join(", ")}.` : ""}`;
	}
	if (!target.stat!.isFile()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder; cannot write a file there.`);
	if (args.overwrite !== true) {
		throw new WorkspaceError(
			"exists",
			`"${target.relative}" already exists, so nothing was written. Use edit_file for targeted changes, append_file to add to the end, or — only if replacing the whole file is truly intended — call write_file again with overwrite=true (the learner must approve it).`,
		);
	}
	if (target.stat!.size > MAX_FILE_BYTES) throw new WorkspaceError("too-large", `"${target.relative}" is too large to overwrite safely (${formatSize(target.stat!.size)}).`);

	const before = target.stat!;
	let existing: Buffer;
	try {
		existing = await fsp.readFile(target.absolute);
	} catch (error) {
		throw describeFsError(error, "read", target.relative);
	}
	const decoded = decodeUtf8(existing, target.relative); // refuses to clobber binary/non-UTF-8 files
	const newBuffer = encodeUtf8(args.content, decoded.bom);
	if (sha256(existing) === sha256(newBuffer)) return `No change: ${target.relative} already contains exactly this content.`;

	await requireApproval(
		{
			chatId: ctx.chatId,
			toolCallId: ctx.toolCallId,
			operation: "overwrite_file",
			relativePath: target.relative,
			absolutePath: target.absolute,
			sizeBytes: existing.length,
			modifiedAt: before.mtime.toISOString(),
			currentPreview: preview(decoded.text),
			newSizeBytes: newBuffer.length,
			newPreview: preview(args.content),
		},
		ctx.signal,
	);
	// The learner may have taken minutes: re-validate the path and the file.
	const again = resolveWorkspaceTarget(args.path, { mustExist: true });
	await assertUnchanged(again, before);
	await replaceFileAtomically(again, newBuffer);
	await verifySize(again, newBuffer.length, "overwrite");
	return `Overwrote ${again.relative} with the learner's approval (${formatSize(existing.length)} → ${formatSize(newBuffer.length)}).`;
}

// ─── edit_file ───────────────────────────────────────────────────────────────

function occurrences(haystack: string, needle: string): number[] {
	const found: number[] = [];
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return found;
		found.push(at);
		from = at + needle.length;
	}
}

export async function editFileOp(args: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<string> {
	if (args.old_string.length === 0) {
		throw new WorkspaceError("invalid-path", "old_string must not be empty. To add text use append_file, or include nearby existing text in old_string.");
	}
	assertNoNul(args.new_string, "new_string");
	const target = resolveWorkspaceTarget(args.path, { mustExist: true });
	const before = target.stat!;
	if (!before.isFile()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder, not a file.`);
	if (before.size > MAX_EDIT_FILE_BYTES) throw new WorkspaceError("too-large", `"${target.relative}" is ${formatSize(before.size)}; edit_file handles files up to ${formatSize(MAX_EDIT_FILE_BYTES)}.`);

	let buffer: Buffer;
	try {
		buffer = await fsp.readFile(target.absolute);
	} catch (error) {
		throw describeFsError(error, "read", target.relative);
	}
	const { text, bom } = decodeUtf8(buffer, target.relative);
	const eol = detectEol(text);
	const needle = toEol(args.old_string, eol);
	const replacement = toEol(args.new_string, eol);
	if (needle === replacement) throw new WorkspaceError("invalid-path", "old_string and new_string are identical, so there is nothing to change.");

	const hits = occurrences(text, needle);
	if (hits.length === 0) {
		const squash = (s: string) => s.replace(/\s+/g, " ").trim();
		const nearMiss = squash(text).includes(squash(needle));
		throw new WorkspaceError(
			"not-found",
			`old_string was not found in "${target.relative}", so nothing was changed. Matching is exact (case, spaces, blank lines).${nearMiss ? " A match exists that differs only in whitespace — copy the text exactly from read_file." : " Call read_file to see the current text and copy the passage exactly."}`,
		);
	}
	if (hits.length > 1 && args.replace_all !== true) {
		throw new WorkspaceError(
			"conflict",
			`old_string matches ${hits.length} places in "${target.relative}", so nothing was changed. Include more surrounding text so it matches exactly once, or set replace_all=true to replace every occurrence.`,
		);
	}
	const replaced = args.replace_all === true ? hits.length : 1;
	const updated = args.replace_all === true ? text.split(needle).join(replacement) : text.slice(0, hits[0]!) + replacement + text.slice(hits[0]! + needle.length);
	const out = encodeUtf8(updated, bom);
	assertWritable(out.length, "the edited file");

	const again = resolveWorkspaceTarget(args.path, { mustExist: true });
	await assertUnchanged(again, before);
	await replaceFileAtomically(again, out);
	await verifySize(again, out.length, "edit");
	const firstLine = text.slice(0, hits[0]!).split("\n").length;
	return `Edited ${again.relative}: ${replaced} replacement${replaced === 1 ? "" : "s"} (first at line ${firstLine}); file is now ${formatSize(out.length)}, ${countLines(updated)} lines.`;
}

// ─── append_file ─────────────────────────────────────────────────────────────

export async function appendFileOp(args: { path: string; content: string; create_if_missing?: boolean }): Promise<string> {
	assertNoNul(args.content, "content");
	assertWritable(Buffer.byteLength(args.content, "utf-8"), "content");
	if (args.content.length === 0) throw new WorkspaceError("invalid-path", "content is empty; there is nothing to append.");
	const target = resolveWorkspaceTarget(args.path);

	if (!target.exists) {
		if (args.create_if_missing !== true) {
			throw new WorkspaceError("not-found", `"${target.relative}" does not exist, so nothing was appended. Check the name with list_directory (avoid creating a duplicate), or set create_if_missing=true to start a new file.`);
		}
		const createdFolders = await ensureParentFolders(target);
		const fresh = resolveWorkspaceTarget(args.path);
		const data = Buffer.from(args.content, "utf-8");
		await createNewFile(fresh, data);
		await verifySize(fresh, data.length, "creation");
		return `Created ${fresh.relative} with the appended content (${formatSize(data.length)}).${createdFolders.length ? ` Also created folder(s): ${createdFolders.join(", ")}.` : ""}`;
	}

	const before = target.stat!;
	if (!before.isFile()) throw new WorkspaceError("wrong-type", `"${target.relative}" is a folder, not a file.`);
	if (before.size > MAX_FILE_BYTES) throw new WorkspaceError("too-large", `"${target.relative}" is ${formatSize(before.size)}; it cannot be appended to beyond ${formatSize(MAX_FILE_BYTES)}.`);
	let existing: Buffer;
	try {
		existing = await fsp.readFile(target.absolute);
	} catch (error) {
		throw describeFsError(error, "read", target.relative);
	}
	const { text } = decodeUtf8(existing, target.relative); // refuses binary / non-UTF-8 files
	const eol = detectEol(text);
	let addition = toEol(args.content, eol);
	if (text.length > 0 && !/\n$/.test(text) && !/^\r?\n/.test(addition)) addition = (eol === "crlf" ? "\r\n" : "\n") + addition;
	const added = Buffer.from(addition, "utf-8");
	if (existing.length + added.length > MAX_FILE_BYTES) {
		throw new WorkspaceError("too-large", `Appending would make "${target.relative}" larger than ${formatSize(MAX_FILE_BYTES)}. Start a new file instead.`);
	}
	const again = resolveWorkspaceTarget(args.path, { mustExist: true });
	await assertUnchanged(again, before);
	let handle: fsp.FileHandle | undefined;
	try {
		handle = await fsp.open(again.absolute, "a");
		await handle.appendFile(added);
		await handle.sync();
		await handle.close();
		handle = undefined;
	} catch (error) {
		await handle?.close().catch(() => undefined);
		throw describeFsError(error, "append to", again.relative);
	}
	await verifySize(again, existing.length + added.length, "append");
	return `Appended ${formatSize(added.length)} to ${again.relative} (now ${formatSize(existing.length + added.length)}).`;
}

// ─── create_directory ────────────────────────────────────────────────────────

export async function createDirectoryOp(args: { path: string }): Promise<string> {
	const target = resolveWorkspaceTarget(args.path);
	if (target.exists) {
		if (target.stat!.isDirectory()) return `Folder already exists: ${target.relative}`;
		throw new WorkspaceError("wrong-type", `"${target.relative}" exists and is a file, so a folder cannot be created there.`);
	}
	try {
		await fsp.mkdir(target.absolute, { recursive: true });
	} catch (error) {
		throw describeFsError(error, "create folder", target.relative);
	}
	const check = resolveWorkspaceTarget(args.path, { mustExist: true });
	if (!check.stat!.isDirectory()) throw new WorkspaceError("io", `The folder "${target.relative}" could not be verified after creation.`);
	return `Created folder ${check.relative}`;
}

// ─── rename_path ─────────────────────────────────────────────────────────────

export async function renamePathOp(args: { from: string; to: string }): Promise<string> {
	const src = resolveWorkspaceTarget(args.from, { mustExist: true, label: "from" });
	const dst = resolveWorkspaceTarget(args.to, { label: "to" });
	const parent = path.dirname(dst.absolute);

	if (dst.exists && dst.absolute === src.absolute) {
		// Same entry reached through a differently-cased name (case-insensitive disk).
		const wanted = path.basename(args.to.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "");
		if (wanted === path.basename(src.absolute)) return `No change: ${src.relative} already has that name.`;
		const renamedTarget = path.join(path.dirname(src.absolute), wanted);
		try {
			await fsp.rename(src.absolute, renamedTarget);
		} catch (error) {
			throw describeFsError(error, "rename", src.relative);
		}
		return `Renamed (case change): ${src.relative} → ${path.relative(src.root, renamedTarget).split(path.sep).join("/")}`;
	}
	if (dst.exists) {
		throw new WorkspaceError("exists", `Destination "${dst.relative}" already exists, so nothing was renamed. Rename never overwrites; choose a different name.`);
	}
	if (src.stat!.isDirectory() && (dst.absolute === src.absolute || dst.absolute.startsWith(src.absolute + path.sep))) {
		throw new WorkspaceError("conflict", `Cannot move folder "${src.relative}" into itself ("${dst.relative}").`);
	}
	if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
		throw new WorkspaceError("not-found", `The destination folder for "${dst.relative}" does not exist. Create it with create_directory first.`);
	}
	// Re-validate immediately before acting.
	const srcNow = resolveWorkspaceTarget(args.from, { mustExist: true, label: "from" });
	const dstNow = resolveWorkspaceTarget(args.to, { label: "to" });
	if (dstNow.exists) throw new WorkspaceError("exists", `Destination "${dstNow.relative}" appeared while renaming, so nothing was renamed.`);
	try {
		await fsp.rename(srcNow.absolute, dstNow.absolute);
	} catch (error) {
		throw describeFsError(error, "rename", srcNow.relative);
	}
	if (fs.existsSync(srcNow.absolute) || !fs.existsSync(dstNow.absolute)) {
		throw new WorkspaceError("io", `The rename of "${srcNow.relative}" could not be verified. Check with list_directory.`);
	}
	return `Renamed ${src.stat!.isDirectory() ? "folder" : "file"}: ${srcNow.relative} → ${dstNow.relative}`;
}

// ─── delete_file ─────────────────────────────────────────────────────────────

export async function deleteFileOp(args: { path: string }, ctx: OpContext): Promise<string> {
	const target = resolveWorkspaceTarget(args.path, { mustExist: true });
	const before = target.stat!;
	if (before.isDirectory()) {
		throw new WorkspaceError(
			"wrong-type",
			`"${target.relative}" is a folder. delete_file removes single files only; folders (and recursive deletion) are never deleted by agents. Tell the learner to remove it themselves in File Explorer if they want it gone.`,
		);
	}
	let text: string | undefined;
	if (before.size <= MAX_FILE_BYTES) {
		try {
			text = decodeUtf8(await fsp.readFile(target.absolute), target.relative).text;
		} catch {
			text = undefined; // binary: no preview, still approvable
		}
	}
	await requireApproval(
		{
			chatId: ctx.chatId,
			toolCallId: ctx.toolCallId,
			operation: "delete_file",
			relativePath: target.relative,
			absolutePath: target.absolute,
			sizeBytes: before.size,
			modifiedAt: before.mtime.toISOString(),
			currentPreview: text === undefined ? undefined : preview(text),
		},
		ctx.signal,
	);
	const again = resolveWorkspaceTarget(args.path, { mustExist: true });
	await assertUnchanged(again, before);
	try {
		await fsp.unlink(again.absolute);
	} catch (error) {
		throw describeFsError(error, "delete", again.relative);
	}
	if (fs.existsSync(again.absolute)) {
		throw new WorkspaceError("io", `"${again.relative}" still exists after the delete (OneDrive or another program may have restored it). Do not report it as deleted.`);
	}
	return `Deleted ${again.relative} with the learner's approval (${formatSize(before.size)}).`;
}
