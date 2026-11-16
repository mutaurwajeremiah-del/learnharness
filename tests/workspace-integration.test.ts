import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, describe, it } from "node:test";

/**
 * Workspace feature, composed (custom build, 2026-11): settings persistence
 * across a REAL process restart, the PUT validation, live status/creation,
 * the approval broker driving the actual tools end to end, the approval
 * routes, and which agents do (and do not) carry the tools. Synthetic HOME,
 * data and auth locations only — never the learner's real files.
 */

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "lh-ws-integration-")));
const home = path.join(root, "home");
// Like the real app: credentials + data live in their OWN dedicated app folder,
// never in a folder shared with the learner's home or workspace.
const appDir = path.join(root, "app");
const data = path.join(appDir, "data");
const auth = path.join(appDir, "auth.json");
const workspace = path.join(home, "Learning");
const prior = Object.fromEntries(["HOME", "USERPROFILE", "LH_AUTH_FILE", "LH_DATA_DIR"].map((key) => [key, process.env[key]]));
Object.assign(process.env, { HOME: home, USERPROFILE: home, LH_AUTH_FILE: auth, LH_DATA_DIR: data });
for (const directory of [home, appDir, data, workspace]) await fs.mkdir(directory, { recursive: true });
await fs.writeFile(auth, "{}\n");

const { SETTINGS_FILE } = await import("../config.ts");
const { readWorkspaceSettings } = await import("../src/store/settings.ts");
const { workspacePolicy, workspaceStatus, createWorkspaceFolder } = await import("../src/server/workspace.ts");
const { workspaceApprovalBroker, listWorkspaceApprovals, decideWorkspaceApproval, workspaceApprovalTimeoutMs } = await import("../src/server/workspace-approvals.ts");
const { setWorkspacePolicy, setWorkspaceApprovalBroker } = await import("../src/agent/tools/workspace/policy.ts");
const { workspaceTools, WORKSPACE_TOOL_NAMES } = await import("../src/agent/tools/workspace/tools.ts");
const { DEFAULT_WORKSPACE_ROOT } = await import("../src/core/workspace.ts");
const { PUT } = await import("../app/api/settings/[section]/route.ts");
const { GET: getApprovals } = await import("../app/api/workspace/approvals/route.ts");
const { POST: decideRoute } = await import("../app/api/workspace/approvals/[id]/route.ts");
const { GET: getStatus, POST: postStatus } = await import("../app/api/workspace/route.ts");
const { createTeacherTools, createProberTools } = await import("../src/agent/tools.ts");
const { practiceTools } = await import("../src/agent/tools/practice.ts");

const put = (section: string, value: unknown) =>
	PUT(new Request(`http://localhost/api/settings/${section}`, { method: "PUT", body: JSON.stringify(value), headers: { "Content-Type": "application/json" } }), { params: Promise.resolve({ section }) });
const stored = (value: unknown) => fs.writeFile(SETTINGS_FILE, JSON.stringify(value));
const tools = workspaceTools({ chatId: "chat_int" });
async function run(name: string, params: unknown, signal?: AbortSignal): Promise<string> {
	const result = await tools[name]!.execute!(`call_${name}`, params, signal);
	return (result.content[0] as { text: string }).text;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForApprovals(count: number): Promise<void> {
	for (let i = 0; i < 200 && listWorkspaceApprovals().length < count; i++) await sleep(5);
	assert.equal(listWorkspaceApprovals().length, count, "the approval request reached the broker");
}

beforeEach(async () => {
	await fs.rm(SETTINGS_FILE, { force: true });
	setWorkspacePolicy(workspacePolicy);
	setWorkspaceApprovalBroker(workspaceApprovalBroker);
	workspaceApprovalTimeoutMs.current = 10 * 60_000;
	await fs.rm(workspace, { recursive: true, force: true });
	await fs.mkdir(workspace, { recursive: true });
});
after(async () => {
	setWorkspacePolicy(() => ({ root: null, error: "Workspace is not configured." }));
	setWorkspaceApprovalBroker(null);
	for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	await fs.rm(root, { recursive: true, force: true });
});

describe("workspace setting: default, validation, persistence", () => {
	it("absent setting = the built-in default workspace, labelled default", () => {
		assert.deepEqual(readWorkspaceSettings(), { ok: true, settings: null });
		assert.equal(workspacePolicy().root, DEFAULT_WORKSPACE_ROOT);
		assert.equal(workspaceStatus().source, "default");
		assert.equal(DEFAULT_WORKSPACE_ROOT, "C:\\Users\\hp\\OneDrive\\Documents\\code understood masterclass");
	});

	it("PUT /api/settings/agent saves a custom workspace, and the policy follows immediately", async () => {
		const response = await put("agent", { workspace: { root: workspace } });
		assert.equal(response.status, 200);
		assert.deepEqual(readWorkspaceSettings(), { ok: true, settings: { root: workspace } });
		assert.equal(workspacePolicy().root, workspace);
		assert.deepEqual({ source: workspaceStatus().source, state: workspaceStatus().state }, { source: "custom", state: "ready" });
	});

	it("rejects relative, UNC, drive-root, device, traversal and extra-field workspace values", async () => {
		const bad: unknown[] = [
			{ root: "relative/folder" }, { root: "\\\\server\\share\\notes" }, { root: "C:\\" }, { root: "/" },
			{ root: "\\\\?\\C:\\notes" }, { root: "C:\\Users\\me\\..\\other" }, { root: "C:\\notes:stream" },
			{ root: "" }, { root: 5 }, { root: workspace, extra: true }, "just-a-string", null, [],
		];
		for (const value of bad) {
			const response = await put("agent", { workspace: value });
			assert.equal(response.status, 400, `${JSON.stringify(value)} must be rejected`);
		}
		assert.deepEqual(readWorkspaceSettings(), { ok: true, settings: null }, "nothing was persisted by the rejected writes");
	});

	it("survives an application restart — a brand-new process reads the same workspace", async () => {
		await put("agent", { workspace: { root: workspace } });
		const script = `
			const { workspacePolicy, workspaceStatus } = await import(${JSON.stringify(path.resolve("src/server/workspace.ts"))});
			console.log(JSON.stringify({ policy: workspacePolicy(), status: workspaceStatus() }));
		`;
		const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
			cwd: process.cwd(), env: { ...process.env, LH_DATA_DIR: data, LH_AUTH_FILE: auth, HOME: home, USERPROFILE: home }, encoding: "utf8",
		});
		const fresh = JSON.parse(output.trim().split("\n").pop()!);
		assert.equal(fresh.policy.root, workspace);
		assert.equal(fresh.status.state, "ready");
		assert.equal(fresh.status.source, "custom");
	});

	it("a malformed stored workspace fails CLOSED — it never decays into the default folder", async () => {
		await stored({ agent: { workspace: { root: 5 } } });
		assert.equal(readWorkspaceSettings().ok, false);
		const policy = workspacePolicy();
		assert.equal(policy.root, null);
		assert.match(policy.error ?? "", /Repair Workspace/);
		await assert.rejects(run("list_directory", {}), /Workspace unavailable/);
		await stored("not an object");
		assert.equal(readWorkspaceSettings().ok, false);
		await fs.writeFile(SETTINGS_FILE, "{ torn json");
		assert.equal(readWorkspaceSettings().ok, false);
		await assert.rejects(run("write_file", { path: "x.md", content: "x" }), /Workspace unavailable/);
	});

	it("an unrelated settings write carries the workspace through unchanged", async () => {
		await put("agent", { workspace: { root: workspace } });
		const current = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")).agent;
		await put("agent", { ...current, tools: { research: false } });
		assert.deepEqual(readWorkspaceSettings(), { ok: true, settings: { root: workspace } });
	});
});

describe("workspace status and folder creation", () => {
	it("reports a missing folder as creatable, creates it on request, and never touches an existing one", async () => {
		const missing = path.join(home, "Fresh", "Notes");
		await put("agent", { workspace: { root: missing } });
		const status = await (await getStatus()).json();
		assert.deepEqual({ state: status.state, canCreate: status.canCreate }, { state: "missing", canCreate: true });
		assert.match(status.message, /does not exist/);
		const created = await postStatus(new Request("http://localhost/api/workspace", { method: "POST", body: JSON.stringify({ action: "create" }) }));
		assert.equal(created.status, 200);
		assert.equal((await created.json()).state, "ready");
		assert.ok(fsSync.statSync(missing).isDirectory());
		await fs.writeFile(path.join(missing, "keep.md"), "keep");
		assert.equal(createWorkspaceFolder().state, "ready");
		assert.equal(await fs.readFile(path.join(missing, "keep.md"), "utf8"), "keep");
	});

	it("refuses to create or use the home folder, its parents, and LearnHarness's own data/credential folders", async () => {
		for (const forbidden of [home, path.dirname(home), data, appDir]) {
			await put("agent", { workspace: { root: forbidden } });
			const status = workspaceStatus();
			assert.equal(status.state, "invalid", forbidden);
			assert.equal(status.canCreate, false);
			await assert.rejects(run("list_directory", {}), /Workspace unavailable/);
		}
		const nested = path.join(data, "sub-folder-of-data");
		await put("agent", { workspace: { root: nested } });
		assert.equal(workspaceStatus().canCreate, false, "cannot create a workspace inside the app's data folder");
		assert.throws(() => createWorkspaceFolder(), /LearnHarness's own data/);
		assert.ok(!fsSync.existsSync(nested));
	});

	it("flags a workspace that is a file, and bad POST bodies", async () => {
		const file = path.join(home, "afile.txt");
		await fs.writeFile(file, "x");
		await put("agent", { workspace: { root: file } });
		assert.equal(workspaceStatus().state, "invalid");
		assert.equal((await postStatus(new Request("http://localhost/api/workspace", { method: "POST", body: "{" }))).status, 400);
		assert.equal((await postStatus(new Request("http://localhost/api/workspace", { method: "POST", body: JSON.stringify({ action: "rm" }) }))).status, 400);
		assert.equal((await postStatus(new Request("http://localhost/api/workspace", { method: "POST", body: JSON.stringify({ action: "create" }) }))).status, 409);
	});
});

describe("approval broker + tools, end to end (real broker, simulated learner clicks)", () => {
	beforeEach(async () => { await put("agent", { workspace: { root: workspace } }); });

	it("delete_file BLOCKS until the learner approves, then deletes and says so", async () => {
		await fs.writeFile(path.join(workspace, "old.md"), "old notes\nsecond line\n");
		const pending = run("delete_file", { path: "old.md" });
		await waitForApprovals(1);
		const [request] = listWorkspaceApprovals();
		assert.equal(request!.operation, "delete_file");
		assert.equal(request!.relativePath, "old.md");
		assert.equal(request!.chatId, "chat_int");
		assert.equal(request!.absolutePath, path.join(workspace, "old.md"));
		assert.match(request!.currentPreview ?? "", /old notes/);
		assert.ok(fsSync.existsSync(path.join(workspace, "old.md")), "nothing is deleted while the dialog is open");
		const via = await decideRoute(new Request("http://localhost", { method: "POST", body: JSON.stringify({ decision: "approve" }) }), { params: Promise.resolve({ id: request!.id }) });
		assert.equal(via.status, 200);
		assert.match(await pending, /Deleted old\.md with the learner's approval/);
		assert.ok(!fsSync.existsSync(path.join(workspace, "old.md")));
		assert.equal(listWorkspaceApprovals().length, 0);
	});

	it("a denied delete keeps the file and tells the model plainly", async () => {
		await fs.writeFile(path.join(workspace, "keep.md"), "keep");
		const pending = run("delete_file", { path: "keep.md" });
		await waitForApprovals(1);
		assert.equal(decideWorkspaceApproval(listWorkspaceApprovals()[0]!.id, false), true);
		await assert.rejects(pending, /DECLINED.*NOT changed/);
		assert.equal(await fs.readFile(path.join(workspace, "keep.md"), "utf8"), "keep");
	});

	it("an unanswered request times out and the file is kept", async () => {
		workspaceApprovalTimeoutMs.current = 40;
		await fs.writeFile(path.join(workspace, "slow.md"), "slow");
		await assert.rejects(run("delete_file", { path: "slow.md" }), /did not answer.*NOT changed/);
		assert.ok(fsSync.existsSync(path.join(workspace, "slow.md")));
		assert.equal(listWorkspaceApprovals().length, 0, "an expired request leaves the queue");
	});

	it("cancelling the run (abort) withdraws the request and keeps the file", async () => {
		await fs.writeFile(path.join(workspace, "abort.md"), "abort");
		const controller = new AbortController();
		const pending = run("delete_file", { path: "abort.md" }, controller.signal);
		await waitForApprovals(1);
		controller.abort();
		await assert.rejects(pending, /cancelled.*NOT changed/);
		assert.equal(listWorkspaceApprovals().length, 0);
		assert.ok(fsSync.existsSync(path.join(workspace, "abort.md")));
		await assert.rejects(run("delete_file", { path: "abort.md" }, controller.signal), /cancelled/, "an already-aborted run never even opens a dialog");
		assert.equal(listWorkspaceApprovals().length, 0);
	});

	it("overwrite=true goes through the same dialog and replaces only after approval", async () => {
		await fs.writeFile(path.join(workspace, "plan.md"), "v1 plan");
		const pending = run("write_file", { path: "plan.md", content: "v2 plan, rewritten", overwrite: true });
		await waitForApprovals(1);
		const [request] = listWorkspaceApprovals();
		assert.equal(request!.operation, "overwrite_file");
		assert.match(request!.newPreview ?? "", /v2 plan/);
		assert.equal(await fs.readFile(path.join(workspace, "plan.md"), "utf8"), "v1 plan", "still the original while waiting");
		decideWorkspaceApproval(request!.id, true);
		assert.match(await pending, /Overwrote plan\.md/);
		assert.equal(await fs.readFile(path.join(workspace, "plan.md"), "utf8"), "v2 plan, rewritten");
	});

	it("two requests queue oldest-first and are answered independently", async () => {
		await fs.writeFile(path.join(workspace, "a.md"), "a");
		await fs.writeFile(path.join(workspace, "b.md"), "b");
		const first = run("delete_file", { path: "a.md" });
		await waitForApprovals(1);
		const second = run("delete_file", { path: "b.md" });
		await waitForApprovals(2);
		const [one, two] = listWorkspaceApprovals();
		assert.deepEqual([one!.relativePath, two!.relativePath], ["a.md", "b.md"]);
		const secondDeclined = assert.rejects(second, /DECLINED/); // handler attached before it settles
		decideWorkspaceApproval(two!.id, false);
		decideWorkspaceApproval(one!.id, true);
		assert.match(await first, /Deleted a\.md/);
		await secondDeclined;
		assert.ok(!fsSync.existsSync(path.join(workspace, "a.md")));
		assert.ok(fsSync.existsSync(path.join(workspace, "b.md")));
	});

	it("approval routes: listing shape, validation, and stale ids", async () => {
		const listed = await (await getApprovals()).json();
		assert.deepEqual(listed, { approvals: [] });
		const bad = await decideRoute(new Request("http://localhost", { method: "POST", body: JSON.stringify({ decision: "yes" }) }), { params: Promise.resolve({ id: "x" }) });
		assert.equal(bad.status, 400);
		const notJson = await decideRoute(new Request("http://localhost", { method: "POST", body: "{" }), { params: Promise.resolve({ id: "x" }) });
		assert.equal(notJson.status, 400);
		const stale = await decideRoute(new Request("http://localhost", { method: "POST", body: JSON.stringify({ decision: "approve" }) }), { params: Promise.resolve({ id: "no-such-request" }) });
		assert.equal(stale.status, 404);
		assert.equal(decideWorkspaceApproval("no-such-request", true), false);
	});

	it("a model cannot approve itself: tool arguments carry no approval flag, and a made-up flag is ignored", async () => {
		await fs.writeFile(path.join(workspace, "self.md"), "self");
		const pending = run("delete_file", { path: "self.md", approved: true, confirm: true, force: true } as never);
		await waitForApprovals(1);
		assert.ok(fsSync.existsSync(path.join(workspace, "self.md")), "invented approval arguments do nothing");
		decideWorkspaceApproval(listWorkspaceApprovals()[0]!.id, false);
		await assert.rejects(pending, /DECLINED/);
	});
});

describe("which agents carry the workspace tools", () => {
	const names = [...WORKSPACE_TOOL_NAMES].sort();
	const has = (registry: Record<string, unknown>) => names.filter((n) => n in registry);

	it("the Teacher, the Prober and the Practitioner each carry all eight", () => {
		const teacher = createTeacherTools({ chatId: "c", chatStore: {} as never, jobStore: {} as never, spawn: () => {} });
		const prober = createProberTools({ chatId: "c", chatStore: {} as never, deliver: () => {}, jobStore: {} as never, spawn: () => {} });
		const practitioner = practiceTools({ chatId: "c", chatStore: { getChat: () => null } as never } as never);
		for (const [who, registry] of [["teacher", teacher], ["prober", prober], ["practitioner", practitioner]] as const) {
			assert.deepEqual(has(registry), names, `${who} carries the workspace set`);
		}
	});

	it("the workspace tools survive the user's tool toggles (always-on, like the read-only set)", () => {
		const teacher = createTeacherTools({ chatId: "c", chatStore: {} as never, jobStore: {} as never, spawn: () => {} }, { research: false, demo: false });
		assert.deepEqual(has(teacher), names);
	});

	it("NO background worker or unrelated agent registers them — pinned by source scan", async () => {
		const allowed = new Set(["src/agent/tools.ts", "src/agent/tools/practice.ts"].map((p) => path.resolve(p)));
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) { walk(full); continue; }
				if (!/\.(ts|tsx|mjs)$/.test(entry.name)) continue;
				if (full.includes(`${path.sep}tools${path.sep}workspace${path.sep}`)) continue;
				const text = fsSync.readFileSync(full, "utf8");
				if (/\bworkspaceTools\b/.test(text) && !allowed.has(full)) offenders.push(path.relative(process.cwd(), full));
				if (/["'](write_file|edit_file|append_file|delete_file|rename_path|create_directory)["']/.test(text) && !allowed.has(full) && !full.includes(`${path.sep}prompts${path.sep}`)) {
					offenders.push(`${path.relative(process.cwd(), full)} (names a workspace tool)`);
				}
			}
		};
		for (const dir of ["src", "app", "electron"]) if (fsSync.existsSync(dir)) walk(path.resolve(dir));
		// The two registries above, the policy seam's own text, the dialog wiring and the activity label table are the only legitimate mentions.
		const legit = offenders.filter((o) => !/src\/core\/pending\.ts|components\/|src\/server\/workspace/.test(o));
		assert.deepEqual(legit, [], "only the teacher/prober/practice registries compose the workspace tools");
	});

	it("tool descriptions state the approval rule and the executionMode is sequential", () => {
		assert.match(tools.delete_file!.description, /must click Approve/);
		assert.match(tools.write_file!.description, /requires the learner's approval/);
		for (const name of names) assert.equal((tools[name] as { executionMode?: string }).executionMode, "sequential", `${name} runs sequentially`);
	});
});
