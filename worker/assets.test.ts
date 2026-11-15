// The asset path mapping, which is the part that broke.
//
// The HTTP caching behaviour this replaces the content hash with is NOT tested
// here: the vitest runtime wires the ASSETS binding but does not serve the
// asset directory, so every fetch through it is a 404 and a test would be
// asserting the harness rather than the platform. That half was verified
// against `wrangler dev`:
//
//   /static/app.css -> 200, Cache-Control: public, max-age=0, must-revalidate,
//   ETag: "d9ce80..."; the same request with If-None-Match -> 304; a different
//   file -> a different ETag.
//
// What is testable, and what actually went wrong, is the path.

import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import { assetPath, assetRequest } from "./assets.ts";
import app from "./index.ts";

test("the /static prefix comes off, because the binding serves from its own root", () => {
  // app/static/app.css is /app.css to the binding. Forwarding /static/app.css
  // unchanged 404s every asset on every page.
  expect(assetPath("/static/app.css")).toBe("/app.css");
  expect(assetPath("/static/htmx.min.js")).toBe("/htmx.min.js");
});

test("anything that is not under /static is left alone", () => {
  expect(assetPath("/display")).toBe("/display");
  // Not a prefix match on the bare word: /staticky is not an asset path.
  expect(assetPath("/staticky/x.css")).toBe("/staticky/x.css");
});

test("the rewritten request keeps its method and headers", () => {
  const original = new Request("https://mtg.example/static/app.css", {
    headers: { "if-none-match": '"abc"' },
  });
  const rewritten = assetRequest(original);
  expect(new URL(rewritten.url).pathname).toBe("/app.css");
  // Revalidation depends on the conditional header surviving the rewrite.
  expect(rewritten.headers.get("if-none-match")).toBe('"abc"');
  expect(rewritten.method).toBe("GET");
});

test("the guard does not swallow /static", async () => {
  // The login page needs its stylesheet before anybody has signed in. A 404
  // from the binding is expected in this runtime; a redirect to /login would
  // mean the guard had claimed the path.
  const res = await app.request("/static/app.css", {}, env);
  expect(res.status).not.toBe(303);
  expect(res.headers.get("location")).toBeNull();
});
