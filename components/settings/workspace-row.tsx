"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_WORKSPACE_ROOT, parseWorkspaceSettings, type AgentSettings } from "@/src/core";
import { SettingsRow } from "./controls.tsx";

/** GET /api/workspace (src/server/workspace.ts → WorkspaceStatus). */
export interface WorkspaceStatusView {
	root: string;
	source: "default" | "custom";
	state: "ready" | "missing" | "invalid" | "unavailable";
	message: string | null;
	canCreate: boolean;
}

/** Compose: the workspace folder set (or cleared back to the default), the
 *  rest of the agent section carried verbatim — the replace-PUT discipline. */
export function composeWorkspaceRoot(agent: AgentSettings | undefined, root: string | null): AgentSettings {
	const { workspace: _previous, ...rest } = agent ?? {};
	return root === null ? rest : { ...rest, workspace: { root } };
}

/** Pure status line — exported for render pins. */
export function workspaceStatusLine(status: WorkspaceStatusView | null): { tone: "ok" | "warn" | "pending"; text: string } {
	if (!status) return { tone: "pending", text: "Checking the workspace folder…" };
	switch (status.state) {
		case "ready": return { tone: "ok", text: "Ready — the teaching agents can read and write files here." };
		case "missing": return { tone: "warn", text: status.canCreate ? "This folder does not exist yet. Create it, or choose another." : (status.message ?? "This folder does not exist.") };
		default: return { tone: "warn", text: status.message ?? "The workspace is not available." };
	}
}

/**
 * Settings → Agent → Workspace (custom build, 2026-11). One folder the Teacher,
 * Practitioner and Prober may create/edit/rename (and delete, with your
 * approval) files in. Saved to settings.json like every preference, so it
 * persists across restarts and updates. Distinct from "File access", which
 * only lets agents READ your other folders.
 */
export function WorkspaceSettingsRow({
	agent,
	onSectionChange,
}: {
	agent: AgentSettings | undefined;
	onSectionChange: (next: AgentSettings) => void;
}) {
	const saved = agent?.workspace?.root ?? null;
	const [status, setStatus] = useState<WorkspaceStatusView | null>(null);
	const [draft, setDraft] = useState(saved ?? "");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/workspace", { cache: "no-store" });
			if (res.ok) setStatus((await res.json()) as WorkspaceStatusView);
		} catch {
			setStatus(null);
		}
	}, []);

	// Re-check on mount and whenever the saved folder changes (the PUT lands
	// shortly after onSectionChange; the delay lets it settle first).
	useEffect(() => {
		setDraft(saved ?? "");
		const timer = setTimeout(() => void refresh(), 350);
		return () => clearTimeout(timer);
	}, [saved, refresh]);

	const effective = saved ?? DEFAULT_WORKSPACE_ROOT;
	const dirty = draft.trim() !== (saved ?? "").trim() && draft.trim() !== "";

	const save = (value: string) => {
		const parsed = parseWorkspaceSettings({ root: value });
		if (!parsed.ok) { setError(parsed.error); return; }
		setError(null);
		onSectionChange(composeWorkspaceRoot(agent, parsed.settings.root));
	};

	const browse = async () => {
		const choose = window.lh?.chooseAttachmentFolder;
		if (!choose) { setError("Folder browsing is available in the desktop app. Type the full folder path instead."); return; }
		try {
			const chosen = await choose();
			if (chosen) { setDraft(chosen); save(chosen); }
		} catch { setError("Could not open the folder picker. Type the full folder path instead."); }
	};

	const create = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "create" }) });
			const body = (await res.json()) as WorkspaceStatusView & { error?: string };
			if (!res.ok) setError(body.error ?? "The folder could not be created.");
			else setStatus(body);
		} catch { setError("The folder could not be created — network error."); }
		finally { setBusy(false); }
	};

	const line = workspaceStatusLine(status);
	return (
		<div data-testid="workspace-row" className="flex flex-col gap-2">
			<SettingsRow
				label="Workspace"
				hint="The one folder the teaching agents may create, edit, rename and (with your approval) delete files in."
			>
				<span data-testid="workspace-source" className="text-xs text-muted-foreground">{saved === null ? "Built-in" : "Custom"}</span>
			</SettingsRow>
			<div className="flex gap-2 pl-3">
				<input
					value={draft}
					aria-label="Workspace folder path"
					data-testid="workspace-input"
					placeholder={DEFAULT_WORKSPACE_ROOT}
					onChange={(event) => { setDraft(event.target.value); setError(null); }}
					onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (draft.trim()) save(draft.trim()); } }}
					className="min-w-0 flex-1 rounded-sm border border-border bg-background px-2 py-1 font-ui text-xs"
				/>
				<button type="button" data-testid="workspace-browse" onClick={() => void browse()} className="rounded-sm border border-border px-2 text-xs">Browse…</button>
				<button type="button" data-testid="workspace-save" disabled={!dirty} onClick={() => save(draft.trim())} className="rounded-sm border border-border px-2 text-xs disabled:opacity-40">Save</button>
			</div>
			<div className="flex flex-wrap items-center gap-3 pl-3 text-xs">
				<span
					data-testid="workspace-status"
					role={line.tone === "warn" ? "alert" : "status"}
					className={line.tone === "ok" ? "text-muted-foreground" : line.tone === "warn" ? "text-red-500" : "text-muted-foreground/70"}
				>
					{line.text}
				</span>
				{status?.state === "missing" && status.canCreate && (
					<button type="button" data-testid="workspace-create" disabled={busy} onClick={() => void create()} className="rounded-sm border border-border px-2 py-0.5 disabled:opacity-40">Create folder</button>
				)}
				<button type="button" data-testid="workspace-recheck" onClick={() => void refresh()} className="text-muted-foreground hover:text-foreground">Re-check</button>
				{saved !== null && (
					<button type="button" data-testid="workspace-reset" onClick={() => { setError(null); onSectionChange(composeWorkspaceRoot(agent, null)); }} className="text-muted-foreground hover:text-foreground">Use default</button>
				)}
			</div>
			<p data-testid="workspace-current" title={effective} className="truncate pl-3 font-ui text-xs text-muted-foreground/70">In use: {effective}</p>
			{error && <p role="alert" data-testid="workspace-error" className="pl-3 text-xs text-red-500">{error}</p>}
		</div>
	);
}
