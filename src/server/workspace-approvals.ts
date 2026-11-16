/**
 * THE APPROVAL BROKER (custom build, 2026-11): the server half of the
 * learner-confirmation mechanism for destructive workspace operations
 * (delete_file, write_file overwrite=true).
 *
 * WHY A BROKER, NOT A QUESTION TOOL: the practitioner has no question tools,
 * and a confirmation the MODEL can fabricate ("the user said yes") is not a
 * confirmation. Here the agent's tool call BLOCKS on a promise; the only way
 * to resolve it is an authenticated HTTP decision from the app window
 * (proxy.ts requires the private desktop capability on every /api call, so
 * a model with a web-fetch tool cannot reach it). The dialog text is built
 * from the VALIDATED operation, never from model prose.
 *
 * Ephemeral by design: pending requests live in process memory. A restart
 * kills the blocked run with them — the file is simply left alone.
 *
 * globalThis-backed (the events.ts discipline): Next compiles each route as
 * its own module entry, and the agent run, the list route and the decision
 * route must all see ONE registry.
 */
import { randomUUID } from "node:crypto";
import { emit } from "../core/events.ts";
import type {
	WorkspaceApprovalBroker,
	WorkspaceApprovalInput,
	WorkspaceApprovalOutcome,
} from "../agent/tools/workspace/policy.ts";

/** What the learner sees. */
export interface WorkspaceApprovalRequest extends WorkspaceApprovalInput {
	id: string;
	createdAt: string;
	expiresAt: string;
}

interface Pending {
	request: WorkspaceApprovalRequest;
	settle: (outcome: WorkspaceApprovalOutcome) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Test seam (the toolTimeoutMs idiom). */
export const workspaceApprovalTimeoutMs = { current: DEFAULT_TIMEOUT_MS };

interface Global {
	__lhWorkspaceApprovals?: Map<string, Pending>;
}

function registry(): Map<string, Pending> {
	const g = globalThis as typeof globalThis & Global;
	return (g.__lhWorkspaceApprovals ??= new Map());
}

export const workspaceApprovalBroker: WorkspaceApprovalBroker = {
	request(input: WorkspaceApprovalInput, signal?: AbortSignal): Promise<WorkspaceApprovalOutcome> {
		if (signal?.aborted) return Promise.resolve({ status: "aborted" });
		return new Promise((resolve) => {
			const id = randomUUID();
			const now = Date.now();
			const request: WorkspaceApprovalRequest = {
				...input,
				id,
				createdAt: new Date(now).toISOString(),
				expiresAt: new Date(now + workspaceApprovalTimeoutMs.current).toISOString(),
			};
			let settled = false;
			const onAbort = () => settle({ status: "aborted" });
			// Deliberately NOT unref'd: a pending approval is a reason to stay alive
			// (bounded by the timeout), and a stalled promise must always settle.
			const timer = setTimeout(() => settle({ status: "timeout" }), workspaceApprovalTimeoutMs.current);
			function settle(outcome: WorkspaceApprovalOutcome): void {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				registry().delete(id);
				emit("workspace-approvals-changed", {});
				resolve(outcome);
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			registry().set(id, { request, settle });
			emit("workspace-approvals-changed", {});
		});
	},
};

/** Oldest first — the dialog answers them in the order they were asked. */
export function listWorkspaceApprovals(): WorkspaceApprovalRequest[] {
	return [...registry().values()].map((p) => p.request).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Resolve one pending request. False when it no longer exists (already
 *  answered, timed out, or the run was cancelled). */
export function decideWorkspaceApproval(id: string, approved: boolean): boolean {
	const pending = registry().get(id);
	if (!pending) return false;
	pending.settle(approved ? { status: "approved" } : { status: "denied" });
	return true;
}
