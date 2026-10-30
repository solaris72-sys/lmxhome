import { sendWeekly } from "./lib/weekly.js";

// Sundays at 6 pm in California. Netlify schedules run in UTC, so this fires at both 01:00 and
// 02:00 UTC on Monday (6 pm Sunday in daylight and standard time) and sends only on the one that is 6 pm there
export default async () => {
  const now = new Date();
  const hour = Number(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "America/Los_Angeles" }));
  const weekday = now.toLocaleString("en-US", { weekday: "short", timeZone: "America/Los_Angeles" });
  if (weekday !== "Sun" || hour !== 18) return;
  const result = await sendWeekly();
  console.log("weekly-email:", result.sent ? "sent" : "not sent", result.reason);
};

export const config = { schedule: "0 1,2 * * 1" };
