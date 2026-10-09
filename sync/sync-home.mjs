// Two-way sync between the Obsidian vault and the LMX Home page.
// 1. Fetches changes made on the home page (tasks checked off or added) and writes them into the
//    Road Map files. 2. Reads the Road Maps, Session Summary and Business Plan and uploads a fresh
//    snapshot. Run every few minutes by the "LMX Home Sync" scheduled task (install-sync-task.ps1).
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(here, "sync-config.json"), "utf8"));
const vault = config.vault;

const ROADMAPS = [
  { id: "woodworking", name: "Woodworking", file: "Claude Agent/Road Map.md" },
  { id: "scion", name: "Scion Forestry", file: "Scion Forestry Services/Road Map.md" },
];
const SESSION_FILE = "Claude Agent/Session Summary.md";
const PLAN_FILE = "LMX Furniture/Business Plan/Business Plan.md";
const SESSIONS_SHOWN = 6;

const TASK = /^- \[( |x|X)\] (.*)$/;
const norm = (s) => s.replace(/\s+/g, " ").trim();
const HEADING = /^(#{1,4}) (.*)$/;

async function log(line) {
  const file = path.join(here, "sync.log");
  await appendFile(file, `${new Date().toISOString()} ${line}\n`);
  const text = await readFile(file, "utf8");
  const lines = text.split("\n");
  if (lines.length > 400) await writeFile(file, lines.slice(-200).join("\n"));
}

function api(method, body) {
  return fetch(`${config.url}/api/sync`, {
    method,
    headers: { "x-sync-token": config.token, ...(body && { "content-type": "application/json" }) },
    body: body && JSON.stringify(body),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`${method} /api/sync: ${res.status} ${await res.text()}`);
    return res.json();
  });
}

async function readLines(file) {
  const text = await readFile(path.join(vault, file), "utf8");
  return { lines: text.split(/\r?\n/), eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

function key(roadmapId, text) {
  return createHash("sha1").update(`${roadmapId}|${text.trim()}`).digest("hex").slice(0, 12);
}

// ── Apply home page changes to the files ──

function applyOp(lines, op) {
  if (op.type === "toggle") {
    const i = lines.findIndex((l) => {
      const m = TASK.exec(l);
      return m && norm(m[2]) === norm(op.text);
    });
    if (i === -1) return "Task not found in Obsidian (it may have been edited or removed there)";
    lines[i] = lines[i].replace(/^- \[( |x|X)\]/, op.done ? "- [x]" : "- [ ]");
    return null;
  }
  if (op.type === "add") {
    const h = lines.findIndex((l) => {
      const m = HEADING.exec(l);
      return m && norm(m[2]) === norm(op.group);
    });
    if (h === -1) return `Heading "${op.group}" not found in Obsidian`;
    // After the group's last task (and its indented notes), before the next heading
    let at = h + 1;
    for (let i = h + 1; i < lines.length && !HEADING.test(lines[i]); i++) {
      if (TASK.test(lines[i]) || (/^\s+\S/.test(lines[i]) && at === i)) at = i + 1;
    }
    lines.splice(at, 0, `- [ ] ${op.text.trim()}`);
    return null;
  }
  return `Unknown change type: ${op.type}`;
}

async function applyOps(ops) {
  const applied = [];
  const failed = [];
  for (const rm of ROADMAPS) {
    const mine = ops.filter((o) => o.roadmap === rm.id);
    if (!mine.length) continue;
    const { lines, eol } = await readLines(rm.file);
    for (const op of mine) {
      const problem = applyOp(lines, op);
      if (problem) failed.push({ id: op.id, reason: problem, op });
      else applied.push(op.id);
    }
    await writeFile(path.join(vault, rm.file), lines.join(eol), "utf8");
  }
  for (const op of ops) {
    if (!ROADMAPS.some((r) => r.id === op.roadmap)) failed.push({ id: op.id, reason: "Unknown road map", op });
  }
  return { applied, failed };
}

// ── Read the vault into a snapshot ──

function parseRoadmap(rm, lines) {
  const groups = [];
  let agenda = null;
  let h1 = "";
  let h2 = "";
  let group = null;
  let lastTask = null;
  let doneInCompleted = 0;
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      if (level === 1) { h1 = text; h2 = ""; }
      if (level === 2) h2 = text;
      group = { heading: text, level, parent: level === 3 ? h2 : level === 2 ? h1 : "", tasks: [] };
      lastTask = null;
      if (!/^completed$/i.test(h2) && !/^completed$/i.test(text)) groups.push(group);
      if (/^Next Session Agenda/i.test(text)) agenda = { title: text, lines: [] };
      continue;
    }
    if (agenda && /^Next Session Agenda/i.test(h1) && !h2) agenda.lines.push(line);
    const t = TASK.exec(line);
    if (t) {
      const done = t[1] !== " ";
      if (/^completed$/i.test(h2)) { if (done) doneInCompleted++; continue; }
      lastTask = { key: key(rm.id, t[2]), text: t[2].trim(), done, sub: [] };
      if (group) group.tasks.push(lastTask);
      continue;
    }
    if (lastTask && /^\s+\S/.test(line)) lastTask.sub.push(line.trim().replace(/^- (\[( |x|X)\] )?/, ""));
    else if (line.trim()) lastTask = null;
  }
  return {
    id: rm.id,
    name: rm.name,
    agenda: agenda ? { title: agenda.title, text: agenda.lines.join("\n").trim() } : null,
    groups: groups.filter((g) => g.tasks.length),
    completedCount: doneInCompleted,
  };
}

function parseSessions(lines) {
  const sessions = [];
  let cur = null;
  let sub = null;
  for (const line of lines) {
    if (/^## /.test(line)) {
      cur = { title: line.slice(3).trim(), items: [], wrap: "" };
      sessions.push(cur);
      sub = null;
      continue;
    }
    if (!cur) continue;
    if (/^### /.test(line)) {
      sub = line.slice(4).trim();
      if (!/wrap-up/i.test(sub)) cur.items.push(sub);
      continue;
    }
    if (sub && /wrap-up/i.test(sub) && !cur.wrap && line.trim() && !/^\*\*/.test(line)) cur.wrap = line.trim();
  }
  return sessions.filter((s) => /^Session/i.test(s.title)).slice(0, SESSIONS_SHOWN);
}

async function snapshot() {
  const roadmaps = [];
  for (const rm of ROADMAPS) roadmaps.push(parseRoadmap(rm, (await readLines(rm.file)).lines));
  const sessions = parseSessions((await readLines(SESSION_FILE)).lines);
  let focus = "";
  try {
    const plan = (await readLines(PLAN_FILE)).lines.find((l) => l.startsWith("**Active Focus:**"));
    focus = plan ? plan.replace("**Active Focus:**", "").trim() : "";
  } catch {
    // Business Plan moved or renamed; the page just won't show a focus line
  }
  return { syncedAt: new Date().toISOString(), focus, roadmaps, sessions };
}

// --dry: print what would be uploaded, touch nothing
if (process.argv.includes("--dry")) {
  console.log(JSON.stringify(await snapshot(), null, 2));
  process.exit(0);
}

try {
  const { ops } = await api("GET");
  const result = ops.length ? await applyOps(ops) : { applied: [], failed: [] };
  await api("POST", { snapshot: await snapshot(), applied: result.applied, failed: result.failed });
  if (ops.length) await log(`applied ${result.applied.length}, failed ${result.failed.length}`);
} catch (err) {
  await log(`error: ${err.message}`);
  process.exitCode = 1;
}
