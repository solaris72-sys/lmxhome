import crypto from "node:crypto";

// The computer's sync script sends SYNC_TOKEN; the page itself uses the login cookie
export function hasSyncToken(req) {
  const expected = process.env.SYNC_TOKEN || "";
  const given = req.headers.get("x-sync-token") || "";
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
