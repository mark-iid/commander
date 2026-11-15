// The projected board, rendered by the Worker from real D1.
//
// The data is the actual Fall 2026 night, so these assertions are the same
// eleven winners the room saw. That is the point of testing the surface rather
// than the engine here: shared/scoring.test.ts already proves the arithmetic,
// and what is left to get wrong is the plumbing between D1, the engine and the
// HTML.

import { env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import app from "../index.ts";
import { resetDatabase } from "../test/reset.ts";
import { fixture, seedFixture } from "../test/seed.ts";

let page: string;

beforeAll(async () => {
  await resetDatabase(env.DB);
  await seedFixture(env.DB);
  const res = await app.request("/display", {}, env);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  page = await res.text();
});

test("the board names the event and every player on the roster", () => {
  expect(page).toContain(fixture.raw["events"]![0]!["name"] as string);
  for (const name of fixture.roster) expect(page, name).toContain(name);
});

test("the standings are in the order the engine put them", () => {
  // Pull the player names out of the standings table in document order and
  // compare against what Python computed for this night.
  const table = page.slice(page.indexOf('class="standings"'), page.indexOf("</table>"));
  const rendered = [...table.matchAll(/<td class="name">([^<]*)<\/td>/g)].map((m) => m[1]);
  expect(rendered).toEqual(fixture.expected.ranked.map(([, player]) => player));
});

test("the ranks are the shared ones, not row numbers", () => {
  const table = page.slice(page.indexOf('class="standings"'), page.indexOf("</table>"));
  const ranks = [...table.matchAll(/<td class="rank">(\d+)<\/td>/g)].map((m) => Number(m[1]));
  expect(ranks).toEqual(fixture.expected.ranked.map(([rank]) => rank));
});

// Every rendered prize card, in document order: name, winner, value.
// Parsed structurally rather than by searching for a prize's name, because
// the names are escaped on the way out -- "Can't Spell Million Without Mill"
// is not in the HTML, "Can&#39;t ..." is, and searching for the raw text
// silently matched nothing.
function renderedPrizes(src: string): { name: string; winner: string; value: string }[] {
  const re =
    /<div class="prize nbi[^"]*">\s*<span class="name">([^<]*)<\/span>\s*<span class="winner">([^<]*)<\/span>\s*<span class="value">([^<]*)<\/span>/g;
  return [...src.matchAll(re)].map((m) => ({
    name: unescapeHtml(m[1]!),
    winner: unescapeHtml(m[2]!),
    value: m[3]!.trim(),
  }));
}

function unescapeHtml(s: string): string {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

test("every prize shows the winner the night produced", () => {
  const rendered = renderedPrizes(page);
  expect(rendered.length).toBe(11);
  expect(page).toContain("11 of 11 claimed");
  expect(rendered.map((p) => p.name)).toEqual(fixture.prizes.map((p) => p.name));
  expect(rendered.map((p) => p.winner)).toEqual(
    fixture.expected.prizes.map((p) => p.winner),
  );
  expect(rendered.map((p) => p.value)).toEqual(
    fixture.expected.prizes.map((p) => String(p.value)),
  );
});

test("the organiser is in the standings and on no prize", () => {
  const ineligible = fixture.scoring.prize_ineligible as string[];
  const name = ineligible[0]!;
  expect(page).toContain(`<td class="name">${name}</td>`);
  const prizes = page.slice(page.indexOf(">Prizes<"));
  expect(prizes).not.toContain(`<span class="winner">${name}</span>`);
});

test("the board counts the games that have anything recorded", () => {
  expect(page).toContain("6 games");
});

test("a name carrying markup is escaped, not rendered", async () => {
  // Its own state: this adds a player, and the assertions above read the page
  // rendered in beforeAll, which must not depend on test order either way.
  // The views are tagged templates rather than Jinja now, so the autoescaping
  // is a different mechanism and worth one test of its own. A roster is
  // editable in /admin, so this is reachable without a database client.
  await env.DB.prepare(
    "INSERT INTO players (event_id, name, prize_eligible, roster_position)" +
      " VALUES (?, ?, 1, 99)",
  )
    .bind(fixture.raw["events"]![0]!["event_id"] as number, "<script>alert(1)</script>")
    .run();
  const res = await app.request("/display", {}, env);
  const html = await res.text();
  expect(html).not.toContain("<script>alert(1)</script>");
  expect(html).toContain("&lt;script&gt;");
});

test("an empty database says so instead of erroring", async () => {
  await resetDatabase(env.DB);
  const res = await app.request("/display", {}, env);
  expect(res.status).toBe(503);
  expect(await res.text()).toContain("No event configured");
});
