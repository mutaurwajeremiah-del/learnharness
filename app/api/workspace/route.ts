/**
 * GET  /api/workspace — is the configured workspace folder usable right now?
 *   → { root, source: "default"|"custom", state: "ready"|"missing"|"invalid"|"unavailable", message, canCreate }
 * POST /api/workspace {action:"create"} — create the configured folder when
 *   it is missing and acceptable (never touches an existing folder).
 *
 * The folder itself is saved through PUT /api/settings/agent ({workspace:{root}}).
 * Behind proxy.ts like every /api route: only the trusted window reaches it.
 */
import { createWorkspaceFolder, workspaceStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(workspaceStatus(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
	let body: unknown;
	try { body = await request.json(); } catch { return Response.json({ error: "body must be JSON" }, { status: 400 }); }
	if (!body || typeof body !== "object" || (body as { action?: unknown }).action !== "create") {
		return Response.json({ error: "unsupported action; use {\"action\":\"create\"}" }, { status: 400 });
	}
	try {
		return Response.json(createWorkspaceFolder(), { headers: { "Cache-Control": "no-store" } });
	} catch (error) {
		return Response.json({ error: (error as Error).message }, { status: 409 });
	}
}
