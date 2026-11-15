// The results sheet and the two exports.
//
// The CSVs are compared byte for byte against recorded output in
// shared/fixtures/fall-2026-results.csv and -turns.csv. These are the
// take-home record of an
// event, so a shifted column or a different row order is the kind of damage
// nobody notices until they read the sheet months later.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import expectedResultsCsv from "../../shared/fixtures/fall-2026-results.csv?raw";
import expectedTurnsCsv from "../../shared/fixtures/fall-2026-turns.csv?raw";
import app from "../index.ts";
import { resetDatabase } from "../test/reset.ts";
import { fixture, seedFixture } from "../test/seed.ts";

const PASSCODE = "test-passcode";
let cookie: string;

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

async function get(path: string): Promise<Response> {
  return await app.request(path, { headers: { cookie } }, env);
}

beforeAll(async () => {
  await resetDatabase(env.DB);
  await seedFixture(env.DB);
  cookie = await signIn();
});

describe("the exports", () => {
  test("/results.csv is byte-identical to the recorded export", async () => {
    const res = await get("/results.csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(await res.text()).toBe(expectedResultsCsv);
  });

  test("/results/turns.csv is byte-identical to the recorded export", async () => {
    const res = await get("/results/turns.csv");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(expectedTurnsCsv);
  });

  test("a deck name with a comma stays one field", async () => {
    // The case a hand-rolled CSV writer gets wrong. Asserted on its own as
    // well as inside the byte comparison, so a failure says what broke.
    const body = await (await get("/results.csv")).text();
    expect(body).toContain('"Omnath, Locus of All"');
  });

  test("the filename carries the event and the room's clock", async () => {
    const res = await get("/results.csv");
    const disposition = res.headers.get("content-disposition")!;
    expect(disposition).toMatch(
      /attachment; filename="fall-2026-battle-of-the-commanders-results-\d{8}-\d{4}\.csv"/,
    );
  });

  test("the filename's date is the event's timezone, not UTC", async () => {
    // A Worker has no local timezone. Without EVENT_TIMEZONE a download at
    // 10pm Eastern on a Friday would be stamped with Saturday's date, on the
    // one artefact people keep.
    const utc = await app.request(
      "/results.csv",
      { headers: { cookie } },
      { ...env, EVENT_TIMEZONE: "UTC" },
    );
    const pacific = await app.request(
      "/results.csv",
      { headers: { cookie } },
      { ...env, EVENT_TIMEZONE: "Pacific/Kiritimati" },
    );
    const stampOf = (r: Response) =>
      /-(\d{8}-\d{4})\.csv/.exec(r.headers.get("content-disposition")!)![1]!;
    // +14 against UTC, so the two can never agree on the hour.
    expect(stampOf(utc)).not.toBe(stampOf(pacific));
  });
});

describe("the sheet", () => {
  let page: string;

  beforeAll(async () => {
    const res = await get("/results");
    expect(res.status).toBe(200);
    page = await res.text();
  });

  test("it says the night is final, because every player finished every game", () => {
    // "Final results" must never be ahead of the truth: it is the one claim on
    // this sheet that matters to whoever reads the PDF next week.
    expect(page).toContain("Final results");
    expect(page).not.toContain("Provisional");
    expect(page).toContain("8 players");
  });

  test("the standings and awards are the night's", () => {
    for (const [, player] of fixture.expected.ranked) expect(page).toContain(player);
    for (const prize of fixture.expected.prizes) {
      expect(page, prize.key).toContain(prize.winner!);
    }
  });

  test("every match and pod has a section, in order", () => {
    const headings = [...page.matchAll(/Match (\d+) &middot; Pod ([AB])/g)].map(
      (m) => `${m[1]}${m[2]}`,
    );
    // Two pods over three matches, sorted by match then pod.
    expect(headings).toEqual(["1A", "1B", "2A", "2B", "3A", "3B"]);
  });

  test("the damage grid is there, with both margins", () => {
    expect(page).toContain("Combat damage dealt, by opponent");
    expect(page).toContain(">Taken<");
    expect(page).toContain(">Dealt<");
  });

  test("a provisional night says so and counts what is missing", async () => {
    // Half the night removed: the sheet must stop claiming to be final.
    await env.DB.prepare("DELETE FROM game_player_stats WHERE game_id IN (5, 6)").run();
    const body = await (await get("/results")).text();
    expect(body).toContain("Provisional");
    expect(body).not.toContain("Final results");
    // Whitespace-tolerant: the template breaks the line mid-sentence, the
    // same as the Jinja one it was ported from.
    expect(body.replace(/\s+/g, " ")).toMatch(/\d+ of 24 player-games recorded/);
    // Put it back for anything that runs after.
    await resetDatabase(env.DB);
    await seedFixture(env.DB);
  });
});
