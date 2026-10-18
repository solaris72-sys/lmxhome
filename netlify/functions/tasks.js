import { requireAuth } from "./lib/auth.js";
import { getSnapshot, saveSnapshot, listOps, saveOps, newId, applyToSnapshot } from "./lib/store.js";
import { json } from "./lib/http.js";

// POST { type: "toggle", roadmap, text, done }, { type: "add", roadmap, group, text },
// { type: "note", roadmap, text, note } (a progress note under a task) or
// { type: "answer", roadmap, text, note } (a reply to one of Claude's questions):
// queues the change for the computer to write into Obsidian, and shows it on the page now
export default async (req) => {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const text = String(body?.text || "").replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text || !body.roadmap) return json({ error: "roadmap and text are required" }, 400);
  let op;
  if (body.type === "toggle") op = { type: "toggle", roadmap: body.roadmap, text, done: Boolean(body.done) };
  else if (body.type === "add" && body.group) op = { type: "add", roadmap: body.roadmap, group: String(body.group), text };
  else if (body.type === "note" || body.type === "answer") {
    const note = String(body.note || "").replace(/\r\n?/g, "\n").trim().slice(0, 4000);
    if (!note) return json({ error: "Write something first" }, 400);
    op = { type: body.type, roadmap: body.roadmap, text, note };
  }
  else return json({ error: "Unknown change" }, 400);
  op.id = newId();
  op.at = new Date().toISOString();

  const ops = await listOps();
  // Ticking and unticking before a sync: keep only the latest state for that task
  const kept = op.type === "toggle" ? ops.filter((o) => !(o.type === "toggle" && o.roadmap === op.roadmap && o.text === op.text)) : ops;
  await saveOps([...kept, op]);
  const snapshot = await getSnapshot();
  if (snapshot) {
    applyToSnapshot(snapshot, op);
    await saveSnapshot(snapshot);
  }
  return json({ ok: true, op });
};
