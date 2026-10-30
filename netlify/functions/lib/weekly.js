import { upcomingEvents, sortKey } from "./calendar.js";
import { getSnapshot } from "./store.js";

// The Sunday evening email: the week ahead on the calendar, application dates, tax and filing
// dates a month out, and this week's Next steps from the road maps
const WEEK_DAYS = 7;
const TAX_DAYS = 30;
const OPP_DAYS = 14;
const SITE = "https://lmxhome.netlify.app";
const TAXY = /\b(tax|taxes|cdtfa|irs|ftb|franchise tax|1040|540|1120|sales tax)\b/i;

const C = { ink: "#3D2009", muted: "#7B4F2E", accent: "#A0673A", red: "#A3321F" };

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

const laDate = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
const dayOf = (e) => e.start.date || laDate(new Date(e.start.at));
const longDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const timeOf = (e) => (e.allDay ? "" : new Date(e.start.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }).replace(":00", ""));
const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

function daysAway(today, iso) {
  const n = Math.round((Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 864e5);
  return n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
}

function section(title, rows) {
  if (!rows.length) return { html: "", text: "" };
  return {
    html: `<h3 style="font-weight:normal;color:${C.ink};margin:26px 0 8px;font-size:19px">${escapeHtml(title)}</h3>` +
      rows.map((r) => `<div style="margin:0 0 8px;color:${C.ink};font-size:15px">${r.html}</div>`).join(""),
    text: [title.toUpperCase(), ...rows.map((r) => `- ${r.text}`), ""].join("\n"),
  };
}

export async function buildWeekly() {
  const today = laDate(new Date());
  const weekEnd = addDays(today, WEEK_DAYS - 1);
  const [cal, snapshot] = await Promise.all([upcomingEvents(TAX_DAYS), getSnapshot()]);
  const ahead = cal.events.filter((e) => dayOf(e) >= today);

  // Taxes and filings a month out, so there's time to get the numbers together
  const taxes = ahead.filter((e) => e.calendar !== "Opportunities" && TAXY.test(e.title));
  const taxRows = taxes.map((e) => ({
    html: `<strong>${escapeHtml(e.title)}</strong> <span style="color:${C.red}">${escapeHtml(longDay(dayOf(e)))}, ${daysAway(today, dayOf(e))}</span>`,
    text: `${e.title}: ${longDay(dayOf(e))}, ${daysAway(today, dayOf(e))}`,
  }));

  // Applications opening or closing in the next two weeks
  const opps = ahead.filter((e) => e.calendar === "Opportunities" && dayOf(e) <= addDays(today, OPP_DAYS - 1));
  const oppRows = opps.map((e) => ({
    html: `<a href="${escapeHtml(e.url || "https://lmxopportunities.netlify.app")}" style="color:${C.ink}">${escapeHtml(e.title)}</a>` +
      ` <span style="color:${e.kind === "deadline" ? C.red : C.accent}">${escapeHtml(longDay(dayOf(e)))}, ${daysAway(today, dayOf(e))}</span>` +
      (e.tab ? ` <span style="color:${C.muted};font-size:13px">${escapeHtml(e.tab)}</span>` : ""),
    text: `${e.title}: ${longDay(dayOf(e))}, ${daysAway(today, dayOf(e))}${e.url ? ` ${e.url}` : ""}`,
  }));

  // Everything else on the calendar this week, by day
  const shown = new Set([...taxes, ...opps]);
  const week = ahead.filter((e) => !shown.has(e) && dayOf(e) <= weekEnd).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const weekRows = week.map((e) => {
    const when = `${longDay(dayOf(e))}${timeOf(e) ? `, ${timeOf(e)}` : ""}`;
    return {
      html: `<span style="color:${C.muted}">${escapeHtml(when)}</span> ${escapeHtml(e.title)}${e.location ? ` <span style="color:${C.muted}">· ${escapeHtml(e.location)}</span>` : ""}`,
      text: `${when}: ${e.title}${e.location ? ` (${e.location})` : ""}`,
    };
  });

  // This week's picks from each road map, and how many of Claude's questions are waiting
  const roadmaps = snapshot?.roadmaps || [];
  const steps = roadmaps.flatMap((rm) => rm.groups.filter((g) => g.heading === "Next steps").flatMap((g) => g.tasks.filter((t) => !t.done).map((t) => ({ rm, t }))));
  const stepRows = steps.map(({ rm, t }) => ({
    html: `☐ ${escapeHtml(t.text)}${roadmaps.length > 1 ? ` <span style="color:${C.muted};font-size:13px">${escapeHtml(rm.name)}</span>` : ""}`,
    text: t.text,
  }));
  const questions = roadmaps.reduce((n, rm) => n + (rm.questions || []).filter((q) => !q.answers?.length).length, 0);

  const parts = [
    section(`Taxes and filings (next ${TAX_DAYS} days)`, taxRows),
    section("Applications opening or closing", oppRows),
    section("This week on the calendar", weekRows),
    section("Next steps", stepRows),
  ];
  const problems = cal.errors.length ? `<p style="color:${C.red};font-size:13px">Couldn't read part of the calendar: ${escapeHtml(cal.errors.join(" "))}</p>` : "";
  const notSetUp = cal.configured ? "" : `<p style="color:${C.muted};font-size:13px">Your Google Calendar isn't connected to LMX Home yet, so only Opportunities dates are here.</p>`;
  const extra = questions ? `<p style="color:${C.ink};font-size:15px;margin-top:22px">Claude has ${questions} question${questions > 1 ? "s" : ""} waiting for you on LMX Home.</p>` : "";

  const first = taxes[0] || opps.find((e) => e.kind === "deadline");
  const subject = `Your week ahead (${longDay(addDays(today, 1)).replace(/^\w+, /, "")})` + (first ? `: ${first.title} ${daysAway(today, dayOf(first))}` : "");
  const html =
    `<div style="font-family:Georgia,serif;max-width:640px;color:${C.ink}">` +
    `<h2 style="font-weight:normal;color:${C.ink};margin:0 0 4px">The week ahead</h2>` +
    `<p style="color:${C.muted};margin:0">${escapeHtml(longDay(addDays(today, 1)))} to ${escapeHtml(longDay(addDays(today, WEEK_DAYS)))}</p>` +
    notSetUp + problems +
    (parts.some((p) => p.html) ? parts.map((p) => p.html).join("") : `<p>Nothing on the calendar and no Next steps. A quiet week.</p>`) +
    extra +
    `<p style="margin-top:28px"><a href="${SITE}" style="color:${C.accent}">Open LMX Home</a></p></div>`;
  const text = [subject, "", ...parts.map((p) => p.text).filter(Boolean), questions ? `Claude has ${questions} question(s) waiting on LMX Home.\n` : "", SITE].join("\n");
  return { subject, html, text };
}

export async function sendWeekly() {
  const { RESEND_API_KEY, FROM_EMAIL, DIGEST_EMAIL } = process.env;
  if (!RESEND_API_KEY || !FROM_EMAIL || !DIGEST_EMAIL) {
    return { sent: false, reason: "Email isn't set up on LMX Home yet (RESEND_API_KEY, FROM_EMAIL or DIGEST_EMAIL missing in Netlify)" };
  }
  const { subject, html, text } = await buildWeekly();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to: DIGEST_EMAIL, subject, html, text }),
  });
  if (!res.ok) return { sent: false, reason: `Resend error ${res.status}: ${await res.text()}` };
  return { sent: true, reason: subject };
}
