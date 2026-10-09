import { requireAuth } from "./lib/auth.js";
import { getSnapshot, listOps, listProblems, saveProblems } from "./lib/store.js";
import { json } from "./lib/http.js";

// GET: road maps, recent sessions and sync status. DELETE: clear the sync problems list
export default async (req) => {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;
  if (req.method === "DELETE") {
    await saveProblems([]);
    return json({ ok: true });
  }
  const [snapshot, ops, problems] = await Promise.all([getSnapshot(), listOps(), listProblems()]);
  return json({ snapshot, pending: ops.length, problems });
};
