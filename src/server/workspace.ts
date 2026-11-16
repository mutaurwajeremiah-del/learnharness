/**
 * WORKSPACE (custom build, 2026-11) — the composition-root half: turns the
 * persisted setting (store/settings.ts → readWorkspaceSettings) into the
 * policy the agent-layer file tools read, and answers the Settings UI's
 * "is my workspace usable?" question. The agent layer never imports store
 * adapters; chat-handler wires workspacePolicy() into its seam, exactly like
 * fileAccessPolicy().
 *
 * Works identically in dev and the packaged Electron app: the setting lives
 * in settings.json under LH_DATA_DIR (= userData/data when packaged), so it
 * survives restarts and updates by construction.
 */
import fs from "node:fs";
import { DEFAULT_WORKSPACE_ROOT } from "../core/workspace.ts";
import { assessWorkspaceRoot, prospectiveRootProblem } from "../agent/tools/workspace/paths.ts";
import type { WorkspacePolicy } from "../agent/tools/workspace/policy.ts";
import { readWorkspaceSettings } from "../store/settings.ts";

/** Configured root, or the default when never set. Fail closed on a broken record. */
export function workspacePolicy(): WorkspacePolicy {
	const result = readWorkspaceSettings();
	if (!result.ok) return { root: null, error: result.error };
	return { root: result.settings?.root ?? DEFAULT_WORKSPACE_ROOT };
}

export interface WorkspaceStatus {
	/** The configured (or default) folder, as the learner wrote it. Empty when the setting itself is broken. */
	root: string;
	source: "default" | "custom";
	/** ready · missing (can be created) · invalid (never usable: overlaps app data, bad syntax) · unavailable (exists but unreadable / read-only / offline). */
	state: "ready" | "missing" | "invalid" | "unavailable";
	/** Human-readable reason when not ready. */
	message: string | null;
	/** True when "Create folder" would be accepted. */
	canCreate: boolean;
}

export function workspaceStatus(): WorkspaceStatus {
	const stored = readWorkspaceSettings();
	if (!stored.ok) return { root: "", source: "custom", state: "invalid", message: stored.error, canCreate: false };
	const source = stored.settings ? "custom" : "default";
	const root = stored.settings?.root ?? DEFAULT_WORKSPACE_ROOT;
	const assessment = assessWorkspaceRoot(root);
	if (assessment.ok) return { root, source, state: "ready", message: null, canCreate: false };
	if (assessment.code === "missing") {
		// A folder that is missing AND could never be created (it would sit
		// inside LearnHarness's own data, say) says WHY, not just "missing".
		const problem = prospectiveRootProblem(root);
		return { root, source, state: "missing", message: problem ?? assessment.message, canCreate: problem === null };
	}
	const state = assessment.code === "invalid" || assessment.code === "protected" || assessment.code === "not-directory" ? "invalid" : "unavailable";
	return { root, source, state, message: assessment.message, canCreate: false };
}

/** "Create folder" in Settings: makes the configured workspace if (and only
 *  if) it is missing and acceptable. Never touches an existing folder. */
export function createWorkspaceFolder(): WorkspaceStatus {
	const before = workspaceStatus();
	if (before.state === "ready") return before;
	if (before.state !== "missing" || !before.canCreate) {
		throw new Error(before.message ?? "The workspace folder cannot be created.");
	}
	const problem = prospectiveRootProblem(before.root); // re-checked at the moment of creation
	if (problem) throw new Error(problem);
	fs.mkdirSync(before.root, { recursive: true });
	return workspaceStatus();
}
