import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute, toToolResult } from "../../tool-execute.ts";
import {
	appendFileOp,
	createDirectoryOp,
	deleteFileOp,
	editFileOp,
	listDirectoryOp,
	readFileOp,
	renamePathOp,
	writeFileOp,
	MAX_WRITE_BYTES,
	type OpContext,
} from "./fileops.ts";
import { formatSize } from "../fs-shared.ts";

/**
 * THE WORKSPACE TOOLS (custom build, 2026-11): the learner-facing agents'
 * file-authoring set, confined to the learner's configured workspace folder
 * (Settings → Agent → Workspace). Distinct from read/ls/find/grep, which stay
 * the read-only, home-wide LEARNER-SOURCE tools — these eight only ever see
 * the workspace and are the only tools that can change files.
 *
 * Composition: tools.ts (teacher, prober) and tools/practice.ts (practitioner)
 * call workspaceTools(); NO background worker (extraction, research, demo,
 * visual, pdf, graph jobs) does — pinned in tests/workspace-tools.test.ts.
 *
 * Mechanics-only descriptions (the repo's doctrine ruling): WHAT to pass and
 * WHAT happens. When-to-use judgement lives in the prompt fragments.
 */

export const WORKSPACE_TOOL_NAMES = [
	"read_file",
	"list_directory",
	"write_file",
	"edit_file",
	"append_file",
	"create_directory",
	"rename_path",
	"delete_file",
] as const;

export interface WorkspaceToolContext {
	chatId: string;
}

const pathHint = "Path relative to the workspace root, e.g. \"calculus/limits.md\". Forward or back slashes both work. Absolute paths are accepted only when they are inside the workspace.";

const readInput = Type.Object({
	path: Type.String({ description: pathHint }),
	offset: Type.Optional(Type.Integer({ description: "Line number to start from (1-indexed)." })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of lines to read." })),
});

const listInput = Type.Object({
	path: Type.Optional(Type.String({ description: "Folder to list, relative to the workspace root. Default: the workspace root." })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of entries (default 500)." })),
});

const writeInput = Type.Object({
	path: Type.String({ description: pathHint }),
	content: Type.String({ description: "The complete file content (UTF-8 text)." }),
	overwrite: Type.Optional(Type.Boolean({ description: "Set true ONLY to replace an existing file entirely. Needs the learner's approval." })),
});

const editInput = Type.Object({
	path: Type.String({ description: pathHint }),
	old_string: Type.String({ description: "Exact text to replace, copied from read_file (whitespace and case matter). Must match exactly once unless replace_all is true." }),
	new_string: Type.String({ description: "Replacement text." }),
	replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence of old_string." })),
});

const appendInput = Type.Object({
	path: Type.String({ description: pathHint }),
	content: Type.String({ description: "Text to add at the end of the file. A line break is inserted first if the file does not end with one." }),
	create_if_missing: Type.Optional(Type.Boolean({ description: "Create the file when it does not exist (default false, so a typo cannot spawn a duplicate)." })),
});

const dirInput = Type.Object({
	path: Type.String({ description: "Folder to create, relative to the workspace root. Missing parent folders are created too." }),
});

const renameInput = Type.Object({
	from: Type.String({ description: "Existing file or folder, relative to the workspace root." }),
	to: Type.String({ description: "New path, relative to the workspace root. Must not exist; the destination folder must exist." }),
});

const deleteInput = Type.Object({
	path: Type.String({ description: pathHint }),
});

/** Mutating/approval tools: no 30 s guard (the learner may take minutes to
 *  answer an approval dialog) — they still honour the run's abort signal via
 *  the broker. Everything else goes through the guard like the other fs tools. */
function approvalExecute<T>(run: (input: T, ctx: OpContext) => Promise<string>, chatId: string): AgentTool<any>["execute"] {
	return async (toolCallId, input: unknown, signal) =>
		toToolResult(await run(input as T, { chatId, toolCallId, signal }));
}

export function workspaceTools(ctx: WorkspaceToolContext): Record<string, AgentTool<any>> {
	const { chatId } = ctx;
	const tools: Record<string, AgentTool<any>> = {
		read_file: {
			name: "read_file",
			label: "read_file",
			description: "Read a text file from the learner's workspace folder (the folder you keep their learning materials in). Output is truncated to 2000 lines or 50KB; use offset/limit to page. Read a file before editing it.",
			parameters: readInput,
			executionMode: "sequential",
			execute: serverExecute("read_file", readInput, (input: Static<typeof readInput>) => readFileOp(input)),
		} satisfies AgentTool<typeof readInput>,
		list_directory: {
			name: "list_directory",
			label: "list_directory",
			description: "List a folder inside the learner's workspace (default: the workspace root, whose absolute path is shown). Directories end with '/'. Use it to check what already exists before creating a file.",
			parameters: listInput,
			executionMode: "sequential",
			execute: serverExecute("list_directory", listInput, (input: Static<typeof listInput>) => listDirectoryOp(input)),
		} satisfies AgentTool<typeof listInput>,
		write_file: {
			name: "write_file",
			label: "write_file",
			description: `Create a NEW text file in the workspace (missing parent folders are created). Fails if the file already exists — use edit_file or append_file for existing files. overwrite=true replaces an existing file entirely and requires the learner's approval in a dialog; if they decline, nothing changes. Max ${formatSize(MAX_WRITE_BYTES)} per call.`,
			parameters: writeInput,
			executionMode: "sequential",
			execute: approvalExecute<Static<typeof writeInput>>((input, op) => writeFileOp(input, op), chatId),
		} satisfies AgentTool<typeof writeInput>,
		edit_file: {
			name: "edit_file",
			label: "edit_file",
			description: "Change an existing text file by replacing exact text. old_string must match exactly once (include surrounding lines to make it unique) unless replace_all is true; the file's line endings and encoding are preserved. Fails without changing anything when old_string is not found or is ambiguous.",
			parameters: editInput,
			executionMode: "sequential",
			execute: serverExecute("edit_file", editInput, (input: Static<typeof editInput>) => editFileOp(input)),
		} satisfies AgentTool<typeof editInput>,
		append_file: {
			name: "append_file",
			label: "append_file",
			description: "Add text to the END of an existing file (progress logs, running notes). Existing content is never modified. Fails if the file does not exist unless create_if_missing is true.",
			parameters: appendInput,
			executionMode: "sequential",
			execute: serverExecute("append_file", appendInput, (input: Static<typeof appendInput>) => appendFileOp(input)),
		} satisfies AgentTool<typeof appendInput>,
		create_directory: {
			name: "create_directory",
			label: "create_directory",
			description: "Create a folder (and any missing parents) inside the workspace. Succeeds without change if it already exists.",
			parameters: dirInput,
			executionMode: "sequential",
			execute: serverExecute("create_directory", dirInput, (input: Static<typeof dirInput>) => createDirectoryOp(input)),
		} satisfies AgentTool<typeof dirInput>,
		rename_path: {
			name: "rename_path",
			label: "rename_path",
			description: "Rename or move a file or folder within the workspace. Never overwrites: fails if the destination exists. The result states the exact source and destination.",
			parameters: renameInput,
			executionMode: "sequential",
			execute: serverExecute("rename_path", renameInput, (input: Static<typeof renameInput>) => renamePathOp(input)),
		} satisfies AgentTool<typeof renameInput>,
		delete_file: {
			name: "delete_file",
			label: "delete_file",
			description: "Delete ONE file from the workspace. The learner is shown the file and must click Approve in a dialog before anything is deleted; if they decline or do not answer, the file is kept. Folders are never deleted by agents.",
			parameters: deleteInput,
			executionMode: "sequential",
			execute: approvalExecute<Static<typeof deleteInput>>((input, op) => deleteFileOp(input, op), chatId),
		} satisfies AgentTool<typeof deleteInput>,
	};
	return tools;
}
