import { isAuthenticated } from "./lib/auth.js";
import { getSnapshot, saveSnapshot, listOps, saveOps, newId, applyToSnapshot, setJob } from "./lib/store.js";
import { planUpdate } from "./lib/claude.js";

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const dollars = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");

function moneyText(m) {
  if (!m) return "";
  const out = [];
  if (m.personal) out.push(`To live: ${dollars(m.personal.total)}`);
  if (m.business) out.push(`To run the shop: ${dollars(m.business.total)}`);
  if (m.income?.byMonth) out.push(`Income by month: ${Object.entries(m.income.byMonth).map(([k, v]) => `${k} ${dollars(v)}`).join(", ")}`);
  return out.join("\n");
}

// Background function: Claude can take a minute. The page sends what Taylor typed ("Tell Claude")
// and polls update-result. Claude's changes are queued like changes made by hand on the page, and
// the update itself is logged to "Updates from LMX Home" in Obsidian.
export default async (req) => {
  if (!isAuthenticated(req)) return;
  let body;
  try {
    body = await req.json();
  } catch {
    return;
  }
  const jobId = String(body?.jobId || "").replace(/[^a-z0-9]/gi, "").slice(0, 40);
  const update = String(body?.text || "").replace(/\r\n?/g, "\n").trim().slice(0, 6000);
  if (!jobId || !update) return;
  try {
    const snapshot = await getSnapshot();
    const rm = snapshot?.roadmaps?.find((r) => r.direction);
    if (!rm) throw new Error("No Direction section in the Road Map yet");
    const today = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" });
    const wins = (snapshot.accomplishments || []).map((d) => `${d.date}\n${d.items.map((i) => `- ${i}`).join("\n")}`).join("\n");
    // Claude may change tasks at the top of the page and under the goals, not upkeep or the archive
    const top = rm.groups.filter((g) => g.area === "direction" || g.area === "agenda");
    const goalGroups = rm.groups.filter((g) => !g.area && !/^(Before Next Session|Archive)/i.test(g.section || ""));
    const groups = [...top, ...goalGroups];
    const known = new Set(groups.flatMap((g) => g.tasks.map((t) => norm(t.text))));
    const priorities = top.find((g) => g.area === "direction" && /top priorit|next steps/i.test(g.heading))?.heading || "Top priorities";
    const headings = new Map([[norm(priorities).toLowerCase(), priorities], ...goalGroups.map((g) => [norm(g.heading).toLowerCase(), g.heading])]);
    // "" or an unknown heading puts a new task in Top priorities
    const headingFor = (group) => headings.get(norm(group).toLowerCase()) || null;
    const goals = goalGroups
      .map((g) => {
        const open = g.tasks.filter((t) => !t.done).map((t) => `- [ ] ${t.text}`);
        return `### ${g.heading}${g.goal && g.goal !== g.heading ? ` (goal: ${g.goal})` : ""}\n${open.join("\n") || "(no open tasks)"}`;
      })
      .join("\n\n");
    const plan = await planUpdate({ update, top: rm.top || "", goals, money: moneyText(snapshot.money), profile: snapshot.profile, wins, today });
    const renamed = {};
    const at = new Date().toISOString();
    const ops = [];
    const done = [];
    const skipped = [];
    for (const c of plan.changes || []) {
      const task = renamed[norm(c.task)] || norm(c.task);
      const text = norm(c.text).slice(0, 500);
      const needsTask = ["done", "remove", "rename", "note"].includes(c.action);
      if (needsTask && !known.has(task)) { skipped.push(`${c.action}: ${c.task}`); continue; }
      let op = null;
      if (c.action === "done") { op = { type: "toggle", text: task, done: true }; done.push(`Done: ${task}`); }
      if (c.action === "remove") { op = { type: "remove", text: task }; known.delete(task); done.push(`Removed: ${task}`); }
      if (c.action === "rename" && text) {
        op = { type: "rename", text: task, to: text };
        known.delete(task);
        known.add(text);
        renamed[task] = text;
        done.push(`Reworded: ${task} → ${text}`);
      }
      // The sync dates every note itself
      const note = text.replace(/^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}:\s*/, "");
      if (c.action === "note" && note) { op = { type: "note", text: task, note }; done.push(`Note on ${task}: ${note}`); }
      if (c.action === "add" && text) {
        const group = headingFor(c.group) || priorities;
        op = { type: "add", group, text };
        known.add(text);
        done.push(`Added to ${group}: ${text}`);
      }
      if (c.action === "move") {
        const group = headingFor(c.group);
        if (!group) { skipped.push(`move: ${c.task} (no heading "${c.group}")`); continue; }
        op = { type: "move", text: task, group };
        done.push(`Moved to ${group}: ${task}`);
      }
      if (c.action === "question" && text) { op = { type: "question", text }; done.push(`Asked: ${text}`); }
      if (op) ops.push({ ...op, roadmap: rm.id, id: newId(), at });
    }
    const accomplished = (plan.accomplishments || []).map(norm).filter(Boolean).slice(0, 20);
    for (const text of accomplished) ops.push({ type: "win", roadmap: rm.id, id: newId(), at, text: text.slice(0, 300) });
    ops.push({ type: "log", roadmap: rm.id, id: newId(), at, text: update, reply: plan.reply, changes: [...accomplished.map((a) => `Accomplished: ${a}`), ...done] });

    await saveOps([...(await listOps()), ...ops]);
    const fresh = await getSnapshot();
    if (fresh) {
      for (const op of ops) applyToSnapshot(fresh, op);
      await saveSnapshot(fresh);
    }
    await setJob(jobId, { done: true, reply: plan.reply, accomplishments: accomplished, changes: done, skipped });
  } catch (err) {
    await setJob(jobId, { done: true, error: err.message || String(err) });
  }
};
