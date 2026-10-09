import ICAL from "ical.js";
import { requireAuth } from "./lib/auth.js";
import { json } from "./lib/http.js";

// Google Calendar's "Secret address in iCal format" links, comma-separated, so the page can show
// upcoming events without a Google sign-in. Read-only.
const DAYS_AHEAD = 14;
const MAX_EVENTS = 60;

function feedUrls() {
  return (process.env.GCAL_ICS_URLS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// All-day events come back as a plain date; timed events as an exact moment (UTC)
function out(time) {
  if (time.isDate) return { date: time.toString().slice(0, 10) };
  return { at: time.toJSDate().toISOString() };
}

function eventsFrom(text, from, to) {
  const cal = new ICAL.Component(ICAL.parse(text));
  // Register the feed's time zones so "9:00 in Los Angeles" lands on the right moment
  for (const tz of cal.getAllSubcomponents("vtimezone")) {
    const zone = new ICAL.Timezone(tz);
    if (!ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone);
  }
  const calName = cal.getFirstPropertyValue("x-wr-calname") || "";
  const vevents = cal.getAllSubcomponents("vevent");
  // Edited single occurrences of a repeating event replace the original occurrence
  const overrides = new Map();
  for (const v of vevents) {
    if (v.hasProperty("recurrence-id")) {
      const ev = new ICAL.Event(v);
      overrides.set(`${ev.uid}|${ev.recurrenceId.toUnixTime()}`, ev);
    }
  }
  const events = [];
  const push = (ev, start, end) => {
    const s = start.toJSDate();
    const e = (end || start).toJSDate();
    if (e < from || s > to) return;
    if (ev.component.getFirstPropertyValue("status") === "CANCELLED") return;
    events.push({
      title: ev.summary || "(No title)",
      start: out(start),
      end: end ? out(end) : null,
      allDay: start.isDate,
      location: ev.location || "",
      calendar: calName,
    });
  };
  for (const v of vevents) {
    if (v.hasProperty("recurrence-id")) continue;
    const ev = new ICAL.Event(v);
    if (!ev.isRecurring()) {
      push(ev, ev.startDate, ev.endDate);
      continue;
    }
    const it = ev.iterator();
    let next;
    let guard = 0;
    while ((next = it.next()) && guard++ < 2000) {
      if (next.toJSDate() > to) break;
      const changed = overrides.get(`${ev.uid}|${next.toUnixTime()}`);
      if (changed) {
        push(changed, changed.startDate, changed.endDate);
        continue;
      }
      const d = ev.getOccurrenceDetails(next);
      push(ev, d.startDate, d.endDate);
    }
  }
  // Moved occurrences whose original date is outside the window still count
  for (const ev of overrides.values()) {
    const already = events.some((x) => x.title === (ev.summary || "(No title)") && JSON.stringify(x.start) === JSON.stringify(out(ev.startDate)));
    if (!already) push(ev, ev.startDate, ev.endDate);
  }
  return events;
}

const sortKey = (e) => e.start.at || `${e.start.date}T00:00:00`;

// GET: events from yesterday through the next two weeks
export default async (req) => {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;
  const urls = feedUrls();
  if (!urls.length) return json({ configured: false, events: [] });

  // A day of slack on each side; the page trims to its own "today"
  const from = new Date(Date.now() - 864e5);
  const to = new Date(Date.now() + (DAYS_AHEAD + 1) * 864e5);

  const results = await Promise.allSettled(urls.map(async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Google answered ${res.status}`);
    return eventsFrom(await res.text(), from, to);
  }));
  const events = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const errors = results.filter((r) => r.status === "rejected").map((r) => r.reason?.name === "TimeoutError" ? "Google didn't answer in time" : r.reason?.message);
  events.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return json({ configured: true, events: events.slice(0, MAX_EVENTS), errors });
};
