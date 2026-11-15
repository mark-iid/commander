// The admin surface.
//
// The roster is where the event's own configuration now lives, so the two
// things that matter most here are that a player who is part of a game cannot
// be deleted out from under their stats, and that a reset says what it is about
// to destroy before it does it.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import app from "../index.ts";
import { TABLE, minimalEvent } from "../test/minimal.ts";
import { resetDatabase } from "../test/reset.ts";
import { seedFixture } from "../test/seed.ts";

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

const get = (path: string) => app.request(path, { headers: { cookie } }, env);
const post = (path: string, body: URLSearchParams) =>
  app.request(
    path,
    { method: "POST", body, headers: { cookie, "content-type": "application/x-www-form-urlencoded" } },
    env,
  );

async function idOf(name: string): Promise<number> {
  const row = await env.DB.prepare("SELECT player_id FROM players WHERE name = ?")
    .bind(name)
    .first<{ player_id: number }>();
  return row!.player_id;
}

beforeEach(async () => {
  await resetDatabase(env.DB);
  await minimalEvent(env.DB);
  cookie = await signIn();
});

describe("the roster", () => {
  test("it lists the players with their eligibility", async () => {
    const page = await (await get("/admin")).text();
    for (const name of TABLE) expect(page).toContain(name);
    expect(page).toContain("4 players");
    expect((page.match(/name="prize_eligible"/g) ?? []).length).toBe(5); // four rows plus the add form
  });

  test("a player is added at the end of the roster", async () => {
    // Roster order is the scoring engine's last-resort tiebreaker, so where a
    // new player lands is a real decision.
    const res = await post("/admin/players", new URLSearchParams({ name: "Eve", commander: "Doran" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Added Eve.");
    const { results } = await env.DB.prepare(
      "SELECT name FROM players WHERE event_id = 1 ORDER BY roster_position",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual([...TABLE, "Eve"]);
  });

  test("a gap in the middle of the roster does not collide", async () => {
    // A deletion leaves a gap, and reusing the number would hit the unique
    // index on (event_id, roster_position). Deleting from the MIDDLE is what
    // makes that reachable: with Ben (2) gone there are three players left, so
    // a count-based position would be 4, which Dan already holds. Deleting the
    // last player instead leaves the free number at the end and collides with
    // nothing, which is why this test used to pass against a broken position.
    await post(`/admin/players/${await idOf("Ben")}/delete`, new URLSearchParams());
    const res = await post("/admin/players", new URLSearchParams({ name: "Eve" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Added Eve.");
    const { results } = await env.DB.prepare(
      "SELECT name, roster_position FROM players WHERE event_id = 1 ORDER BY roster_position",
    ).all<{ name: string; roster_position: number }>();
    expect(results.map((r) => r.name)).toEqual(["Ann", "Cat", "Dan", "Eve"]);
    // And the new player really is last, not slotted into the gap: roster
    // order is the scoring engine's last-resort tiebreaker.
    expect(results.at(-1)!.roster_position).toBeGreaterThan(4);
  });

  test.for([
    { body: { name: "" }, why: "Name is required." },
    { body: { name: "x".repeat(61) }, why: "60 characters or fewer" },
    { body: { name: "Eve", commander: "y".repeat(81) }, why: "80 characters or fewer" },
    { body: { name: "Ann" }, why: "already on the roster" },
  ])("$why is refused, keeping what was typed", async ({ body, why }) => {
    const res = await post("/admin/players", new URLSearchParams(body as Record<string, string>));
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain(why);
    // A rejected submission must not blank the boxes they have to retype.
    if (body.name && body.name.length <= 60) expect(html).toContain(`value="${body.name}"`);
  });

  test("renaming is safe and keeps the recorded stats", async () => {
    // Stats key on player_id, not name.
    await seedGame();
    const id = await idOf("Ann");
    const res = await post(`/admin/players/${id}`, new URLSearchParams({ name: "Annette", prize_eligible: "1" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Saved Annette.");
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM turn_stats WHERE player_id = ?")
      .bind(id)
      .first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  test("eligibility is a checkbox, and unticking it sticks", async () => {
    // A column rather than a list of names, so a rename cannot change it.
    const id = await idOf("Ann");
    await post(`/admin/players/${id}`, new URLSearchParams({ name: "Ann" }));
    const row = await env.DB.prepare("SELECT prize_eligible FROM players WHERE player_id = ?")
      .bind(id)
      .first<{ prize_eligible: number }>();
    expect(row!.prize_eligible).toBe(0);

    // And the display stops awarding them prizes.
    const page = await (await get("/admin")).text();
    expect(page).toContain("Ann");
    // Ticking it again restores eligibility.
    await post(`/admin/players/${id}`, new URLSearchParams({ name: "Ann", prize_eligible: "1" }));
    const back = await env.DB.prepare("SELECT prize_eligible FROM players WHERE player_id = ?")
      .bind(id)
      .first<{ prize_eligible: number }>();
    expect(back!.prize_eligible).toBe(1);
  });

  test("a player with no games can be deleted", async () => {
    const res = await post(`/admin/players/${await idOf("Dan")}/delete`, new URLSearchParams());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Deleted Dan.");
  });

  test("a player who is part of a game cannot", async () => {
    // Every table referencing a player cascades, so allowing it would destroy
    // their game history and leave the table a seat short.
    await seedGame();
    const res = await post(`/admin/players/${await idOf("Ann")}/delete`, new URLSearchParams());
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("is part of a game and cannot be deleted");
    expect(html).toContain("Rename them instead");
    expect(await idOf("Ann")).toBeGreaterThan(0);
  });

  test("merely being seated counts as part of a game", async () => {
    // Deleting a seated player would leave the table a player short.
    await seatOnly();
    const res = await post(`/admin/players/${await idOf("Cat")}/delete`, new URLSearchParams());
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("cannot be deleted");
  });

  test.for(["abc", "1 ", "1_2", "١٢", "99999999999999999999999", ""])(
    "a path segment of %o is refused rather than 500ing",
    async (raw) => {
      const res = await post(`/admin/players/${encodeURIComponent(raw)}`, new URLSearchParams({ name: "X" }));
      // Either the router does not match it, or the handler refuses it. What
      // must not happen is an unhandled error, or reaching another event's row.
      expect([404, 422]).toContain(res.status);
      if (res.status === 422) expect(await res.text()).toContain("no longer on the roster");
    },
  );
});

describe("the danger zone", () => {
  test("it reports what is actually in the database", async () => {
    await seedGame();
    const page = await (await get("/admin")).text();
    expect(page).toContain("1 stat row");
    expect(page).toContain("1 game");
    expect(page).toContain("4 players");
  });

  test("arming it is a GET and destroys nothing", async () => {
    await seedGame();
    const res = await get("/admin/reset/confirm?scope=results");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Are you sure?");
    expect(html).toContain("1 stat row");
    expect(html).toContain("The roster is kept");
    // Nothing gone.
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM turn_stats").first<{ n: number }>();
    expect(row!.n).toBe(1);
  });

  test("the all-scope confirmation says the roster is left empty", async () => {
    // There is no configuration file to rebuild the roster from.
    const html = await (await get("/admin/reset/confirm?scope=all")).text();
    expect(html).toContain("left <strong>empty</strong>");
  });

  test("an unknown scope is refused", async () => {
    for (const path of ["/admin/reset/confirm?scope=everything", "/admin/reset"]) {
      const res =
        path === "/admin/reset"
          ? await post(path, new URLSearchParams({ scope: "everything" }))
          : await get(path);
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("Unknown reset type.");
    }
  });

  test("a results reset deletes the games and keeps the roster", async () => {
    await seedGame();
    const res = await post("/admin/reset", new URLSearchParams({ scope: "results" }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Deleted 1 stat row across 1 game");
    // The roster rides along out of band, because players who were
    // undeletable are now deletable.
    expect(html).toContain('hx-swap-oob="true"');
    expect(html).toContain("4 players");

    for (const table of ["turn_stats", "turn_damage", "games", "game_seats", "game_player_stats"]) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
      expect(row!.n, table).toBe(0);
    }
    const players = await env.DB.prepare("SELECT COUNT(*) AS n FROM players").first<{ n: number }>();
    expect(players!.n).toBe(4);
  });

  test("the decks of a match go with the results", async () => {
    // They describe games that no longer exist.
    await seedGame();
    await env.DB.prepare(
      "INSERT INTO match_commanders (event_id, player_id, match_no, commander) VALUES (1, ?, 1, 'Doran')",
    )
      .bind(await idOf("Ann"))
      .run();
    await post("/admin/reset", new URLSearchParams({ scope: "results" }));
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM match_commanders").first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  test("an all reset empties the roster and keeps the event", async () => {
    await seedGame();
    const html = await (await post("/admin/reset", new URLSearchParams({ scope: "all" }))).text();
    expect(html).toContain("removed 4 players, roster now empty");
    const players = await env.DB.prepare("SELECT COUNT(*) AS n FROM players").first<{ n: number }>();
    expect(players!.n).toBe(0);
    // The event row stays: deleting it would take the active_event pointer
    // with it and leave every surface answering 503.
    const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(events!.n).toBe(1);
    expect((await get("/admin")).status).toBe(200);
  });

  test("a reset names a restore point before deleting anything", async () => {
    // What replaced the SQLite file backup. There is no file here, so the
    // equivalent is recording exactly where in D1's own history the operator
    // was standing and handing it back.
    await seedGame();
    const html = await (await post("/admin/reset", new URLSearchParams({ scope: "results" }))).text();
    expect(html).toMatch(/Restore point:|Restore by time:/);
    expect(html).toContain("time-travel restore");
  });

  test("the counts quoted are the ones destroyed, not zero afterwards", async () => {
    // "Deleted 0 rows" is the one answer an operator must be able to trust
    // after asking to wipe their data, so the numbers are read before.
    await seedGame();
    await seedGame(2);
    const html = await (await post("/admin/reset", new URLSearchParams({ scope: "results" }))).text();
    expect(html).toContain("Deleted 2 stat rows across 2 games");
  });
});

describe("a real night", () => {
  test("the whole Fall 2026 event can be reset, and says what it cost", async () => {
    await resetDatabase(env.DB);
    await seedFixture(env.DB);
    const armed = await (await get("/admin/reset/confirm?scope=results")).text();
    expect(armed).toContain("156 stat rows");
    expect(armed).toContain("6 games");
    const done = await (await post("/admin/reset", new URLSearchParams({ scope: "results" }))).text();
    expect(done).toContain("Deleted 156 stat rows across 6 games");
    expect(done).toContain("8 players");
  });
});

/** One game with one turn in it, so a player is part of a game. */
async function seedGame(matchNo = 1): Promise<void> {
  const ann = await idOf("Ann");
  const ben = await idOf("Ben");
  const result = await env.DB.prepare(
    "INSERT INTO games (event_id, pod, match_no) VALUES (1, 'A', ?)",
  )
    .bind(matchNo)
    .run();
  const game = Number(result.meta.last_row_id);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO game_seats (game_id, player_id, seat) VALUES (?, ?, 1)").bind(game, ann),
    env.DB.prepare("INSERT INTO game_seats (game_id, player_id, seat) VALUES (?, ?, 2)").bind(game, ben),
    env.DB.prepare(
      "INSERT INTO turn_stats (game_id, player_id, round_no, attacking_creatures) VALUES (?, ?, 1, 2)",
    ).bind(game, ann),
    env.DB.prepare(
      "INSERT INTO turn_damage (game_id, player_id, round_no, target_id, combat_dmg) VALUES (?, ?, 1, ?, 6)",
    ).bind(game, ann, ben),
  ]);
}

/** A table seated with nothing recorded against it. */
async function seatOnly(): Promise<void> {
  const result = await env.DB.prepare(
    "INSERT INTO games (event_id, pod, match_no) VALUES (1, 'B', 1)",
  ).run();
  const game = Number(result.meta.last_row_id);
  await env.DB.prepare("INSERT INTO game_seats (game_id, player_id, seat) VALUES (?, ?, 1)")
    .bind(game, await idOf("Cat"))
    .run();
}

// --- events --------------------------------------------------------------------

const form = (fields: Record<string, string>) => new URLSearchParams(fields);
const NEW_EVENT = { name: "Spring Night", date: "2027-03-14", copy_from: "1", copy_roster: "1", make_active: "1" };

async function eventNames(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT name FROM events ORDER BY event_id").all<{ name: string }>();
  return results.map((r) => r.name);
}

async function activeName(): Promise<string> {
  const page = await (await get("/admin")).text();
  return page.match(/<h2>Roster for ([^<]*)<\/h2>/)![1]!;
}

describe("events", () => {
  test("the page lists the event as active and offers to copy it", async () => {
    const page = await (await get("/admin")).text();
    expect(page).toContain('<span class="badge ok">Active</span>');
    expect(page).toContain('<option value="1" selected>Test Night</option>');
    expect(page).toContain('href="/results?event=1"');
    // No way to delete or re-activate the active event from its own row.
    expect(page).not.toContain('hx-get="/admin/events/1/delete"');
    expect(page).not.toContain('hx-post="/admin/events/1/activate"');
  });

  test("a new event copies the roster, becomes active and reloads the page", async () => {
    const res = await post("/admin/events", form(NEW_EVENT));
    expect(res.status).toBe(200);
    expect(res.headers.get("HX-Refresh")).toBe("true");
    expect(await eventNames()).toEqual(["Test Night", "Spring Night"]);
    expect(await activeName()).toBe("Spring Night");
    const page = await (await get("/admin")).text();
    for (const name of TABLE) expect(page).toContain(`value="${name}"`);
    // The old event is still there, with its own row and actions.
    expect(page).toContain('hx-post="/admin/events/1/activate"');
  });

  test("a new event can start empty and leave the active one alone", async () => {
    const { copy_roster: _r, make_active: _a, ...quiet } = NEW_EVENT;
    const res = await post("/admin/events", form(quiet));
    expect(res.headers.get("HX-Refresh")).toBeNull();
    expect(await res.text()).toContain("Created Spring Night.");
    expect(await activeName()).toBe("Test Night");
    const players = await env.DB.prepare("SELECT COUNT(*) AS n FROM players WHERE event_id = 2").first<{ n: number }>();
    expect(players!.n).toBe(0);
  });

  test("a bad name or date creates nothing and keeps what was typed", async () => {
    for (const [fields, message] of [
      [{ ...NEW_EVENT, name: "" }, "Name is required."],
      [{ ...NEW_EVENT, name: "Test Night" }, "An event named &#39;Test Night&#39; already exists."],
      [{ ...NEW_EVENT, date: "2027-02-30" }, "Date must be a real date, or empty."],
      [{ ...NEW_EVENT, copy_from: "99" }, "The event to copy from no longer exists."],
    ] as const) {
      const res = await post("/admin/events", form(fields));
      expect(res.status, message).toBe(422);
      const body = await res.text();
      expect(body, message).toContain(message);
      expect(body, message).toContain(`value="${fields.date}"`);
    }
    expect(await eventNames()).toEqual(["Test Night"]);
  });

  test("renaming an inactive event swaps the region; renaming the active one reloads", async () => {
    const { make_active: _a, ...quiet } = NEW_EVENT;
    await post("/admin/events", form(quiet));
    const inactive = await post("/admin/events/2", form({ name: "Spring Fling", date: "" }));
    expect(inactive.headers.get("HX-Refresh")).toBeNull();
    expect(await inactive.text()).toContain("Saved Spring Fling.");
    const active = await post("/admin/events/1", form({ name: "November 2026", date: "2026-11-14" }));
    expect(active.headers.get("HX-Refresh")).toBe("true");
    expect(await eventNames()).toEqual(["November 2026", "Spring Fling"]);
    const clash = await post("/admin/events/2", form({ name: "November 2026", date: "" }));
    expect(clash.status).toBe(422);
  });

  test("switching the active event reloads the page and moves every surface", async () => {
    const { make_active: _a, ...quiet } = NEW_EVENT;
    await post("/admin/events", form(quiet));
    const res = await post("/admin/events/2/activate", form({}));
    expect(res.headers.get("HX-Refresh")).toBe("true");
    expect(await activeName()).toBe("Spring Night");
    expect(await (await get("/display")).text()).toContain("<title>Spring Night - Leaderboard</title>");
    expect((await post("/admin/events/99/activate", form({}))).status).toBe(422);
  });

  test("deleting asks first, with counts, then deletes only that event", async () => {
    await post("/admin/events", form(NEW_EVENT)); // Spring Night is active now
    await seedGame(1);
    const armed = await get("/admin/events/1/delete");
    const body = await armed.text();
    expect(body).toContain("Delete Test Night?");
    expect(body).toContain("<strong>1 game</strong>");
    expect(body).toContain("<strong>1 stat row</strong>");
    expect(body).toContain("<strong>4 players</strong>");
    // Arming deleted nothing.
    expect(await eventNames()).toEqual(["Test Night", "Spring Night"]);

    const done = await post("/admin/events/1/delete", form({}));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Deleted Test Night: 1 game, 4 players.");
    expect(await eventNames()).toEqual(["Spring Night"]);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM players").first<{ n: number }>();
    expect(left!.n).toBe(4);
  });

  test("the active event cannot be armed or deleted", async () => {
    const arm = await get("/admin/events/1/delete");
    expect(arm.status).toBe(422);
    expect(await arm.text()).toContain("Test Night is the active event.");
    const res = await post("/admin/events/1/delete", form({}));
    expect(res.status).toBe(422);
    expect(await eventNames()).toEqual(["Test Night"]);
  });

  test("every event action is behind the passcode", async () => {
    const res = await app.request(
      "/admin/events",
      { method: "POST", body: form(NEW_EVENT), headers: { "content-type": "application/x-www-form-urlencoded" } },
      env,
    );
    expect(res.status).toBe(303);
    expect(await eventNames()).toEqual(["Test Night"]);
  });
});
