import assert from "node:assert";
import * as fs from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	setWorkspaceApprovalBroker,
	setWorkspacePolicy,
	type WorkspaceApprovalInput,
	type WorkspaceApprovalOutcome,
} from "../src/agent/tools/workspace/policy.ts";
import { assessWorkspaceRoot, describeFsError, WorkspaceError } from "../src/agent/tools/workspace/paths.ts";
import { workspaceTools } from "../src/agent/tools/workspace/tools.ts";

/**
 * Workspace file tools (custom build, 2026-11). EVERY test runs against a
 * throwaway temp directory — never the learner's real workspace. Windows-only
 * junction cases are skipped elsewhere and say so.
 */

let ROOT: string; // canonical temp workspace
let OUTSIDE: string; // sibling temp dir used as the escape target
let approvals: WorkspaceApprovalInput[];
let nextOutcome: WorkspaceApprovalOutcome;

const tools = workspaceTools({ chatId: "chat_test" });

async function run(name: string, params: unknown): Promise<string> {
	const tool = tools[name] as AgentTool<any>;
	const result = await tool.execute!(`call_${name}`, params, undefined);
	const first = result.content[0];
	assert.ok(first && first.type === "text");
	return (first as { text: string }).text;
}

async function fails(name: string, params: unknown, pattern: RegExp, code?: string): Promise<void> {
	await assert.rejects(run(name, params), (error: unknown) => {
		assert.match((error as Error).message, pattern);
		if (code) assert.strictEqual((error as WorkspaceError).code, code);
		return true;
	});
}

beforeEach(async () => {
	ROOT = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "lh-ws-")));
	OUTSIDE = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "lh-outside-")));
	approvals = [];
	nextOutcome = { status: "approved" };
	setWorkspacePolicy(() => ({ root: ROOT }));
	setWorkspaceApprovalBroker({
		async request(input) {
			approvals.push(input);
			return nextOutcome;
		},
	});
});

afterEach(async () => {
	setWorkspacePolicy(() => ({ root: null, error: "Workspace is not configured." }));
	setWorkspaceApprovalBroker(null);
	await fs.rm(ROOT, { recursive: true, force: true });
	await fs.rm(OUTSIDE, { recursive: true, force: true });
});

describe("workspace: create / read / list", () => {
	it("creates a new file (and missing parent folders) and reads it back", async () => {
		const out = await run("write_file", { path: "calculus/limits.md", content: "# Limits\nline two\n" });
		assert.match(out, /Created calculus\/limits\.md/);
		assert.match(out, /Also created folder\(s\): calculus/);
		assert.strictEqual(await fs.readFile(path.join(ROOT, "calculus", "limits.md"), "utf8"), "# Limits\nline two\n");
		assert.match(await run("read_file", { path: "calculus/limits.md" }), /# Limits\nline two/);
	});

	it("does not overwrite an existing file without overwrite=true and writes nothing", async () => {
		await fs.writeFile(path.join(ROOT, "a.md"), "original");
		await fails("write_file", { path: "a.md", content: "new" }, /already exists/, "exists");
		assert.strictEqual(await fs.readFile(path.join(ROOT, "a.md"), "utf8"), "original");
		assert.strictEqual(approvals.length, 0);
	});

	it("read_file reports missing files and folders explicitly", async () => {
		await fails("read_file", { path: "nope.md" }, /does not exist/, "not-found");
		await fs.mkdir(path.join(ROOT, "dir"));
		await fails("read_file", { path: "dir" }, /is a folder/, "wrong-type");
	});

	it("read_file pages with offset/limit and refuses binary files", async () => {
		await fs.writeFile(path.join(ROOT, "n.txt"), "1\n2\n3\n4\n5");
		assert.match(await run("read_file", { path: "n.txt", offset: 2, limit: 2 }), /^2\n3\n\n\[2 more lines in file\. Use offset=4/);
		await fs.writeFile(path.join(ROOT, "b.bin"), Buffer.from([1, 2, 0, 3]));
		await fails("read_file", { path: "b.bin" }, /binary/, "binary");
	});

	it("lists the root and subfolders, shows the workspace path, hides temp files and protected names", async () => {
		await fs.mkdir(path.join(ROOT, "zeta"));
		await fs.writeFile(path.join(ROOT, "alpha.md"), "x");
		await fs.writeFile(path.join(ROOT, ".env"), "SECRET=1");
		await fs.writeFile(path.join(ROOT, ".lh-tmp-abc"), "partial");
		const out = await run("list_directory", {});
		assert.match(out, new RegExp(`Workspace: ${ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.match(out, /alpha\.md {2}\(1B\)/);
		assert.match(out, /zeta\//);
		assert.doesNotMatch(out, /\.env|lh-tmp/);
		assert.match(await run("list_directory", { path: "zeta" }), /Folder is empty/);
		await fails("list_directory", { path: "alpha.md" }, /is a file/, "wrong-type");
	});
});

describe("workspace: edit / append", () => {
	it("edit_file replaces exactly one unique match and reports it", async () => {
		await fs.writeFile(path.join(ROOT, "e.md"), "alpha\nbeta\ngamma\n");
		const out = await run("edit_file", { path: "e.md", old_string: "beta", new_string: "BETA" });
		assert.match(out, /1 replacement \(first at line 2\)/);
		assert.strictEqual(await fs.readFile(path.join(ROOT, "e.md"), "utf8"), "alpha\nBETA\ngamma\n");
	});

	it("edit_file refuses missing and ambiguous matches without changing the file", async () => {
		await fs.writeFile(path.join(ROOT, "e.md"), "x\nx\n");
		await fails("edit_file", { path: "e.md", old_string: "zzz", new_string: "y" }, /not found/, "not-found");
		await fails("edit_file", { path: "e.md", old_string: "x", new_string: "y" }, /matches 2 places/, "conflict");
		assert.strictEqual(await fs.readFile(path.join(ROOT, "e.md"), "utf8"), "x\nx\n");
		assert.match(await run("edit_file", { path: "e.md", old_string: "x", new_string: "y", replace_all: true }), /2 replacements/);
		assert.strictEqual(await fs.readFile(path.join(ROOT, "e.md"), "utf8"), "y\ny\n");
	});

	it("edit_file preserves CRLF line endings and a UTF-8 BOM", async () => {
		const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("one\r\ntwo\r\nthree\r\n", "utf8")]);
		await fs.writeFile(path.join(ROOT, "w.md"), original);
		await run("edit_file", { path: "w.md", old_string: "one\ntwo", new_string: "ONE\nTWO\nextra" });
		const after = await fs.readFile(path.join(ROOT, "w.md"));
		assert.deepStrictEqual([...after.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
		assert.strictEqual(after.subarray(3).toString("utf8"), "ONE\r\nTWO\r\nextra\r\nthree\r\n");
	});

	it("edit_file rejects empty/identical old_string and flags whitespace-only near misses", async () => {
		await fs.writeFile(path.join(ROOT, "e.md"), "a   b\n");
		await fails("edit_file", { path: "e.md", old_string: "", new_string: "x" }, /must not be empty/);
		await fails("edit_file", { path: "e.md", old_string: "a", new_string: "a" }, /identical/);
		await fails("edit_file", { path: "e.md", old_string: "a b", new_string: "x" }, /differs only in whitespace/);
	});

	it("append_file adds to the end with a separating newline and never alters existing content", async () => {
		await fs.writeFile(path.join(ROOT, "log.md"), "# Log\n- day 1");
		assert.match(await run("append_file", { path: "log.md", content: "- day 2\n" }), /Appended/);
		assert.strictEqual(await fs.readFile(path.join(ROOT, "log.md"), "utf8"), "# Log\n- day 1\n- day 2\n");
	});

	it("append_file refuses a missing file unless create_if_missing, so typos cannot spawn duplicates", async () => {
		await fails("append_file", { path: "progres.md", content: "x" }, /does not exist/, "not-found");
		assert.ok(!existsSync(path.join(ROOT, "progres.md")));
		assert.match(await run("append_file", { path: "logs/progress.md", content: "first\n", create_if_missing: true }), /Created logs\/progress\.md/);
	});

	it("enforces size limits and refuses NUL content", async () => {
		await fails("write_file", { path: "big.md", content: "x".repeat(1024 * 1024 + 1) }, /may write at most/, "too-large");
		await fails("write_file", { path: "nul.md", content: "a\u0000b" }, /NUL/, "binary");
		assert.ok(!existsSync(path.join(ROOT, "big.md")));
	});
});

describe("workspace: directories and rename", () => {
	it("creates nested directories idempotently and refuses a file in the way", async () => {
		assert.match(await run("create_directory", { path: "a/b/c" }), /Created folder a\/b\/c/);
		assert.match(await run("create_directory", { path: "a/b/c" }), /already exists/);
		await fs.writeFile(path.join(ROOT, "file.md"), "x");
		await fails("create_directory", { path: "file.md" }, /is a file/, "wrong-type");
	});

	it("renames files and folders and states source → destination", async () => {
		await fs.writeFile(path.join(ROOT, "old.md"), "x");
		assert.match(await run("rename_path", { from: "old.md", to: "new.md" }), /Renamed file: old\.md → new\.md/);
		await fs.mkdir(path.join(ROOT, "dirA"));
		await fs.writeFile(path.join(ROOT, "dirA", "inside.md"), "y");
		assert.match(await run("rename_path", { from: "dirA", to: "dirB" }), /Renamed folder: dirA → dirB/);
		assert.ok(existsSync(path.join(ROOT, "dirB", "inside.md")));
		await fs.mkdir(path.join(ROOT, "sub"));
		assert.match(await run("rename_path", { from: "new.md", to: "sub/moved.md" }), /new\.md → sub\/moved\.md/);
	});

	it("rename never overwrites, never moves a folder into itself, needs an existing destination folder", async () => {
		await fs.writeFile(path.join(ROOT, "a.md"), "A");
		await fs.writeFile(path.join(ROOT, "b.md"), "B");
		await fails("rename_path", { from: "a.md", to: "b.md" }, /already exists/, "exists");
		assert.strictEqual(await fs.readFile(path.join(ROOT, "b.md"), "utf8"), "B");
		await fs.mkdir(path.join(ROOT, "d"));
		await fails("rename_path", { from: "d", to: "d/inner" }, /into itself/, "conflict");
		await fails("rename_path", { from: "a.md", to: "nofolder/a.md" }, /create_directory first/, "not-found");
		await fails("rename_path", { from: "ghost.md", to: "x.md" }, /does not exist/, "not-found");
	});

	it("refuses to rename the workspace root", async () => {
		await fails("rename_path", { from: ".", to: "elsewhere" }, /workspace root/, "invalid-path");
	});
});

describe("workspace: delete and overwrite confirmation", () => {
	it("delete_file asks the learner first, shows the exact file, and deletes only after approval", async () => {
		await fs.writeFile(path.join(ROOT, "gone.md"), "precious notes\n");
		const out = await run("delete_file", { path: "gone.md" });
		assert.match(out, /Deleted gone\.md with the learner's approval/);
		assert.ok(!existsSync(path.join(ROOT, "gone.md")));
		assert.strictEqual(approvals.length, 1);
		assert.strictEqual(approvals[0]!.operation, "delete_file");
		assert.strictEqual(approvals[0]!.relativePath, "gone.md");
		assert.strictEqual(approvals[0]!.chatId, "chat_test");
		assert.match(approvals[0]!.currentPreview ?? "", /precious notes/);
	});

	it("delete_file keeps the file when the learner declines, times out, aborts, or approval is unavailable", async () => {
		await fs.writeFile(path.join(ROOT, "keep.md"), "keep me");
		for (const outcome of [{ status: "denied" }, { status: "timeout" }, { status: "aborted" }, { status: "unavailable", reason: "no window" }] as WorkspaceApprovalOutcome[]) {
			nextOutcome = outcome;
			await fails("delete_file", { path: "keep.md" }, /NOT changed|NOT performed/, "not-approved");
			assert.strictEqual(await fs.readFile(path.join(ROOT, "keep.md"), "utf8"), "keep me");
		}
		setWorkspaceApprovalBroker(null); // fail closed with no broker at all
		await fails("delete_file", { path: "keep.md" }, /No approval channel/, "not-approved");
		assert.ok(existsSync(path.join(ROOT, "keep.md")));
	});

	it("delete_file refuses folders (no recursive deletion) and missing files", async () => {
		await fs.mkdir(path.join(ROOT, "folder"));
		await fs.writeFile(path.join(ROOT, "folder", "f.md"), "x");
		await fails("delete_file", { path: "folder" }, /single files only/, "wrong-type");
		assert.ok(existsSync(path.join(ROOT, "folder", "f.md")));
		await fails("delete_file", { path: "missing.md" }, /does not exist/, "not-found");
		assert.strictEqual(approvals.length, 0);
	});

	it("delete_file refuses when the file changed while the learner was deciding", async () => {
		await fs.writeFile(path.join(ROOT, "race.md"), "v1");
		setWorkspaceApprovalBroker({
			async request() {
				await fs.writeFile(path.join(ROOT, "race.md"), "v2 changed meanwhile");
				return { status: "approved" };
			},
		});
		await fails("delete_file", { path: "race.md" }, /changed on disk/, "conflict");
		assert.ok(existsSync(path.join(ROOT, "race.md")));
	});

	it("overwrite=true needs approval, shows current and new content, and is atomic", async () => {
		await fs.writeFile(path.join(ROOT, "o.md"), "old content");
		assert.match(await run("write_file", { path: "o.md", content: "new content!", overwrite: true }), /Overwrote o\.md/);
		assert.strictEqual(await fs.readFile(path.join(ROOT, "o.md"), "utf8"), "new content!");
		assert.strictEqual(approvals[0]!.operation, "overwrite_file");
		assert.match(approvals[0]!.currentPreview ?? "", /old content/);
		assert.match(approvals[0]!.newPreview ?? "", /new content!/);
		assert.deepStrictEqual((await fs.readdir(ROOT)).filter((n) => n.startsWith(".lh-tmp-")), []);
	});

	it("a declined overwrite leaves the original untouched; identical content needs no approval", async () => {
		await fs.writeFile(path.join(ROOT, "o.md"), "keep");
		nextOutcome = { status: "denied" };
		await fails("write_file", { path: "o.md", content: "clobber", overwrite: true }, /DECLINED/, "not-approved");
		assert.strictEqual(await fs.readFile(path.join(ROOT, "o.md"), "utf8"), "keep");
		approvals.length = 0;
		assert.match(await run("write_file", { path: "o.md", content: "keep", overwrite: true }), /No change/);
		assert.strictEqual(approvals.length, 0);
	});

	it("never clobbers a binary file even with approval", async () => {
		await fs.writeFile(path.join(ROOT, "img.bin"), Buffer.from([0, 1, 2, 3]));
		await fails("write_file", { path: "img.bin", content: "text", overwrite: true }, /binary/, "binary");
		assert.deepStrictEqual([...(await fs.readFile(path.join(ROOT, "img.bin")))], [0, 1, 2, 3]);
	});
});

describe("workspace: path safety", () => {
	it("rejects traversal sequences in every position, for every tool", async () => {
		for (const bad of ["../escape.md", "a/../../escape.md", "..", "a/..", "..\\escape.md", "sub/../../x"]) {
			await fails("write_file", { path: bad, content: "x" }, /not allowed|outside|workspace root/);
			await fails("read_file", { path: bad }, /not allowed|outside|workspace root/);
		}
		assert.ok(!existsSync(path.join(path.dirname(ROOT), "escape.md")));
	});

	it("rejects absolute paths outside the workspace but accepts absolute paths inside it", async () => {
		await fails("write_file", { path: path.join(OUTSIDE, "x.md"), content: "x" }, /outside the workspace/, "outside-workspace");
		await fails("read_file", { path: "/etc/passwd" }, /outside the workspace/, "outside-workspace");
		await fails("read_file", { path: "C:\\Windows\\win.ini" }, /outside the workspace|not allowed/);
		await fails("write_file", { path: ROOT + "-sibling/x.md", content: "x" }, /outside the workspace/); // prefix lookalike
		assert.match(await run("write_file", { path: path.join(ROOT, "inside.md"), content: "ok" }), /Created inside\.md/);
		assert.ok(!existsSync(path.join(OUTSIDE, "x.md")));
	});

	it("rejects malformed and Windows-hostile paths", async () => {
		const cases: Array<[string, RegExp]> = [
			["a\u0000b.md", /control characters/],
			["bad<name>.md", /not allowed in file names|':' is not allowed|character that is not allowed/],
			["name.md.", /must not end with a space or a period/],
			["trail ", /must not end with a space or a period/],
			["CON", /reserved Windows device name/],
			["nul.txt", /reserved Windows device name/],
			["notes.md:hidden", /':' is not allowed/],
			["C:evil.md", /':' is not allowed/],
			["\\\\server\\share\\x.md", /network \(UNC\)/],
			["//server/share/x.md", /network \(UNC\)/],
			["x".repeat(300), /longer than/],
		];
		for (const [bad, pattern] of cases) await fails("write_file", { path: bad, content: "x" }, pattern);
		await fails("write_file", { path: 42 as unknown as string, content: "x" }, /must be a string/);
	});

	it("refuses to touch credential and .env files even inside the workspace", async () => {
		await fs.writeFile(path.join(ROOT, ".env"), "KEY=1");
		await fails("read_file", { path: ".env" }, /protected/, "protected");
		await fails("write_file", { path: ".env.local", content: "x" }, /protected/, "protected");
		assert.strictEqual(await fs.readFile(path.join(ROOT, ".env"), "utf8"), "KEY=1");
	});

	it("can never be pointed at LearnHarness's own data or credential folders", async () => {
		const { AUTH_FILE, PATHS } = await import("../config.ts");
		for (const forbidden of [PATHS.data, path.dirname(AUTH_FILE)]) {
			await fs.mkdir(forbidden, { recursive: true });
			setWorkspacePolicy(() => ({ root: forbidden }));
			await fails("list_directory", {}, /overlap LearnHarness's own data or credentials/, "unavailable");
			await fails("write_file", { path: "planted.md", content: "x" }, /Workspace unavailable/, "unavailable");
		}
	});

	it("refuses symlink escapes — directory links, file links, dangling links, and links inside the workspace", async (t) => {
		try {
			await fs.symlink(OUTSIDE, path.join(ROOT, "linkdir"), "dir");
			await fs.writeFile(path.join(OUTSIDE, "secret.md"), "outside secret");
			await fs.symlink(path.join(OUTSIDE, "secret.md"), path.join(ROOT, "linkfile.md"), "file");
			await fs.symlink(path.join(OUTSIDE, "not-there.md"), path.join(ROOT, "dangling.md"), "file");
			await fs.mkdir(path.join(ROOT, "real"));
			await fs.symlink(path.join(ROOT, "real"), path.join(ROOT, "innerlink"), "dir");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlink creation not permitted here");
			throw error;
		}
		await fails("write_file", { path: "linkdir/pwned.md", content: "x" }, /symbolic link or junction/, "link");
		await fails("read_file", { path: "linkdir/secret.md" }, /symbolic link or junction/, "link");
		await fails("list_directory", { path: "linkdir" }, /symbolic link or junction/, "link");
		await fails("read_file", { path: "linkfile.md" }, /symbolic link or junction/, "link");
		await fails("append_file", { path: "linkfile.md", content: "x" }, /symbolic link or junction/, "link");
		await fails("edit_file", { path: "linkfile.md", old_string: "outside", new_string: "x" }, /symbolic link or junction/, "link");
		await fails("write_file", { path: "dangling.md", content: "x" }, /symbolic link or junction/, "link");
		await fails("write_file", { path: "innerlink/x.md", content: "x" }, /symbolic link or junction/, "link");
		await fails("rename_path", { from: "linkdir", to: "renamed" }, /symbolic link or junction/, "link");
		await fails("delete_file", { path: "linkfile.md" }, /symbolic link or junction/, "link");
		assert.strictEqual(await fs.readFile(path.join(OUTSIDE, "secret.md"), "utf8"), "outside secret");
		assert.ok(!existsSync(path.join(OUTSIDE, "pwned.md")));
		assert.strictEqual(approvals.length, 0);
		// A link is shown, never followed, in listings.
		assert.match(await run("list_directory", {}), /linkdir {2}\[link — not followed\]/);
	});

	it("refuses a Windows junction escape (runs on Windows only)", { skip: process.platform !== "win32" && "junctions exist only on Windows" }, async () => {
		const { execFileSync } = await import("node:child_process");
		execFileSync("cmd.exe", ["/c", "mklink", "/J", path.join(ROOT, "junc"), OUTSIDE]);
		await fs.writeFile(path.join(OUTSIDE, "secret.md"), "outside secret");
		await fails("read_file", { path: "junc/secret.md" }, /symbolic link or junction/, "link");
		await fails("write_file", { path: "junc/pwned.md", content: "x" }, /symbolic link or junction/, "link");
		assert.ok(!existsSync(path.join(OUTSIDE, "pwned.md")));
	});

	it("refuses to delete, rename, overwrite or create over the workspace root", async () => {
		for (const root of [".", "", "./", ROOT]) {
			await fails("delete_file", { path: root }, /workspace root/, "invalid-path");
			await fails("write_file", { path: root, content: "x", overwrite: true }, /workspace root/, "invalid-path");
			await fails("create_directory", { path: root }, /workspace root/, "invalid-path");
			await fails("rename_path", { from: root, to: "gone" }, /workspace root/, "invalid-path");
		}
		assert.ok(existsSync(ROOT));
		assert.strictEqual(approvals.length, 0);
	});

	it("a symlinked CONFIGURED root is canonicalised, and files stay inside the real folder", async (t) => {
		const linked = path.join(OUTSIDE, "ws-link");
		try { await fs.symlink(ROOT, linked, "dir"); } catch { return t.skip("symlink creation not permitted here"); }
		setWorkspacePolicy(() => ({ root: linked }));
		assert.match(await run("write_file", { path: "viaLink.md", content: "ok" }), /Created viaLink\.md/);
		assert.ok(existsSync(path.join(ROOT, "viaLink.md")));
		await fails("write_file", { path: path.join(OUTSIDE, "other.md"), content: "x" }, /outside the workspace/);
	});
});

describe("workspace: unavailable / protected workspace and error mapping", () => {
	it("every tool refuses clearly when no workspace is configured (fail closed)", async () => {
		setWorkspacePolicy(() => ({ root: null, error: "Workspace is not configured." }));
		for (const [name, params] of [["read_file", { path: "a" }], ["list_directory", {}], ["write_file", { path: "a", content: "x" }], ["edit_file", { path: "a", old_string: "a", new_string: "b" }], ["append_file", { path: "a", content: "x" }], ["create_directory", { path: "a" }], ["rename_path", { from: "a", to: "b" }], ["delete_file", { path: "a" }]] as const) {
			await fails(name, params, /Workspace unavailable.*Settings → Agent → Workspace/, "unavailable");
		}
	});

	it("reports a missing workspace folder without creating it", async () => {
		const missing = path.join(OUTSIDE, "does-not-exist");
		setWorkspacePolicy(() => ({ root: missing }));
		await fails("list_directory", {}, /folder does not exist/, "unavailable");
		assert.ok(!existsSync(missing));
	});

	it("notices a workspace folder that disappears between calls", async () => {
		await run("write_file", { path: "a.md", content: "x" });
		await fs.rm(ROOT, { recursive: true, force: true });
		await fails("read_file", { path: "a.md" }, /folder does not exist/, "unavailable");
	});

	it("assessWorkspaceRoot rejects the home folder, its parents, app-private folders and non-folders", async () => {
		const home = realpathSync(os.homedir());
		assert.strictEqual(assessWorkspaceRoot(home).ok, false);
		assert.strictEqual(assessWorkspaceRoot(path.dirname(home)).ok, false);
		const dataDir = (await import("../config.ts")).PATHS.data;
		await fs.mkdir(dataDir, { recursive: true });
		const bad = assessWorkspaceRoot(dataDir);
		assert.ok(!bad.ok && bad.code === "protected", "the app data folder can never be the workspace");
		const file = path.join(ROOT, "f.txt");
		await fs.writeFile(file, "x");
		const notDir = assessWorkspaceRoot(file);
		assert.ok(!notDir.ok && notDir.code === "not-directory");
		assert.strictEqual(assessWorkspaceRoot("relative/path").ok, false);
		assert.strictEqual(assessWorkspaceRoot("/").ok, false);
		assert.ok(assessWorkspaceRoot(ROOT).ok);
	});

	it("maps permission failures, locked files and other fs errors to explicit messages", () => {
		const e = (code: string) => Object.assign(new Error(code), { code });
		assert.match(describeFsError(e("EACCES"), "write", "a.md").message, /permission denied.*NOT performed/);
		assert.match(describeFsError(e("EPERM"), "delete", "a.md").message, /permission denied/);
		assert.match(describeFsError(e("EBUSY"), "write", "a.md").message, /locked by another program/);
		assert.strictEqual(describeFsError(e("EBUSY"), "write", "a.md").code, "locked");
		assert.match(describeFsError(e("ENOSPC"), "write", "a.md").message, /disk is full/);
		assert.match(describeFsError(e("EWEIRD"), "write", "a.md").message, /may not have completed/);
	});

	it("surfaces a real permission failure from the OS", { skip: (process.platform === "win32" || process.getuid?.() === 0) && "needs a non-root POSIX user" }, async () => {
		await fs.mkdir(path.join(ROOT, "ro"));
		await fs.chmod(path.join(ROOT, "ro"), 0o555);
		try {
			await fails("write_file", { path: "ro/x.md", content: "x" }, /permission denied/, "permission");
		} finally {
			await fs.chmod(path.join(ROOT, "ro"), 0o755);
		}
	});
});
