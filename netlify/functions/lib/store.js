import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const SNAPSHOT_KEY = "snapshot.json";
const OPS_KEY = "ops.json";
const PROBLEMS_KEY = "problems.json";

// Strong consistency so a change is readable the moment it's saved
function store() {
  return getStore({ name: "home", consistency: "strong" });
}

async function read(key, fallback) {
  return (await store().get(key, { type: "json" })) ?? fallback;
}

// What the computer last uploaded from Obsidian
export const getSnapshot = () => read(SNAPSHOT_KEY, null);
export const saveSnapshot = (s) => store().setJSON(SNAPSHOT_KEY, s);

// Changes made on the page, waiting for the computer to write them into Obsidian
export const listOps = () => read(OPS_KEY, []);
export const saveOps = (ops) => store().setJSON(OPS_KEY, ops);

// Changes the computer couldn't apply (e.g. the task was edited in Obsidian meanwhile)
export const listProblems = () => read(PROBLEMS_KEY, []);
export const saveProblems = (p) => store().setJSON(PROBLEMS_KEY, p.slice(-20));

export function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

const norm = (s) => s.replace(/\s+/g, " ").trim();

// Shows a queued change on the page right away, before the computer has synced it
export function applyToSnapshot(snapshot, op) {
  const rm = snapshot?.roadmaps?.find((r) => r.id === op.roadmap);
  if (!rm) return;
  if (op.type === "toggle") {
    for (const g of rm.groups) for (const t of g.tasks) if (norm(t.text) === op.text) t.done = op.done;
  }
  if (op.type === "add") {
    const g = rm.groups.find((x) => x.heading === op.group);
    if (g) g.tasks.push({ key: `pending-${op.id}`, text: op.text, done: false, sub: [] });
  }
}
