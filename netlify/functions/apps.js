import { requireAuth } from "./lib/auth.js";
import { json } from "./lib/http.js";

// Every app, and where to get its numbers. "summary" apps share SUMMARY_TOKEN with this site.
const APPS = [
  { id: "opps", name: "Woodworking Opportunities", url: "https://lmxopportunities.netlify.app", summary: "/api/summary", area: "Woodworking" },
  { id: "resume", name: "Resume Builder", url: "https://lmxresume.netlify.app", summary: "/api/summary", area: "Woodworking" },
  { id: "flyers", name: "Flyer Tracker", url: "https://lmxflyers.netlify.app", summary: "/api/summary", area: "Woodworking" },
  { id: "lumber", name: "Lumber Inventory", url: "https://lmxlumberinventory.netlify.app", publicListings: "/api/public-listings", area: "Woodworking" },
  { id: "site", name: "lmxfurniture.com", url: "https://lmxfurniture.com", area: "Woodworking" },
  { id: "insta", name: "Instagram Post Studio", url: "https://lmxinsta.netlify.app", area: "Woodworking" },
  { id: "newsletter", name: "Newsletter Builder", url: "https://lmxnewsletterapp.netlify.app", area: "Woodworking" },
  { id: "scion", name: "Forestry Opportunities", url: "https://scionopportunities.netlify.app", summary: "/api/summary", area: "Scion Forestry" },
];

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function load(app) {
  const out = { id: app.id, name: app.name, url: app.url, area: app.area };
  try {
    if (app.summary) out.data = await fetchJson(app.url + app.summary, { "x-summary-token": process.env.SUMMARY_TOKEN || "" });
    if (app.publicListings) out.data = { published: (await fetchJson(app.url + app.publicListings)).length };
    if (!app.summary && !app.publicListings) {
      // Links only: just check it answers
      const res = await fetch(app.url, { method: "HEAD", signal: AbortSignal.timeout(6000) });
      out.up = res.ok;
    }
  } catch (err) {
    out.error = err.name === "TimeoutError" ? "Didn't answer in time" : err.message;
  }
  return out;
}

// GET: each app with its live numbers, fetched in parallel
export default async (req) => {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;
  return json(await Promise.all(APPS.map(load)));
};
