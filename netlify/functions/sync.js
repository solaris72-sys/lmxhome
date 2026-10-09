import { hasSyncToken } from "./lib/sync-token.js";
import { listOps, saveOps, saveSnapshot, listProblems, saveProblems, getSnapshot, applyToSnapshot } from "./lib/store.js";
import { json } from "./lib/http.js";

// For the sync script on Taylor's computer.
// GET: changes waiting to go into Obsidian. POST { snapshot, applied, failed }: fresh vault snapshot,
// plus which changes were written (or couldn't be)
export default async (req) => {
  if (!hasSyncToken(req)) return json({ error: "Unauthorized" }, 401);

  if (req.method === "GET") return json({ ops: await listOps() });

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid request" }, 400);
    }
    if (!body?.snapshot?.roadmaps) return json({ error: "snapshot is required" }, 400);
    const done = new Set([...(body.applied || []), ...(body.failed || []).map((f) => f.id)]);
    const remaining = (await listOps()).filter((o) => !done.has(o.id));
    await saveOps(remaining);
    // Changes made while the script was running still show until the next sync writes them
    for (const op of remaining) applyToSnapshot(body.snapshot, op);
    await saveSnapshot(body.snapshot);
    if (body.failed?.length) {
      const at = new Date().toISOString();
      await saveProblems([...(await listProblems()), ...body.failed.map((f) => ({ ...f, at }))]);
    }
    return json({ ok: true, pending: remaining.length });
  }

  return new Response("Method not allowed", { status: 405 });
};
