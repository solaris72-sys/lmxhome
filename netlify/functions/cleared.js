import { requireAuth } from "./lib/auth.js";
import { listCleared, saveCleared } from "./lib/store.js";
import { json } from "./lib/http.js";

// POST { key, text }: clear a Coming up item. DELETE { key }: bring it back
export default async (req) => {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;
  if (req.method !== "POST" && req.method !== "DELETE") return new Response("Method not allowed", { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const key = String(body?.key || "").slice(0, 600);
  if (!key) return json({ error: "key is required" }, 400);

  const kept = (await listCleared()).filter((c) => c.key !== key);
  if (req.method === "POST") kept.push({ key, text: String(body.text || "").slice(0, 300), at: new Date().toISOString() });
  await saveCleared(kept);
  return json({ ok: true, cleared: kept });
};
