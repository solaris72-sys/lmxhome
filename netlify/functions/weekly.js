import { requireAuth } from "./lib/auth.js";
import { json } from "./lib/http.js";
import { buildWeekly, sendWeekly } from "./lib/weekly.js";

// GET: this week's email as it would go out (for the preview). POST: send it now
export default async (req) => {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;
  if (req.method === "POST") return json(await sendWeekly());
  const { subject, html } = await buildWeekly();
  return json({ subject, html, emailReady: Boolean(process.env.RESEND_API_KEY && process.env.FROM_EMAIL && process.env.DIGEST_EMAIL) });
};
