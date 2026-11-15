// The passcode guard, ported from tests/test_auth.py.
//
// The four tests about the plain-HTTP cookie warning are deliberately absent:
// that warning covered reaching the container directly on the LAN while
// cookies were Secure, and the Worker answers on one HTTPS hostname. The two
// startup-refusal tests became the 503 below, since a Worker has no startup.
//
// The throttle tests are the ones worth reading. On FastAPI the throttle was a
// dict in the one uvicorn process; here it is a D1 table, because Workers
// isolates do not share memory and a per-isolate lockout would evaporate.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { isProtected } from "../auth.ts";
import app from "../index.ts";
import { resetDatabase } from "../test/reset.ts";
import { seedFixture } from "../test/seed.ts";

const PASSCODE = "test-passcode";

/** A signed-in cookie jar: the Set-Cookie from a successful login. */
async function signIn(next = "/entry"): Promise<string> {
  const res = await app.request(
    "/login",
    {
      method: "POST",
      body: new URLSearchParams({ passcode: PASSCODE, next }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    },
    env,
  );
  expect(res.status).toBe(303);
  const cookie = res.headers.get("set-cookie");
  expect(cookie, "login should set a cookie").toBeTruthy();
  return cookie!.split(";")[0]!;
}

beforeEach(async () => {
  // A full reset, not just the throttle table: storage is shared across tests
  // in this runtime, so one test's wrong guesses could lock out the next and
  // one test's seeded event could collide with another's seed.
  await resetDatabase(env.DB);
});

describe("the guard", () => {
  test.for([
    "/entry",
    "/admin",
    "/entry/turn",
    "/admin/roster",
    "/results",
    // Guarded by its own entry, not by the "/results" one: isProtected matches
    // on segment boundaries, so "/results" does not cover "/results.csv". The
    // cost of getting that wrong is the whole night's per-player rows being
    // downloadable without the passcode.
    "/results.csv",
    "/results/turns.csv",
  ])(
    "%s bounces an anonymous caller to the login page",
    async (path) => {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("/login?next=");
    },
  );

  test("an anonymous POST cannot write", async () => {
    const res = await app.request("/entry/turn", { method: "POST" }, env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login");
  });

  test("the login page is reachable without auth", async () => {
    const res = await app.request("/login", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Tracker passcode");
  });

  test("a prefix match respects path boundaries", async () => {
    // /entrypoint is not part of /entry, so it must not be guarded into
    // existence: it should 404 rather than redirect.
    const res = await app.request("/entrypoint", {}, env);
    expect(res.status).toBe(404);
  });

  test("the boundary rule is why /results.csv needs its own entry", async () => {
    // Pins the reasoning rather than the list: if isProtected ever stopped
    // respecting segment boundaries, the prefixes above would quietly become
    // broader than intended, and this is the test that would say so.
    expect(isProtected("/results.csv", ["/results"])).toBe(false);
    expect(isProtected("/results", ["/results"])).toBe(true);
    expect(isProtected("/results/turns.csv", ["/results"])).toBe(true);
    expect(isProtected("/entrypoint", ["/entry"])).toBe(false);
  });

  test("the display is open by default", async () => {
    await seedFixture(env.DB);
    const res = await app.request("/display", {}, env);
    expect(res.status).toBe(200);
  });

  test("the display can be gated by configuration", async () => {
    const res = await app.request("/display", {}, { ...env, PROTECT_DISPLAY: "true" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login");
  });

  test("a guarded surface refuses to serve while the passcode is unset", async () => {
    // What FastAPI's startup check did, at the only moment a Worker can do it.
    // The failure this prevents is an unauthenticated /entry on the internet,
    // so it must not fail open.
    for (const broken of [{ TRACKER_PASSCODE: "" }, { TRACKER_PASSCODE: "change-me" }, { SESSION_SECRET: "" }]) {
      const res = await app.request("/entry", {}, { ...env, ...broken });
      expect(res.status, JSON.stringify(broken)).toBe(503);
      const body = await res.text();
      expect(body).toMatch(/TRACKER_PASSCODE|SESSION_SECRET/);
    }
  });
});

describe("signing in", () => {
  test("login and logout round trip", async () => {
    const cookie = await signIn();
    const res = await app.request("/entry", { headers: { cookie } }, env);
    expect(res.status).not.toBe(303);

    const out = await app.request("/logout", { method: "POST", headers: { cookie } }, env);
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toBe("/login");
    // The clearing cookie is what signs the device out.
    expect(out.headers.get("set-cookie")).toMatch(/session=;|Max-Age=0/);
  });

  test("a wrong passcode is rejected and grants nothing", async () => {
    const res = await app.request(
      "/login",
      {
        method: "POST",
        body: new URLSearchParams({ passcode: "nope" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Incorrect passcode");
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toBeNull();
  });

  test("login returns the caller to where they were going", async () => {
    const res = await app.request(
      "/login",
      {
        method: "POST",
        body: new URLSearchParams({ passcode: PASSCODE, next: "/admin/roster" }),
        headers: { "content-type": "application/x-www-form-urlencoded" },
      },
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/admin/roster");
  });

  test.for(["//evil.example", "https://evil.example", "http://evil.example/x"])(
    "next=%s cannot be an open redirect",
    async (evil) => {
      const res = await app.request(
        "/login",
        {
          method: "POST",
          body: new URLSearchParams({ passcode: PASSCODE, next: evil }),
          headers: { "content-type": "application/x-www-form-urlencoded" },
        },
        env,
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/entry");
    },
  );

  test("the session cookie carries no secret and cannot be forged", async () => {
    const cookie = await signIn();
    // The value is readable (`authed:<issued-at>` plus a signature) and that is
    // fine: it holds no secret, and signing is what makes it trustworthy. What
    // must never appear in it is the passcode or the signing key.
    expect(cookie).not.toContain(PASSCODE);
    expect(cookie).not.toContain("test-secret");

    // Tampering with it must not be accepted.
    const forged = "session=authed%3A" + Date.now() + ".deadbeef";
    const res = await app.request("/entry", { headers: { cookie: forged } }, env);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login");
  });

  test("a session is accepted until SESSION_HOURS has passed, then is not", async () => {
    // Max-Age is the browser's promise, not ours. A cookie copied off a
    // tracker's phone must not outlive the night, so the issued-at inside the
    // value is checked server-side too.
    //
    // Asserted against a gated /display because it is the only guarded surface
    // that exists in this phase; /entry and /admin arrive later in phase 2 and
    // would 404 here, which would make the negative case indistinguishable
    // from the route simply being absent.
    await seedFixture(env.DB);
    const cookie = await signIn("/display");
    const gated = { ...env, PROTECT_DISPLAY: "true" };

    expect((await app.request("/display", { headers: { cookie } }, gated)).status).toBe(200);

    const expired = await app.request("/display", { headers: { cookie } }, {
      ...gated,
      SESSION_HOURS: "0",
    });
    expect(expired.status).toBe(303);
    expect(expired.headers.get("location")).toContain("/login");
  });
});

describe("where a bounced request comes back to", () => {
  test("an htmx request gets HX-Redirect rather than a page swap", async () => {
    const res = await app.request(
      "/entry/turn",
      { method: "POST", headers: { "HX-Request": "true", "HX-Current-URL": "https://x/entry?pod=A" } },
      env,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("HX-Redirect")).toContain("/login?next=");
    // A 303 would make htmx swap the login page into whatever triggered it.
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe("");
  });

  test("a save that bounces comes back to the page, not the POST", async () => {
    const res = await app.request(
      "/entry/turn",
      { method: "POST", headers: { "HX-Request": "true", "HX-Current-URL": "https://x/entry?pod=A&match_no=2" } },
      env,
    );
    const target = decodeURIComponent(res.headers.get("HX-Redirect")!.split("next=")[1]!);
    expect(target).toBe("/entry?pod=A&match_no=2");
  });

  test("a bounced POST without htmx goes to the top of its section", async () => {
    // GET /entry/turn is a bare 405, so sending a browser there after login
    // would strand the tracker.
    const res = await app.request("/admin/roster", { method: "POST" }, env);
    const target = decodeURIComponent(res.headers.get("location")!.split("next=")[1]!);
    expect(target).toBe("/admin");
  });

  test("a bounced page load still comes back to that page", async () => {
    const res = await app.request("/entry?pod=B&match_no=3", {}, env);
    const target = decodeURIComponent(res.headers.get("location")!.split("next=")[1]!);
    expect(target).toBe("/entry?pod=B&match_no=3");
  });
});

describe("throttling", () => {
  async function guess(passcode: string, ip = "198.51.100.7"): Promise<Response> {
    return await app.request(
      "/login",
      {
        method: "POST",
        body: new URLSearchParams({ passcode }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "CF-Connecting-IP": ip,
        },
      },
      env,
    );
  }

  test("repeated failures are throttled", async () => {
    for (let i = 0; i < 5; i++) expect((await guess("nope")).status).toBe(401);
    const locked = await guess("nope");
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("Too many attempts");
    // And the right passcode is refused while the lockout stands, or the
    // throttle would only inconvenience honest typists.
    expect((await guess(PASSCODE)).status).toBe(429);
  });

  test("the lockout is durable rather than per isolate", async () => {
    // The whole reason this is a table: module state would not survive, so a
    // lockout has to be visible to a request that never touched this isolate.
    for (let i = 0; i < 5; i++) await guess("nope");
    const row = await env.DB.prepare(
      "SELECT locked_until FROM login_attempts WHERE client_key = ?",
    )
      .bind("198.51.100.7")
      .first<{ locked_until: number }>();
    expect(row!.locked_until).toBeGreaterThan(Date.now());
  });

  test("a successful login clears the failure count", async () => {
    for (let i = 0; i < 4; i++) await guess("nope");
    expect((await guess(PASSCODE)).status).toBe(303);
    const row = await env.DB.prepare("SELECT 1 FROM login_attempts WHERE client_key = ?")
      .bind("198.51.100.7")
      .first();
    expect(row).toBeNull();
  });

  test("one caller's lockout does not lock out the room", async () => {
    for (let i = 0; i < 6; i++) await guess("nope", "198.51.100.7");
    expect((await guess(PASSCODE, "198.51.100.8")).status).toBe(303);
  });
});
