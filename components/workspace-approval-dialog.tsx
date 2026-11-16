"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useServerEvent, useServerResync } from "@/components/server-events";

/** The wire shape of GET /api/workspace/approvals (server/workspace-approvals.ts). */
export interface WorkspaceApprovalView {
	id: string;
	operation: "delete_file" | "overwrite_file";
	relativePath: string;
	absolutePath: string;
	sizeBytes: number;
	modifiedAt: string;
	currentPreview?: string;
	newSizeBytes?: number;
	newPreview?: string;
	expiresAt: string;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Copy is design, not implementation — exported for render pins. */
export const APPROVAL_COPY = {
	delete: { title: "Delete file?", body: "The teaching agent wants to permanently delete this file from your workspace. This cannot be undone.", confirm: "Delete file", keep: "Keep file" },
	overwrite: { title: "Replace file contents?", body: "The teaching agent wants to replace everything in this existing file with new content. The old content cannot be recovered afterwards.", confirm: "Replace file", keep: "Keep original" },
} as const;

/**
 * THE WORKSPACE APPROVAL DIALOG (custom build, 2026-11): the learner-facing
 * half of delete_file / write_file(overwrite). Mounted once, app-wide, in
 * layout.tsx — approvals can arrive while any page is open. The text comes
 * from the server's VALIDATED operation (path, size, a preview of the real
 * file), never from model prose.
 *
 * Safe by default: focus starts on the "keep" button, Enter therefore never
 * approves, Escape and the backdrop mean DENY, and an expired request simply
 * disappears (the agent has already been told "no answer").
 */
export function WorkspaceApprovalDialog() {
	const [pending, setPending] = useState<WorkspaceApprovalView[]>([]);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/workspace/approvals", { cache: "no-store" });
			if (!res.ok) return;
			const body = (await res.json()) as { approvals?: WorkspaceApprovalView[] };
			setPending(Array.isArray(body.approvals) ? body.approvals : []);
		} catch {
			/* the next event or reconnect refetches */
		}
	}, []);

	useEffect(() => { void refresh(); }, [refresh]);
	useServerEvent("workspace-approvals-changed", () => void refresh());
	useServerResync(() => void refresh());

	const current = pending[0] ?? null;

	const decide = useCallback(async (approve: boolean) => {
		if (!current || busy) return;
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/workspace/approvals/${encodeURIComponent(current.id)}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ decision: approve ? "approve" : "deny" }),
			});
			// 404 = it expired or its run was cancelled: nothing to do but refresh.
			if (!res.ok && res.status !== 404) setFailure("Could not send your answer. Try again.");
		} catch {
			setFailure("Could not send your answer — network error. Try again.");
		} finally {
			setBusy(false);
			void refresh();
		}
	}, [current, busy, refresh]);

	const decideRef = useRef(decide);
	decideRef.current = decide;

	// Esc = deny (claimed, so it also cannot abort a turn underneath).
	useEffect(() => {
		if (!current) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				void decideRef.current(false);
			}
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [current]);

	if (!current) return null;
	return createPortal(
		<div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80">
			<WorkspaceApprovalBody
				approval={current}
				waiting={pending.length - 1}
				busy={busy}
				failure={failure}
				onApprove={() => void decide(true)}
				onDeny={() => void decide(false)}
			/>
		</div>,
		document.body,
	);
}

/** Pure body — exported for SSR pins (the DeleteSessionBody pattern). */
export function WorkspaceApprovalBody({
	approval,
	waiting,
	busy,
	failure,
	onApprove,
	onDeny,
}: {
	approval: WorkspaceApprovalView;
	/** How many more requests are queued behind this one. */
	waiting: number;
	busy: boolean;
	failure: string | null;
	onApprove: () => void;
	onDeny: () => void;
}) {
	const copy = approval.operation === "delete_file" ? APPROVAL_COPY.delete : APPROVAL_COPY.overwrite;
	const overwrite = approval.operation === "overwrite_file";
	return (
		<div
			role="alertdialog"
			aria-modal="true"
			aria-label={copy.title}
			data-testid="workspace-approval-dialog"
			onClick={(e) => e.stopPropagation()}
			className="w-[36rem] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-5 shadow-xl"
		>
			<h2 className="text-sm font-semibold text-destructive">{copy.title}</h2>
			<div className="mt-1.5">
				<code data-testid="workspace-approval-path" className="break-all font-mono text-sm text-foreground">{approval.relativePath}</code>
			</div>
			<p className="mt-2 text-sm text-muted-foreground">{copy.body}</p>
			<dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<dt>Location</dt>
				<dd data-testid="workspace-approval-location" className="break-all font-mono">{approval.absolutePath}</dd>
				<dt>Size</dt>
				<dd>{formatBytes(approval.sizeBytes)}{overwrite && approval.newSizeBytes !== undefined ? ` → ${formatBytes(approval.newSizeBytes)}` : ""}</dd>
				<dt>Last modified</dt>
				<dd>{new Date(approval.modifiedAt).toLocaleString()}</dd>
			</dl>
			{approval.currentPreview !== undefined && (
				<div className="mt-3">
					<div className="text-xs text-muted-foreground">{overwrite ? "Current beginning" : "Beginning of the file"}</div>
					<pre data-testid="workspace-approval-preview" className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm border border-border/60 bg-background px-3 py-2 font-mono text-xs text-foreground">{approval.currentPreview || "(empty file)"}</pre>
				</div>
			)}
			{overwrite && approval.newPreview !== undefined && (
				<div className="mt-3">
					<div className="text-xs text-muted-foreground">Replacement beginning</div>
					<pre data-testid="workspace-approval-new-preview" className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-sm border border-border/60 bg-background px-3 py-2 font-mono text-xs text-foreground">{approval.newPreview || "(empty)"}</pre>
				</div>
			)}
			{failure && (
				<div role="alert" data-testid="workspace-approval-failure" className="mt-3 rounded-sm border border-border/60 px-3 py-2 text-xs text-foreground">{failure}</div>
			)}
			{waiting > 0 && <p data-testid="workspace-approval-waiting" className="mt-3 text-xs text-muted-foreground">{waiting} more request{waiting === 1 ? "" : "s"} waiting.</p>}
			<div className="mt-4 flex justify-end gap-2">
				{/* The SAFE button is first and focused: Enter never approves. */}
				<button
					type="button"
					autoFocus
					data-testid="workspace-approval-deny"
					onClick={onDeny}
					disabled={busy}
					className="rounded-sm border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-40"
				>
					{copy.keep}
				</button>
				<button
					type="button"
					data-testid="workspace-approval-approve"
					onClick={onApprove}
					disabled={busy}
					className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-40"
				>
					{busy ? "Working…" : copy.confirm}
				</button>
			</div>
		</div>
	);
}
