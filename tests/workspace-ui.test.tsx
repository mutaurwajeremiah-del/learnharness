/** Workspace UI (custom build, 2026-11): the approval dialog and the Settings row, driven with a fake fetch and a fake event channel — no Electron, no network. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";
import { APPROVAL_COPY, WorkspaceApprovalBody, WorkspaceApprovalDialog, formatBytes, type WorkspaceApprovalView } from "../components/workspace-approval-dialog.tsx";
import { WorkspaceSettingsRow, composeWorkspaceRoot, workspaceStatusLine, type WorkspaceStatusView } from "../components/settings/workspace-row.tsx";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, CustomEvent: dom.window.CustomEvent });
const originalFetch = globalThis.fetch;
const roots: { root: Root; host: HTMLElement }[] = [];
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid='${id}']`);
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); };

const deleteView: WorkspaceApprovalView = {
	id: "req-1", operation: "delete_file", relativePath: "calculus/limits.md", absolutePath: "C:\\Users\\hp\\Learning\\calculus\\limits.md",
	sizeBytes: 2048, modifiedAt: "2026-11-10T10:00:00.000Z", currentPreview: "# Limits\nepsilon-delta", expiresAt: "2026-11-10T10:10:00.000Z",
};
const overwriteView: WorkspaceApprovalView = { ...deleteView, id: "req-2", operation: "overwrite_file", newSizeBytes: 4096, newPreview: "# Rewritten" };

afterEach(() => {
	for (const { root, host } of roots.splice(0)) { act(() => root.unmount()); host.remove(); }
	globalThis.fetch = originalFetch;
	document.body.innerHTML = "";
});

describe("approval dialog body (pure)", () => {
	it("a delete request shows the exact file, where it lives, its size and a preview — and the safe button comes first", () => {
		const html = renderToStaticMarkup(<WorkspaceApprovalBody approval={deleteView} waiting={0} busy={false} failure={null} onApprove={() => {}} onDeny={() => {}} />);
		assert.match(html, /Delete file\?/);
		assert.match(html, /calculus\/limits\.md/);
		assert.match(html, /C:\\Users\\hp\\Learning\\calculus\\limits\.md/);
		assert.match(html, /2\.0 KB/);
		assert.match(html, /epsilon-delta/);
		assert.match(html, /role="alertdialog"/);
		assert.ok(html.indexOf("workspace-approval-deny") < html.indexOf("workspace-approval-approve"), "the safe Keep button precedes Delete");
		assert.match(html, /<button[^>]*autofocus[^>]*workspace-approval-deny|<button[^>]*workspace-approval-deny[^>]*autofocus/i, "focus starts on the safe button");
		assert.match(html, new RegExp(APPROVAL_COPY.delete.keep));
		assert.doesNotMatch(html, /workspace-approval-waiting/);
	});

	it("an overwrite request shows both the current and the replacement text and sizes", () => {
		const html = renderToStaticMarkup(<WorkspaceApprovalBody approval={overwriteView} waiting={2} busy={false} failure="Could not send" onApprove={() => {}} onDeny={() => {}} />);
		assert.match(html, /Replace file contents\?/);
		assert.match(html, /2\.0 KB → 4\.0 KB/);
		assert.match(html, /# Rewritten/);
		assert.match(html, /2 more requests waiting/);
		assert.match(html, /Could not send/);
	});

	it("formatBytes", () => {
		assert.deepEqual([formatBytes(0), formatBytes(1023), formatBytes(1536), formatBytes(5 * 1024 * 1024)], ["0 B", "1023 B", "1.5 KB", "5.0 MB"]);
	});
});

describe("approval dialog (live, fake fetch + event channel)", () => {
	function mount(fetchImpl: typeof fetch) {
		globalThis.fetch = fetchImpl;
		const handlers = new Map<string, (data: string) => void>();
		const source: NotifySource = { close() {}, onOpen() {}, onEvent: (name, cb) => { handlers.set(name, cb); } };
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push({ root, host });
		act(() => root.render(<ServerEventsProvider connect={() => source}><WorkspaceApprovalDialog /></ServerEventsProvider>));
		return { handlers };
	}

	it("renders nothing while there is nothing to approve, then appears when the server announces a request", async () => {
		let list: WorkspaceApprovalView[] = [];
		const { handlers } = mount((async () => new Response(JSON.stringify({ approvals: list }))) as typeof fetch);
		await flush();
		assert.equal(q("workspace-approval-dialog"), null);
		list = [deleteView];
		act(() => handlers.get("workspace-approvals-changed")!("{}"));
		await flush();
		assert.ok(q("workspace-approval-dialog"), "the dialog opens on the event");
		assert.equal(q("workspace-approval-path")?.textContent, "calculus/limits.md");
	});

	it("Approve posts decision=approve for that id; Keep posts deny; Escape means deny", async () => {
		const posts: { url: string; body: string }[] = [];
		let list: WorkspaceApprovalView[] = [deleteView];
		mount((async (url: string, init?: RequestInit) => {
			if (init?.method === "POST") { posts.push({ url: String(url), body: String(init.body) }); list = []; return new Response("{}"); }
			return new Response(JSON.stringify({ approvals: list }));
		}) as typeof fetch);
		await flush();
		await act(async () => { q("workspace-approval-approve")!.click(); });
		await flush();
		assert.deepEqual(posts, [{ url: "/api/workspace/approvals/req-1", body: JSON.stringify({ decision: "approve" }) }]);
		assert.equal(q("workspace-approval-dialog"), null, "answered requests leave the dialog");

		list = [{ ...deleteView, id: "req-3" }];
		posts.length = 0;
		const { handlers } = mount((async (url: string, init?: RequestInit) => {
			if (init?.method === "POST") { posts.push({ url: String(url), body: String(init.body) }); list = []; return new Response("{}"); }
			return new Response(JSON.stringify({ approvals: list }));
		}) as typeof fetch);
		void handlers;
		await flush();
		await act(async () => { q("workspace-approval-deny")!.click(); });
		await flush();
		assert.equal(JSON.parse(posts[0]!.body).decision, "deny");

		list = [{ ...deleteView, id: "req-4" }];
		posts.length = 0;
		mount((async (url: string, init?: RequestInit) => {
			if (init?.method === "POST") { posts.push({ url: String(url), body: String(init.body) }); list = []; return new Response("{}"); }
			return new Response(JSON.stringify({ approvals: list }));
		}) as typeof fetch);
		await flush();
		await act(async () => {
			const escape = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(escape, "key", { value: "Escape" });
			document.dispatchEvent(escape);
		});
		await flush();
		assert.equal(JSON.parse(posts[0]!.body).decision, "deny", "Escape never approves");
	});

	it("a failed answer keeps the dialog and says so instead of pretending it worked", async () => {
		mount((async (_url: string, init?: RequestInit) => (init?.method === "POST" ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ approvals: [deleteView] })))) as typeof fetch);
		await flush();
		await act(async () => { q("workspace-approval-approve")!.click(); });
		await flush();
		assert.ok(q("workspace-approval-dialog"));
		assert.match(q("workspace-approval-failure")?.textContent ?? "", /Could not send your answer/);
	});
});

describe("Settings → Agent → Workspace row", () => {
	const ready: WorkspaceStatusView = { root: "D:\\Notes", source: "custom", state: "ready", message: null, canCreate: false };

	it("pure: compose keeps the rest of the agent section, status lines are honest", () => {
		assert.deepEqual(composeWorkspaceRoot({ search: { engine: "brave" } } as never, "D:\\Notes"), { search: { engine: "brave" }, workspace: { root: "D:\\Notes" } });
		assert.deepEqual(composeWorkspaceRoot({ workspace: { root: "D:\\Old" }, search: { engine: "brave" } } as never, null), { search: { engine: "brave" } });
		assert.deepEqual(composeWorkspaceRoot(undefined, "D:\\Notes"), { workspace: { root: "D:\\Notes" } });
		assert.equal(workspaceStatusLine(null).tone, "pending");
		assert.equal(workspaceStatusLine(ready).tone, "ok");
		assert.match(workspaceStatusLine({ ...ready, state: "missing", canCreate: true }).text, /Create it/);
		assert.match(workspaceStatusLine({ ...ready, state: "invalid", message: "overlaps data" }).text, /overlaps data/);
	});

	function mountRow(status: WorkspaceStatusView, onSectionChange: (next: unknown) => void, agent?: unknown) {
		const calls: string[] = [];
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? "GET"} ${url}`);
			return new Response(JSON.stringify(status));
		}) as typeof fetch;
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		roots.push({ root, host });
		act(() => root.render(<WorkspaceSettingsRow agent={agent as never} onSectionChange={onSectionChange as never} />));
		return calls;
	}

	it("shows the default workspace and its live status; Browse saves a validated folder and refuses a relative one", async () => {
		const saved: unknown[] = [];
		mountRow(ready, (next) => saved.push(next), { search: { engine: "brave" } });
		await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
		assert.equal(q("workspace-source")?.textContent, "Built-in", "the repo forbids a bare Default label; the built-in folder says Built-in");
		assert.match(q("workspace-current")?.textContent ?? "", /code understood masterclass/);
		assert.match(q("workspace-status")?.textContent ?? "", /Ready/);
		let picked: string | null = "relative/nope";
		(window as unknown as { lh?: unknown }).lh = { chooseAttachmentFolder: async () => picked };
		await act(async () => { q("workspace-browse")!.click(); });
		await flush();
		assert.deepEqual(saved, [], "a relative path is refused before anything is saved");
		assert.match(q("workspace-error")?.textContent ?? "", /absolute path/);
		picked = "D:\\Learning";
		await act(async () => { q("workspace-browse")!.click(); });
		await flush();
		assert.deepEqual(saved, [{ search: { engine: "brave" }, workspace: { root: "D:\\Learning" } }]);
		picked = null; // native cancellation leaves everything alone
		await act(async () => { q("workspace-browse")!.click(); });
		await flush();
		assert.equal(saved.length, 1);
		delete (window as unknown as { lh?: unknown }).lh;
		await act(async () => { q("workspace-browse")!.click(); });
		assert.match(q("workspace-error")?.textContent ?? "", /desktop app/);
	});

	it("offers Create folder for a missing creatable folder (POST /api/workspace) and 'Use default' only when customised", async () => {
		const calls = mountRow({ ...ready, state: "missing", canCreate: true, message: "does not exist" }, () => {}, { workspace: { root: "D:\\Notes" } });
		await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
		assert.ok(q("workspace-create"));
		assert.ok(q("workspace-reset"), "a custom folder can be reset");
		await act(async () => { q("workspace-create")!.click(); });
		await flush();
		assert.ok(calls.includes("POST /api/workspace"));
	});

	it("shows the failure reason and offers no Create button for an unusable folder", async () => {
		mountRow({ ...ready, state: "invalid", message: "The workspace cannot overlap LearnHarness's own data or credentials." }, () => {});
		await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
		assert.match(q("workspace-status")?.textContent ?? "", /cannot overlap/);
		assert.equal(q("workspace-create"), null);
		assert.equal(q("workspace-reset"), null, "the default needs no reset");
	});
});
