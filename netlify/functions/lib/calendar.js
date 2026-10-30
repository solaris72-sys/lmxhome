import ICAL from "ical.js";

// Upcoming events for the Calendar card and the weekly email: Google Calendar's "Secret address in
// iCal format" links (GCAL_ICS_URLS, comma-separated; read-only, no Google sign-in), plus the
// application deadlines and opening dates saved in the Opportunities app.

const OPPS_SUMMARY = "https://lmxopportunities.netlify.app/api/summary?board=all";

// Cleans up a pasted link: stray quotes or angle brackets, and webcal:// (Apple's name for the same feed)
function cleanUrl(raw) {
  return raw.trim().replace(/^["'<]+|["'>]+$/g, "").replace(/^webcal:\/\//i, "https://");
}

// The links, each with a plain-language problem if it can't be a calendar feed.
// The link itself is never echoed back, since it's a secret
export function feedUrls() {
  return (process.env.GCAL_ICS_URLS || "").split(/[,\s]+/).map(cleanUrl).filter(Boolean).map((url, i) => {
    const which = `Calendar link ${i + 1}`;
    if (/^[•*]+$/.test(url)) return { problem: `${which} was saved as the hidden dots Netlify shows instead of the link itself. Paste the link from Google Calendar again.` };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { problem: `${which} isn't a web address. It should start with https://calendar.google.com/calendar/ical/` };
    }
    if (!/^https?:$/.test(parsed.protocol)) return { problem: `${which} isn't a web address. It should start with https://calendar.google.com/calendar/ical/` };
    if (/calendar\.google\.com/.test(parsed.host) && !/\/ical\//.test(parsed.pathname)) {
      return { problem: `${which} is a Google Calendar page link, not the feed. Copy "Secret address in iCal format" instead.` };
    }
    return { url };
  });
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

const nextDay = (iso) => new Date(Date.parse(`${iso}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);

// Saved opportunities' deadlines and opening dates, as all-day events
async function opportunityEvents(fromIso, toIso) {
  const res = await fetch(OPPS_SUMMARY, { headers: { "x-summary-token": process.env.SUMMARY_TOKEN || "" }, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Opportunities answered ${res.status}`);
  const data = await res.json();
  const day = (date, title, o, kind) => ({
    title, start: { date }, end: { date: nextDay(date) }, allDay: true, location: "",
    calendar: "Opportunities", kind, url: o.url || "", tab: o.tab || "",
  });
  return [
    ...(data.deadlines || []).map((o) => day(o.deadline, `Due: ${o.title}`, o, "deadline")),
    ...(data.openings || []).map((o) => day(o.opens, `Opens: ${o.title}`, o, "opens")),
  ].filter((e) => e.start.date >= fromIso && e.start.date <= toIso);
}

export const sortKey = (e) => e.start.at || `${e.start.date}T00:00:00`;

// Events from yesterday through `days` ahead. configured is false until a Google link is set
export async function upcomingEvents(days) {
  const feeds = feedUrls();
  const from = new Date(Date.now() - 864e5);
  const to = new Date(Date.now() + (days + 1) * 864e5);
  const iso = (d) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

  const jobs = [
    ...feeds.filter((f) => f.url).map(async (f) => {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(8000) });
      if (res.status === 404) throw new Error("Google doesn't recognize a calendar link (it may have been reset). Copy the Secret address in iCal format again.");
      if (!res.ok) throw new Error(`Google answered ${res.status}`);
      return eventsFrom(await res.text(), from, to);
    }),
    opportunityEvents(iso(from), iso(to)),
  ];
  const results = await Promise.allSettled(jobs);
  const events = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const errors = [
    ...feeds.filter((f) => f.problem).map((f) => f.problem),
    ...results.filter((r) => r.status === "rejected").map((r) => (r.reason?.name === "TimeoutError" ? "A calendar didn't answer in time" : r.reason?.message)),
  ];
  events.sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return { configured: feeds.length > 0, events, errors };
}
