import { createSessionCookieValue, buildSessionCookie } from "./lib/auth.js";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const appPassword = process.env.APP_PASSWORD;
  if (!appPassword) {
    return new Response(JSON.stringify({ error: "Server is not configured (APP_PASSWORD missing)" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (typeof body.password !== "string" || body.password !== appPassword) {
    return new Response(JSON.stringify({ error: "Incorrect password" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const cookie = buildSessionCookie(createSessionCookieValue());
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": cookie,
    },
  });
};
