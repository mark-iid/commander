// The Worker. Phase 2 of ADR 0003.
//
// Four surfaces: entry, admin, display, results. Hono over D1, server-rendered
// partials driven by HTMX.
//
// No startup hook. There is nothing to seed: the event and its configuration
// are rows, applied by migrations and edited in /admin.

import { Hono } from "hono";
import { assetRequest } from "./assets.ts";
import { isProtected, misconfigured, protectedPrefixes, signedIn } from "./auth.ts";
import { auth, challenge } from "./routes/auth.ts";
import { admin } from "./routes/admin.ts";
import { display } from "./routes/display.ts";
import { entry } from "./routes/entry.ts";
import { results } from "./routes/results.ts";

const app = new Hono<{ Bindings: Env }>();

/**
 * The passcode guard.
 *
 * Which prefixes it covers is configuration (PROTECT_DISPLAY), the same as the
 * YAML knob it replaces. The misconfigured check is here rather than at
 * startup because a Worker has no startup. An unauthenticated /entry must not
 * be reachable by accident, so the guarded surfaces answer 503 naming the
 * missing secret rather than failing open.
 */
app.use("*", async (c, next) => {
  if (!isProtected(new URL(c.req.url).pathname, protectedPrefixes(c.env))) return next();
  const problem = misconfigured(c.env);
  if (problem) return c.text(problem, 503);
  if (await signedIn(c)) return next();
  return challenge(c);
});

app.route("/", auth);
app.route("/display", display);
app.route("/entry", entry);
app.route("/admin", admin);
// Mounted at the root: the paths are /results, /results.csv and
// /results/turns.csv, which are not under one prefix.
app.route("/", results);

app.get("/", (c) =>
  c.html(
    "<h1>Commander Tracker</h1>" +
      "<p>Surfaces: <a href='/entry'>/entry</a>, " +
      "<a href='/admin'>/admin</a>, <a href='/display'>/display</a>.</p>",
  ),
);

// Static assets. See worker/assets.ts for why the prefix comes off.
app.all("/static/*", (c) => c.env.ASSETS.fetch(assetRequest(c.req.raw)));

export default app;

// The Durable Object the SSE fan-out lives in. Exported from the entry point
// because that is how the runtime finds the class the BOARD binding names.
export { Board } from "./board-do.ts";
