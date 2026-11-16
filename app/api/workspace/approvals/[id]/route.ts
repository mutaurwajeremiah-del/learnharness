/**
 * POST /api/workspace/approvals/[id] {decision:"approve"|"deny"} — the
 * learner's answer. It resolves the blocked agent tool call; 404 when the
 * request no longer exists (answered, expired, or its run was cancelled).
 */
import { decideWorkspaceApproval } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
	const { id } = await ctx.params;
	let body: unknown;
	try { body = await request.json(); } catch { return Response.json({ error: "body must be JSON" }, { status: 400 }); }
	const decision = (body as { decision?: unknown } | null)?.decision;
	if (decision !== "approve" && decision !== "deny") {
		return Response.json({ error: "decision must be \"approve\" or \"deny\"" }, { status: 400 });
	}
	if (!decideWorkspaceApproval(id, decision === "approve")) {
		return Response.json({ error: "this request is no longer pending" }, { status: 404 });
	}
	return Response.json({ ok: true });
}
