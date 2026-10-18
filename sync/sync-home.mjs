// Two-way sync between the Obsidian vault and the LMX Home page.
// 1. Fetches changes made on the home page (tasks checked off or added, notes on tasks, answers to
//    Claude's questions) and writes them into the Road Map files. 2. Fills in the project totals in
//    the Revenue Tracker. 3. Reads the Road Maps, Session Summary and money notes and uploads a fresh
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
const LIVING_FILE = "Personal/Financial/Living Costs and Savings Goals.md";
const OVERHEAD_FILE = "LMX Furniture/Business Plan/Overhead.md";
const REVENUE_FILE = "LMX Furniture/Business Plan/2026 Revenue Tracker.md";
const REVENUE_YEAR = 2026;
const UPDATES_FILE = "Claude Agent/Updates from LMX Home.md";
const PROFILE_FILE = "Claude Agent/User Profile.md";
const SESSIONS_SHOWN = 6;

const TASK = /^- \[( |x|X)\] (.*)$/;
const QUESTION = /^- \*\*Q:\*\*\s*(.*)$/;
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

// Dates are written out in full ("October 17, 2026"); localDate is the day a change was made on the
// page, in Taylor's time zone
const LONG = { month: "long", day: "numeric", year: "numeric" };
const localDate = (iso) => new Date(iso).toLocaleDateString("en-US", { ...LONG, timeZone: "America/Los_Angeles" });
const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", LONG);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// ── Apply home page changes to the files ──

// Matches even if a date in the line was rewritten from 2026-10-17 to October 17, 2026 meanwhile
const spelled = (s) => norm(s).replace(/\b(20\d\d-\d\d-\d\d)\b/g, (iso) => longDate(iso));

function findLine(lines, re, text) {
  return lines.findIndex((l) => {
    const m = re.exec(l);
    return m && spelled(m[m.length - 1]) === spelled(text);
  });
}

// Indented lines under a task or question, so a new note goes after the existing ones
function afterSubLines(lines, i) {
  let at = i + 1;
  while (at < lines.length && /^\s+\S/.test(lines[at])) at++;
  return at;
}

// A note or answer becomes one indented bullet; extra lines continue under it
function subLines(prefix, text) {
  const parts = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return [`  - ${prefix} ${parts[0] || ""}`, ...parts.slice(1).map((l) => `    ${l}`)];
}

function applyOp(lines, op) {
  if (op.type === "toggle") {
    const i = findLine(lines, TASK, op.text);
    if (i === -1) return "Task not found in Obsidian (it may have been edited or removed there)";
    lines[i] = lines[i].replace(/^- \[( |x|X)\]/, op.done ? "- [x]" : "- [ ]");
    return null;
  }
  if (op.type === "add") {
    const h = findLine(lines, HEADING, op.group);
    if (h === -1) return `Heading "${op.group}" not found in Obsidian`;
    // After the group's last task (and its indented notes), before the next heading
    let at = h + 1;
    for (let i = h + 1; i < lines.length && !HEADING.test(lines[i]); i++) {
      if (TASK.test(lines[i]) || (/^\s+\S/.test(lines[i]) && at === i)) at = i + 1;
    }
    lines.splice(at, 0, `- [ ] ${op.text.trim()}`);
    return null;
  }
  if (op.type === "note") {
    const i = findLine(lines, TASK, op.text);
    if (i === -1) return "Task not found in Obsidian (it may have been edited or removed there)";
    lines.splice(afterSubLines(lines, i), 0, ...subLines(`${localDate(op.at)}:`, op.note));
    return null;
  }
  if (op.type === "answer") {
    const i = findLine(lines, QUESTION, op.text);
    if (i === -1) return "Question not found in Obsidian (Claude may have filed or removed it)";
    lines.splice(afterSubLines(lines, i), 0, ...subLines(`**A (${localDate(op.at)}):**`, op.note));
    return null;
  }
  // The next three come from Claude, after Taylor tells it what's been done on LMX Home
  if (op.type === "remove") {
    const i = findLine(lines, TASK, op.text);
    if (i === -1) return "Task not found in Obsidian (it may have been edited or removed there)";
    lines.splice(i, afterSubLines(lines, i) - i);
    return null;
  }
  if (op.type === "rename") {
    const i = findLine(lines, TASK, op.text);
    if (i === -1) return "Task not found in Obsidian (it may have been edited or removed there)";
    lines[i] = lines[i].replace(TASK, (all, box) => `- [${box}] ${op.to.trim()}`);
    return null;
  }
  if (op.type === "question") {
    const h = findLine(lines, HEADING, "Questions from Claude");
    if (h === -1) return 'Heading "Questions from Claude" not found in Obsidian';
    let at = h + 1;
    for (let i = h + 1; i < lines.length && !HEADING.test(lines[i]); i++) if (lines[i].trim()) at = i + 1;
    lines.splice(at, 0, `- **Q:** ${op.text.trim()}`);
    return null;
  }
  return `Unknown change type: ${op.type}`;
}

// What Taylor told Claude on LMX Home and what Claude changed, newest first, so later sessions see it
async function writeUpdates(logs) {
  const file = path.join(vault, UPDATES_FILE);
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    text = "# Updates from LMX Home\n\nWhat Taylor told Claude in the box at the top of LMX Home, and what Claude changed in the Road Map. Newest first.\n";
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const entries = logs.map((op) => [
    `## ${localDate(op.at)}`,
    "",
    `**Taylor:** ${op.text.replace(/\r?\n+/g, " ")}`,
    "",
    `**Claude:** ${String(op.reply || "").replace(/\r?\n+/g, " ")}`,
    ...(op.changes?.length ? ["", ...op.changes.map((c) => `- ${c}`)] : []),
    "",
  ].join(eol)).reverse();
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => /^## /.test(l));
  const head = (first === -1 ? lines : lines.slice(0, first)).join(eol).replace(/\s*$/, eol + eol);
  const rest = first === -1 ? "" : lines.slice(first).join(eol);
  await writeFile(file, head + entries.join(eol) + rest, "utf8");
}

async function applyOps(ops) {
  const applied = [];
  const failed = [];
  const logs = ops.filter((o) => o.type === "log");
  if (logs.length) {
    await writeUpdates(logs);
    applied.push(...logs.map((o) => o.id));
  }
  ops = ops.filter((o) => o.type !== "log");
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

// Sections at the top of a road map that get their own card on the page instead of the to-do list
function areaOf(h1) {
  if (/^Direction/i.test(h1)) return "direction";
  if (/^Next Session Agenda/i.test(h1)) return "agenda";
  return "";
}

function parseRoadmap(rm, lines) {
  const groups = [];
  const questions = [];
  let direction = null;
  let agenda = null;
  let h1 = "";
  let h2 = "";
  let group = null;
  let lastTask = null;
  let lastQuestion = null;
  let doneInCompleted = 0;
  const top = []; // Direction and agenda as written, for Claude when Taylor sends an update
  for (const line of lines) {
    const h = HEADING.exec(line);
    if (areaOf(h && h[1].length === 1 ? h[2].trim() : h1)) top.push(line);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      if (level === 1) { h1 = text; h2 = ""; }
      if (level === 2) h2 = text;
      group = { heading: text, level, parent: level === 3 ? h2 : level === 2 ? h1 : "", area: areaOf(h1), tasks: [] };
      lastTask = null;
      lastQuestion = null;
      if (!/^completed$/i.test(h2) && !/^completed$/i.test(text)) groups.push(group);
      if (level === 1 && areaOf(text) === "agenda") agenda = { title: text, lines: [] };
      if (level === 1 && areaOf(text) === "direction") direction = { title: text, focus: "", goals: [] };
      continue;
    }
    const area = areaOf(h1);
    const t = TASK.exec(line);
    if (t) {
      const done = t[1] !== " ";
      lastQuestion = null;
      if (/^completed$/i.test(h2)) { if (done) doneInCompleted++; continue; }
      lastTask = { key: key(rm.id, t[2]), text: t[2].trim(), done, sub: [] };
      if (group) group.tasks.push(lastTask);
      continue;
    }
    const q = /^Questions from Claude/i.test(h2) ? QUESTION.exec(line) : null;
    if (q) {
      lastTask = null;
      lastQuestion = { key: key(rm.id, `Q ${q[1]}`), text: q[1].trim(), area, answers: [], sub: [] };
      questions.push(lastQuestion);
      continue;
    }
    if (/^\s+\S/.test(line) && (lastTask || lastQuestion)) {
      const s = line.trim().replace(/^- (\[( |x|X)\] )?/, "");
      if (lastTask) lastTask.sub.push(s);
      else if (/^\*\*A\b/.test(s)) lastQuestion.answers.push(s.replace(/^\*\*A[^*]*\*\*\s*/, ""));
      else if (lastQuestion.answers.length && /^\s{4,}\S/.test(line)) lastQuestion.answers[lastQuestion.answers.length - 1] += "\n" + s;
      else lastQuestion.sub.push(s);
      continue;
    }
    if (line.trim()) { lastTask = null; lastQuestion = null; }
    if (agenda && area === "agenda" && !h2) agenda.lines.push(line);
    if (direction && area === "direction") {
      const f = /^\*\*Main focus:\*\*\s*(.*)$/i.exec(line.trim());
      if (f) direction.focus = f[1];
      else if (/^Goals/i.test(h2) && /^- /.test(line)) direction.goals.push(line.slice(2).trim());
    }
  }
  return {
    id: rm.id,
    name: rm.name,
    direction,
    agenda: agenda ? { title: agenda.title, text: agenda.lines.join("\n").trim() } : null,
    questions,
    top: top.join("\n").trim(),
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

// ── Money: what it costs per month, and what came in ──

const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isTableRow = (line) => /^\s*\|/.test(line);
const isDivider = (line) => /^\s*\|?\s*:?-{2,}/.test(line);

// Each markdown table with its header, rows (line numbers kept for writing back) and the heading above it
function tables(lines) {
  const out = [];
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]);
    if (h) { heading = h[2].trim(); continue; }
    if (!isTableRow(lines[i]) || !lines[i + 1] || !isDivider(lines[i + 1])) continue;
    const t = { heading, header: cells(lines[i]).map((c) => c.toLowerCase()), rows: [] };
    for (i += 2; i < lines.length && isTableRow(lines[i]); i++) t.rows.push({ line: i, cells: cells(lines[i]) });
    i--;
    out.push(t);
  }
  return out;
}

function num(s) {
  const n = parseFloat(String(s || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

const round = (n) => Math.round(n * 100) / 100;
// Bold first cells are totals rows, blank ones are spare rows
const isItem = (row) => row.cells[0] && !/^\*\*/.test(row.cells[0]);

function sumColumn(t, col) {
  const i = t.header.indexOf(col);
  return i === -1 ? 0 : t.rows.filter(isItem).reduce((n, r) => n + (num(r.cells[i]) || 0), 0);
}

async function personalCosts() {
  const parts = [];
  for (const t of tables((await readLines(LIVING_FILE)).lines)) {
    if (t.header.includes("minimum payment")) parts.push({ name: "Debt payments", monthly: sumColumn(t, "minimum payment") });
    else if (t.header.includes("monthly needed")) parts.push({ name: "Savings", monthly: sumColumn(t, "monthly needed") });
    else if (t.header.includes("monthly")) parts.push({ name: "Living costs", monthly: sumColumn(t, "monthly") });
  }
  return { total: round(parts.reduce((n, p) => n + p.monthly, 0)), parts: parts.map((p) => ({ ...p, monthly: round(p.monthly) })) };
}

// Yearly bills count as a twelfth a month when Monthly is blank
async function businessCosts() {
  const parts = [];
  for (const t of tables((await readLines(OVERHEAD_FILE)).lines)) {
    const m = t.header.indexOf("monthly");
    const y = t.header.indexOf("yearly");
    if (m === -1) continue;
    const monthly = t.rows.filter(isItem).reduce((n, r) => {
      const mo = num(r.cells[m]);
      return n + (mo != null ? mo : y !== -1 && num(r.cells[y]) != null ? num(r.cells[y]) / 12 : 0);
    }, 0);
    if (monthly) parts.push({ name: t.heading, monthly: round(monthly) });
  }
  return { total: round(parts.reduce((n, p) => n + p.monthly, 0)), parts };
}

// "January 12, 2026", "Jan 12", "2026-01-12", "1/12" or "01-12" (no year means the tracker's year)
function isoDate(s) {
  s = String(s || "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i.exec(s);
  if (m && MONTHS.includes(m[1].toLowerCase())) {
    const mo = String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0");
    return `${m[3] || REVENUE_YEAR}-${mo}-${m[2].padStart(2, "0")}`;
  }
  m = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?$/.exec(s);
  if (!m) return null;
  const y = m[3] ? (m[3].length === 2 ? "20" + m[3] : m[3]) : String(REVENUE_YEAR);
  return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

const money = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The projects table: one row per project, a deposit and up to three more payments, each with a date
function readProjects(lines) {
  const t = tables(lines).find((x) => x.header.includes("deposit"));
  if (!t) return null;
  const col = (re) => t.header.findIndex((h) => re.test(h));
  const pays = [];
  t.header.forEach((h, i) => {
    if (/^(deposit|payment \d)$/.test(h)) pays.push({ amount: i, date: /date/.test(t.header[i + 1] || "") ? i + 1 : -1 });
  });
  const c = { project: col(/^project/), client: col(/^client/), stream: col(/^stream/), tax: col(/tax/), total: col(/^total/), status: col(/^status/) };
  const projects = t.rows.filter(isItem).map((r) => {
    const get = (i) => (i === -1 ? "" : r.cells[i] || "");
    const payments = pays
      .map((p) => ({ amount: num(get(p.amount)), date: isoDate(get(p.date)) }))
      .filter((p) => p.amount);
    return {
      row: r,
      name: get(c.project),
      client: get(c.client),
      stream: get(c.stream) || "Other",
      status: get(c.status),
      tax: num(get(c.tax)) || 0,
      payments,
      total: round(payments.reduce((n, p) => n + p.amount, 0)),
    };
  });
  return { table: t, cols: c, pays, projects };
}

// Keeps each project's Total cell and the Totals table in the Revenue Tracker up to date, and writes
// payment dates out in full however they were typed
async function fillRevenueTotals() {
  const { lines, eol } = await readLines(REVENUE_FILE);
  const read = readProjects(lines);
  if (!read) return;
  const before = lines.join("\n");
  const { cols, pays, projects } = read;
  for (const p of projects) {
    const next = [...p.row.cells];
    if (cols.total !== -1 && num(next[cols.total]) !== (p.total || null)) next[cols.total] = p.total ? money(p.total) : "";
    for (const pay of pays) {
      const iso = pay.date === -1 ? null : isoDate(next[pay.date]);
      if (iso) next[pay.date] = longDate(iso);
    }
    if (next.join("|") !== p.row.cells.join("|")) lines[p.row.line] = `| ${next.join(" | ")} |`;
  }
  const totals = tables(lines).find((x) => x.header[0] === "stream" && x.header.includes("total"));
  if (totals) {
    const by = {};
    for (const p of projects) by[p.stream] = (by[p.stream] || 0) + p.total;
    const tax = projects.reduce((n, p) => n + p.tax, 0);
    const rows = Object.keys(by).sort((a, b) => by[b] - by[a]).map((s) => `| ${s} | $${money(by[s])} |`);
    rows.push(`| **Total** | **$${money(Object.values(by).reduce((n, v) => n + v, 0))}** |`);
    if (tax) rows.push(`| Sales tax collected (not counted above) | $${money(tax)} |`);
    const first = totals.rows.length ? totals.rows[0].line : null;
    if (first != null) lines.splice(first, totals.rows.length, ...rows);
  }
  if (lines.join("\n") !== before) await writeFile(path.join(vault, REVENUE_FILE), lines.join(eol), "utf8");
}

async function income() {
  const read = readProjects((await readLines(REVENUE_FILE)).lines);
  if (!read) return null;
  const byMonth = {};
  const byStream = {};
  let last = "";
  let undated = 0;
  for (const p of read.projects) {
    byStream[p.stream] = round((byStream[p.stream] || 0) + p.total);
    for (const pay of p.payments) {
      if (!pay.date) { undated += pay.amount; continue; }
      const m = pay.date.slice(0, 7);
      byMonth[m] = round((byMonth[m] || 0) + pay.amount);
      if (pay.date > last) last = pay.date;
    }
  }
  return {
    year: REVENUE_YEAR,
    total: round(Object.values(byStream).reduce((n, v) => n + v, 0)),
    tax: round(read.projects.reduce((n, p) => n + p.tax, 0)),
    byMonth,
    byStream,
    lastPayment: last || null,
    undated: round(undated),
    open: read.projects
      .filter((p) => p.status && !/^(done|paid|closed)/i.test(p.status))
      .map((p) => ({ name: p.name, client: p.client, status: p.status, paid: p.total })),
  };
}

// A missing or renamed note just leaves that part of the money card blank
async function maybe(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function snapshot() {
  const roadmaps = [];
  for (const rm of ROADMAPS) roadmaps.push(parseRoadmap(rm, (await readLines(rm.file)).lines));
  const sessions = parseSessions((await readLines(SESSION_FILE)).lines);
  const money = { personal: await maybe(personalCosts), business: await maybe(businessCosts), income: await maybe(income) };
  const profile = await maybe(async () => (await readLines(PROFILE_FILE)).lines.join("\n").slice(0, 6000));
  return { syncedAt: new Date().toISOString(), roadmaps, sessions, money, profile };
}

// --dry: print what would be uploaded, touch nothing
if (process.argv.includes("--dry")) {
  console.log(JSON.stringify(await snapshot(), null, 2));
  process.exit(0);
}

try {
  const { ops } = await api("GET");
  const result = ops.length ? await applyOps(ops) : { applied: [], failed: [] };
  await maybe(fillRevenueTotals);
  await api("POST", { snapshot: await snapshot(), applied: result.applied, failed: result.failed });
  if (ops.length) await log(`applied ${result.applied.length}, failed ${result.failed.length}`);
} catch (err) {
  await log(`error: ${err.message}`);
  process.exitCode = 1;
}
