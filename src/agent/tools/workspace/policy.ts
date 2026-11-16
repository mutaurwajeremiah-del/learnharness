/**
 * Workspace policy + approval seams (the agent layer never imports server or
 * store adapters — eslint.config.mjs — so the composition root injects both,
 * exactly like tools/file-access.ts does for the read-only policy).
 *
 * FAIL CLOSED: until the server wires a provider, the workspace is
 * "not configured" and every tool refuses; until it wires an approval broker,
 * every destructive operation refuses. Tests drive both seams directly.
 */

export interface WorkspacePolicy {
	/** Configured workspace root, or null when none is usable. */
	root: string | null;
	/** Why the workspace is unusable (settings unreadable/malformed). */
	error?: string;
}

const CLOSED_POLICY: WorkspacePolicy = { root: null, error: "Workspace is not configured." };
let currentPolicy: () => WorkspacePolicy = () => CLOSED_POLICY;

export function setWorkspacePolicy(provider: () => WorkspacePolicy): void {
	currentPolicy = provider;
}

/** Fresh per operation: a settings change applies to the next tool call. */
export function workspacePolicy(): WorkspacePolicy {
	let policy: WorkspacePolicy;
	try {
		policy = currentPolicy();
	} catch {
		return { root: null, error: "Workspace configuration cannot be read. Repair it in Settings → Agent → Workspace." };
	}
	if (!policy || typeof policy !== "object") return CLOSED_POLICY;
	if (policy.error) return { root: null, error: policy.error };
	if (typeof policy.root !== "string" || policy.root.length === 0) return CLOSED_POLICY;
	return { root: policy.root };
}

// ─── Approval seam ───────────────────────────────────────────────────────────

export type WorkspaceApprovalOperation = "delete_file" | "overwrite_file";

/** What the learner sees in the approval dialog. Server-authored from the
 *  VALIDATED operation — never from model-supplied prose, so a model cannot
 *  mislabel what it is asking to do. */
export interface WorkspaceApprovalInput {
	chatId: string;
	toolCallId: string;
	operation: WorkspaceApprovalOperation;
	/** Workspace-relative, forward-slash display path. */
	relativePath: string;
	/** Canonical absolute path (display only). */
	absolutePath: string;
	sizeBytes: number;
	modifiedAt: string;
	/** First lines of the CURRENT file (text only; bounded). */
	currentPreview?: string;
	/** overwrite_file only: size and first lines of the replacement. */
	newSizeBytes?: number;
	newPreview?: string;
}

export type WorkspaceApprovalOutcome =
	| { status: "approved" }
	| { status: "denied" }
	| { status: "timeout" }
	| { status: "aborted" }
	| { status: "unavailable"; reason: string };

export interface WorkspaceApprovalBroker {
	request(input: WorkspaceApprovalInput, signal?: AbortSignal): Promise<WorkspaceApprovalOutcome>;
}

let currentBroker: WorkspaceApprovalBroker | null = null;

export function setWorkspaceApprovalBroker(broker: WorkspaceApprovalBroker | null): void {
	currentBroker = broker;
}

export function workspaceApprovalBroker(): WorkspaceApprovalBroker | null {
	return currentBroker;
}
