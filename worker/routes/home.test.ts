// The landing page.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import app from "../index.ts";
import { minimalEvent } from "../test/minimal.ts";
import { resetDatabase } from "../test/reset.ts";
import { fixture, seedFixture } from "../test/seed.ts";

const PASSCODE = "test-passcode";

async function signIn(): Promise<string> {
  const res = await app.request(
    "/login",
    {
      method: "POST",
      body: new URLSearchParams({ passcode: PASSCODE }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    },
    env,
  );
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

const home = async (vars: Record<string, string> = {}, cookie = "") => {
  const res = await app.request("/", cookie ? { headers: { cookie } } : {}, { ...env, ...vars });
  expect(res.status).toBe(200);
  return await res.text();
};

// The surface cards in document order: href and whether it carries the badge.
function surfaces(page: string): { href: string; locked: boolean }[] {
  return [...page.matchAll(/<a class="card surface" href="([^"]+)">(.*?)<\/a>/gs)].map((m) => ({
    href: m[1]!,
    locked: m[2]!.includes(">Passcode<"),
  }));
}

function leaders(page: string): [number, string, string][] {
  return [
    ...page.matchAll(
      /<li[^>]*><span class="rank">(\d+)<\/span><span class="name">([^<]*)<\/span><span class="pts">([^<]*)<\/span><\/li>/g,
    ),
  ].map((m) => [Number(m[1]), m[2]!, m[3]!]);
}

describe("with the recorded night", () => {
  beforeAll(async () => {
    await resetDatabase(env.DB);
    await seedFixture(env.DB);
  });

  test("names the active event and what has been recorded", async () => {
    const page = await home();
    expect(page).toContain(`<h1>${fixture.raw["events"]![0]!["name"]}</h1>`);
    expect(page).toContain(`${fixture.roster.length} players · 6 games recorded`);
  });

  test("shows the top three of the standings with their shared ranks", async () => {
    const expected = fixture.expected.ranked.filter(([rank]) => rank <= 3);
    expect(leaders(await home()).map(([rank, name]) => [rank, name])).toEqual(
      expected.map(([rank, player]) => [rank, player]),
    );
    expect(await home()).toContain("11 of 11 prizes claimed");
  });

  test("marks the surfaces that ask for the passcode", async () => {
    expect(surfaces(await home())).toEqual([
      { href: "/display", locked: false },
      { href: "/entry", locked: true },
      { href: "/results", locked: true },
      { href: "/admin", locked: true },
    ]);
  });

  test("marks nothing once signed in", async () => {
    const page = await home({}, await signIn());
    expect(surfaces(page).every((s) => !s.locked)).toBe(true);
  });

  test("keeps the standings off the page when the board is private", async () => {
    const page = await home({ PROTECT_DISPLAY: "true" });
    expect(leaders(page)).toEqual([]);
    expect(page).not.toContain("prizes claimed");
    expect(surfaces(page)[0]).toEqual({ href: "/display", locked: true });
    // Signing in opens the board, so the leaders come back.
    expect(leaders(await home({ PROTECT_DISPLAY: "true" }, await signIn())).length).toBeGreaterThan(0);
  });
});

describe("before anything is recorded", () => {
  beforeAll(async () => {
    await resetDatabase(env.DB);
    await minimalEvent(env.DB);
    await env.DB.prepare("UPDATE events SET name = ?, date = '2026-11-14' WHERE event_id = 1")
      .bind("<b>Night</b>")
      .run();
  });

  test("says no games yet instead of an empty list", async () => {
    const page = await home();
    expect(page).toContain("No games recorded yet.");
    expect(leaders(page)).toEqual([]);
  });

  test("shows the date and escapes the name", async () => {
    const page = await home();
    expect(page).toContain("14 November 2026 · 4 players · 0 games recorded");
    expect(page).not.toContain("<b>Night</b>");
    expect(page).toContain("&lt;b&gt;Night&lt;/b&gt;");
  });
});

test("an empty database still renders, and says so", async () => {
  await resetDatabase(env.DB);
  const page = await home();
  expect(page).toContain("No event yet");
  expect(surfaces(page).length).toBe(4);
});
