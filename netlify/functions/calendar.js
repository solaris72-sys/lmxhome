import { requireAuth } from "./lib/auth.js";
import { json } from "./lib/http.js";
import { upcomingEvents } from "./lib/calendar.js";

const DAYS_AHEAD = 14;
const MAX_EVENTS = 60;

// GET: Google Calendar events and saved opportunities' dates, from yesterday through the next two weeks
// (a day of slack on each side; the page trims to its own "today")
export default async (req) => {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;
  const { configured, events, errors } = await upcomingEvents(DAYS_AHEAD);
  return json({ configured, events: events.slice(0, MAX_EVENTS), errors });
};
