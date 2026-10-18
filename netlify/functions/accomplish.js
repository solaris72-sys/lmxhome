import crypto from "node:crypto";
import { getSnapshot, saveSnapshot, listOps, saveOps, newId, applyToSnapshot } from "./lib/store.js";
import { json } from "./lib/http.js";

// The other apps send the shared SUMMARY_TOKEN (the same one LMX Home uses to read their numbers)
function hasAppToken(req) {
  const expected = process.env.SUMMARY_TOKEN || "";
  const given = req.headers.get("x-summary-token") || "";
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

// POST { text, source }: another app logs something Taylor did (e.g. the opportunities app when a job
// is marked Applied). Queued as an Accomplishment for the computer to write into Obsidian, shown now
export default async (req) => {
  if (!hasAppToken(req)) return json({ error: "Unauthorized" }, 401);
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  const text = norm(body?.text).slice(0, 300);
  if (!text) return json({ error: "text is required" }, 400);

  // Already logged (waiting to sync, or already in Obsidian): don't add it twice
  const ops = await listOps();
  const snapshot = await getSnapshot();
  const known = (snapshot?.accomplishments || []).flatMap((d) => d.items.map(norm));
  if (ops.some((o) => o.type === "win" && norm(o.text) === text) || known.includes(text)) return json({ ok: true, duplicate: true });

  const op = { type: "win", roadmap: "woodworking", id: newId(), at: new Date().toISOString(), text, source: norm(body.source).slice(0, 60) };
  await saveOps([...ops, op]);
  if (snapshot) {
    applyToSnapshot(snapshot, op);
    await saveSnapshot(snapshot);
  }
  return json({ ok: true, op });
};
