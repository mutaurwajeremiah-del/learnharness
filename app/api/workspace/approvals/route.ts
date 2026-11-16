/**
 * GET /api/workspace/approvals — destructive workspace operations (delete a
 * file, overwrite a file) currently waiting for the learner's decision,
 * oldest first. The window refetches on the "workspace-approvals-changed"
 * event and on (re)connect.
 */
import { listWorkspaceApprovals } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json({ approvals: listWorkspaceApprovals() }, { headers: { "Cache-Control": "no-store" } });
}
