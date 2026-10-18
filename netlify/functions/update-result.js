import { requireAuth } from "./lib/auth.js";
import { getJob } from "./lib/store.js";
import { json } from "./lib/http.js";

// GET ?id=: Claude's answer to a "Tell Claude" update, or { done: false } while it's still working
export default async (req) => {
  const unauthorized = requireAuth(req);
  if (unauthorized) return unauthorized;
  const id = (new URL(req.url).searchParams.get("id") || "").replace(/[^a-z0-9]/gi, "");
  return json((await getJob(id)) || { done: false });
};
