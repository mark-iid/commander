// Login and logout for the shared passcode.
//
// Deliberately outside the guarded prefixes: /login must stay reachable to
// everyone, or there is no way in.

import { Hono } from "hono";
import type { Context } from "hono";
import {
  checkPasscode,
  clearSession,
  clientKey,
  isSafeNext,
  lockedFor,
  misconfigured,
  recordFailure,
  recordSuccess,
  settings,
  signedIn,
  writeSession,
} from "../auth.ts";
import { loginPage } from "../views/login.ts";

const DEFAULT_NEXT = "/entry";

function safe(target: string | undefined): string {
  return target && isSafeNext(target) ? target : DEFAULT_NEXT;
}

export const auth = new Hono<{ Bindings: Env }>();

auth.get("/login", async (c) => {
  const problem = misconfigured(c.env);
  if (problem) return c.text(problem, 503);
  const next = safe(c.req.query("next"));
  if (await signedIn(c)) return c.redirect(next, 303);
  return c.html(loginPage(next, null));
});

auth.post("/login", async (c) => {
  const problem = misconfigured(c.env);
  if (problem) return c.text(problem, 503);

  const form = await c.req.formData();
  const target = safe(String(form.get("next") ?? DEFAULT_NEXT));
  const key = clientKey(c);

  const wait = await lockedFor(c.env.DB, key);
  if (wait) {
    return c.html(loginPage(target, `Too many attempts. Try again in ${wait}s.`), 429);
  }

  const candidate = String(form.get("passcode") ?? "");
  if (!(await checkPasscode(candidate, settings(c.env).passcode))) {
    await recordFailure(c.env.DB, key);
    return c.html(loginPage(target, "Incorrect passcode."), 401);
  }

  await recordSuccess(c.env.DB, key);
  // A fresh issued-at on privilege change, so a cookie held before signing in
  // cannot be replayed as an authenticated one.
  await writeSession(c);
  return c.redirect(target, 303);
});

auth.post("/logout", (c) => {
  clearSession(c);
  return c.redirect("/login", 303);
});

/**
 * Where to land after logging in: the page, never the request that bounced.
 *
 * A save (a POST) or an htmx partial is not somewhere a browser can be sent
 * back to. A session that lapsed mid-save used to log the tracker in and then
 * redirect them to GET /entry/turn, which is a bare 405. htmx names the page it
 * was on in HX-Current-URL; failing that, the top of the section.
 */
function comeBackTo(c: Context<{ Bindings: Env }>): string {
  const url = new URL(c.req.url);
  const isHtmx = c.req.header("HX-Request") === "true";
  if (c.req.method === "GET" && !isHtmx) {
    return url.pathname + (url.search || "");
  }
  const current = c.req.header("HX-Current-URL");
  if (isHtmx && current) {
    try {
      const page = new URL(current, url);
      if (page.pathname.startsWith("/")) return page.pathname + (page.search || "");
    } catch {
      // An unparseable header is not worth a 500; fall through to the section.
    }
  }
  return "/" + url.pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
}

/** Bounce an unauthenticated caller to the login page. */
export function challenge(c: Context<{ Bindings: Env }>): Response {
  const loginUrl = "/login?next=" + encodeURIComponent(comeBackTo(c));
  if (c.req.header("HX-Request") === "true") {
    // A 303 here would make htmx swap the login page into whatever element
    // triggered the request. HX-Redirect makes the browser navigate instead.
    return new Response(null, { status: 401, headers: { "HX-Redirect": loginUrl } });
  }
  return c.redirect(loginUrl, 303);
}
