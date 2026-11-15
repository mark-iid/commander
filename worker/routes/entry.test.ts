// The entry surface, driven the way a tracker drives it.
//
// The rules are covered by worker/entry-rules.test.ts
// and the writes to real D1 (worker/entry-data.test.ts). What is left to get
// wrong is the surface itself: which form comes back, what it has in it, where
// the tracker lands after a save, and which mistakes are refused rather than
// recorded.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import app from "../index.ts";
import { TABLE, minimalEvent } from "../test/minimal.ts";
import { resetDatabase } from "../test/reset.ts";

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

async function post(path: string, body: URLSearchParams): Promise<Response> {
  return await app.request(
    path,
    {
      method: "POST",
      body,
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    },
    env,
  );
}

/** Seat a table in the order given. */
async function seat(names = TABLE, pod = "A", match = 1): Promise<Response> {
  const body = new URLSearchParams({ pod, match_no: String(match) });
  for (const n of names) body.append("seat", n);
  return await post("/entry/seat", body);
}

/** Save one turn. `damage` is keyed by seat number among this player's opponents. */
async function turn(
  player: string,
  opts: {
    round?: number;
    pod?: string;
    match?: number;
    damage?: Record<number, number>;
    table?: string;
  } & Record<string, unknown> = {},
): Promise<Response> {
  const { round = 1, pod = "A", match = 1, damage = {}, table, ...fields } = opts;
  const body = new URLSearchParams({
    pod,
    match_no: String(match),
    player,
    round_no: String(round),
  });
  if (table !== undefined) body.set("table", table);
  for (const [seatNo, dmg] of Object.entries(damage)) body.set(`dmg_${seatNo}`, String(dmg));
  for (const [k, v] of Object.entries(fields)) body.set(k, String(v));
  return await post("/entry/turn", body);
}

beforeEach(async () => {
  await resetDatabase(env.DB);
  await minimalEvent(env.DB);
  cookie = await signIn();
});

describe("the page", () => {
  test("it opens on the seating form for a table nobody has set", async () => {
    const res = await get("/entry");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("who is playing?");
    expect(page).toContain('id="selectors"');
    // Four seat selects for a pod of four, each offering the whole roster.
    expect((page.match(/<span>Seat \d<\/span>/g) ?? []).length).toBe(4);
    for (const name of TABLE) expect(page).toContain(name);
    // And the pod table says so rather than showing an empty grid.
    expect(page).toContain("This table has not been set yet.");
  });

  test("a stale pod or match falls back rather than 404ing", async () => {
    // The selectors are driven by the same lists, so an out-of-range value
    // means a stale tab, not a bad request.
    const res = await get("/entry?pod=Z&match_no=99");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Pod A &middot; Match 1");
  });
});

describe("seating a table", () => {
  test("it sets the table and lands on seat 1", async () => {
    const res = await seat();
    expect(res.status).toBe(200);
    const panel = await res.text();
    expect(panel).toContain("Table set");
    expect(panel).toContain('class="whose">Ann');
    expect(panel).toContain("New round 1");
    // Three damage boxes: the opponents, not the whole table.
    expect((panel.match(/name="dmg_\d"/g) ?? []).length).toBe(3);
    // And the address bar follows the tracker.
    expect(res.headers.get("HX-Replace-Url")).toContain("player=Ann");
  });

  test("seat order is turn order", async () => {
    const panel = await (await seat(["Dan", "Cat", "Ben", "Ann"])).text();
    expect(panel).toContain('class="whose">Dan');
  });

  test.for([
    { names: ["Ann", "Ben"], why: "a table seats 4" },
    { names: ["Ann", "Ann", "Ben", "Cat"], why: "the same player twice" },
    { names: ["Ann", "Ben", "Cat", "Nobody"], why: "not on the roster" },
  ])("$why is refused", async ({ names, why }) => {
    const res = await seat(names);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain(why);
  });

  test("a player already dealt to the other pod is refused", async () => {
    // Seating the same player twice in one match would give them two rows for
    // one game and quietly double their win points.
    await seat(["Ann", "Ben", "Cat", "Dan"], "A", 1);
    const res = await seat(["Ann", "Ben", "Cat", "Dan"], "B", 1);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("already seated at another pod this match");
  });

  test("clearing a table frees its players and keeps the turns", async () => {
    await seat();
    await turn("Ann", { damage: { 1: 7 } });
    const cleared = await post(
      "/entry/seat",
      new URLSearchParams({ pod: "A", match_no: "1", clear: "1" }),
    );
    expect(await cleared.text()).toContain("Table cleared");

    // Free for the other pod now.
    expect((await seat(TABLE, "B", 1)).status).toBe(200);
    // Seating them back at A needs B cleared first, because the same player
    // cannot be dealt into both pods of one match. That refusal is the rule
    // working; this is the swap the clear exists to make possible.
    await post("/entry/seat", new URLSearchParams({ pod: "B", match_no: "1", clear: "1" }));
    expect((await seat(TABLE, "A", 1)).status).toBe(200);
    const panel = await (await get("/entry/form?pod=A&match_no=1&player=Ann&round_no=1")).text();
    expect(panel).toContain('value="7"');
  });

  test("the seating form offers only players still free", async () => {
    await seat(["Ann", "Ben", "Cat", "Dan"], "A", 2);
    const page = await (await get("/entry?pod=B&match_no=2")).text();
    const form = page.slice(page.indexOf('class="card seating"'), page.indexOf("Set the table"));
    for (const name of TABLE) expect(form, name).not.toContain(`value="${name}"`);
  });
});

describe("saving a turn", () => {
  beforeEach(async () => {
    await seat();
  });

  test("it saves and advances to the next seat", async () => {
    const res = await turn("Ann", { damage: { 1: 5 }, attacking_creatures: 2 });
    expect(res.status).toBe(200);
    const panel = await res.text();
    expect(panel).toContain("Round 1 saved for Ann");
    // A tracker walking the table taps Save and lands on whoever plays next.
    expect(panel).toContain('class="whose">Ben');
    expect(res.headers.get("HX-Replace-Url")).toContain("player=Ben");
  });

  test("the last seat starts the next round", async () => {
    for (const name of TABLE) await turn(name, { round: 1 });
    const res = await turn("Dan", { round: 1 });
    const panel = await res.text();
    expect(panel).toContain('class="whose">Ann');
    expect(panel).toContain("New round 2");
  });

  test("a re-save corrects the row rather than adding one", async () => {
    await turn("Ann", { damage: { 1: 70 } });
    await turn("Ann", { damage: { 1: 7 } });
    const panel = await (await get("/entry/form?pod=A&match_no=1&player=Ann&round_no=1")).text();
    expect(panel).toContain("Editing round 1");
    expect(panel).toContain('value="7"');
    expect(panel).not.toContain('value="70"');
  });

  test("commander damage above the grid is refused", async () => {
    // It is combat damage, so it is already inside the grid. Typed only into
    // its own box it would leave combat damage, and every prize built on it,
    // short.
    const res = await turn("Ann", { damage: { 1: 3 }, cmdr_dmg_dealt: 10 });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("add it to the grid too");
  });

  test("more eliminations than opponents is refused", async () => {
    const res = await turn("Ann", { opps_eliminated: 4 });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("only 3 opponents at this table");
  });

  test("a word in a number box is refused, under that box", async () => {
    const res = await turn("Ann", { attacking_creatures: "two" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("whole numbers only");
  });

  test("a form drawn before a reseat is refused rather than misfiled", async () => {
    // The damage boxes are numbered by seat, so each number would land on
    // whoever sits in that seat now.
    const res = await turn("Ann", { damage: { 1: 9 }, table: "Ben|Cat|Nobody" });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("the table changed since this form opened");
  });

  test("a form carrying the right table is accepted", async () => {
    const res = await turn("Ann", { damage: { 1: 9 }, table: "Ben|Cat|Dan" });
    expect(res.status).toBe(200);
  });

  test("a blank box means zero, not an error", async () => {
    // Most boxes on most turns, and typing a zero forty times a game is how
    // trackers stop entering turns at all.
    const body = new URLSearchParams({
      pod: "A",
      match_no: "1",
      player: "Ann",
      round_no: "1",
      attacking_creatures: "",
      cmdr_dmg_dealt: "",
      noncombat_dmg_dealt: "",
      opps_eliminated: "",
    });
    expect((await post("/entry/turn", body)).status).toBe(200);
  });
});

describe("the autosave", () => {
  beforeEach(async () => {
    await seat();
  });

  test("it keeps the numbers and moves nothing", async () => {
    const body = new URLSearchParams({
      pod: "A",
      match_no: "1",
      player: "Ann",
      round_no: "1",
      attacking_creatures: "3",
      dmg_1: "6",
    });
    const res = await post("/entry/turn/draft", body);
    expect(res.status).toBe(200);
    const html = await res.text();
    // One out-of-band status line, so nothing else on the panel moves under
    // the tracker's thumb.
    expect(html).toContain('hx-swap-oob="true"');
    expect(html).toContain("Kept Ann round 1");
    expect(html).not.toContain("turn-form");

    // And the numbers really are kept.
    const panel = await (await get("/entry/form?pod=A&match_no=1&player=Ann&round_no=1")).text();
    expect(panel).toContain('value="3"');
    expect(panel).toContain('value="6"');
  });

  test("it does not apply the cross-field rules", async () => {
    // A turn halfway through being typed breaks them innocently: the commander
    // damage box filled in before the grid it belongs in. Refusing those
    // numbers is the very thing the autosave was added to stop.
    const body = new URLSearchParams({
      pod: "A",
      match_no: "1",
      player: "Ann",
      round_no: "1",
      cmdr_dmg_dealt: "10",
    });
    const res = await post("/entry/turn/draft", body);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Kept Ann round 1");
  });

  test("a failure says so, and still answers 200", async () => {
    // A silent autosave that quietly failed would be worse than none: the
    // tracker would switch player believing the numbers were safe. And a 4xx
    // would trip the "Not saved" banner meant for a lost connection.
    const body = new URLSearchParams({
      pod: "A",
      match_no: "1",
      player: "Ann",
      round_no: "1",
      attacking_creatures: "lots",
    });
    const res = await post("/entry/turn/draft", body);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("not kept");
    expect(html).toContain("whole numbers only");
    expect(html).toContain("bad");
  });

  test("Save then rewrites the same row", async () => {
    await post(
      "/entry/turn/draft",
      new URLSearchParams({
        pod: "A",
        match_no: "1",
        player: "Ann",
        round_no: "1",
        attacking_creatures: "3",
      }),
    );
    await turn("Ann", { round: 1, attacking_creatures: 5 });
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n, MAX(attacking_creatures) AS a FROM turn_stats",
    ).first<{ n: number; a: number }>();
    expect(row!.n).toBe(1);
    expect(row!.a).toBe(5);
  });
});

describe("recording a finish", () => {
  beforeEach(async () => {
    await seat();
  });

  test("a death is recorded and the tracker goes back to the table", async () => {
    const res = await post(
      "/entry/final",
      new URLSearchParams({
        pod: "A",
        match_no: "1",
        player: "Dan",
        placement: "4",
        final_life: "-3",
        total_graveyard: "11",
      }),
    );
    expect(res.status).toBe(200);
    const panel = await res.text();
    expect(panel).toContain("Dan finished 4th");
    // Not left on a player who will not take another turn.
    expect(panel).not.toContain('class="whose">Dan<');
  });

  test("a placement this event does not score is refused", async () => {
    const res = await post(
      "/entry/final",
      new URLSearchParams({
        pod: "A",
        match_no: "1",
        player: "Dan",
        placement: "9",
        final_life: "0",
        total_graveyard: "0",
      }),
    );
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("placement must be one of 1, 2, 3, 4");
  });

  test("a correction with no placement stays on the player", async () => {
    const res = await post(
      "/entry/final",
      new URLSearchParams({
        pod: "A",
        match_no: "1",
        player: "Ann",
        placement: "",
        final_life: "12",
        total_graveyard: "4",
      }),
    );
    expect(await res.text()).toContain("Ann updated");
    expect(res.headers.get("HX-Replace-Url")).toContain("player=Ann");
  });

  test("a negative life is accepted", async () => {
    const res = await post(
      "/entry/final",
      new URLSearchParams({
        pod: "A",
        match_no: "1",
        player: "Dan",
        placement: "4",
        final_life: "-9997",
        total_graveyard: "0",
      }),
    );
    expect(res.status).toBe(200);
  });
});

describe("the who-went-out form", () => {
  beforeEach(async () => {
    await seat();
  });

  test("a credited kill raises it, and recording the death removes it", async () => {
    const after = await (await turn("Ann", { damage: { 3: 40 }, opps_eliminated: 1 })).text();
    expect(after).toContain("Who went out?");
    expect(after).toContain("1 to record");

    const saved = await post(
      "/entry/eliminations",
      (() => {
        const b = new URLSearchParams({ pod: "A", match_no: "1", round_no: "1" });
        b.append("player", "Dan");
        b.append("final_life", "-5");
        b.append("total_graveyard", "7");
        return b;
      })(),
    );
    const panel = await saved.text();
    expect(panel).toContain("Dan finished 4th");
    expect(panel).not.toContain("Who went out");
  });

  test("two at once are ranked by life when simultaneous is ticked", async () => {
    await turn("Ann", { damage: { 2: 20, 3: 20 }, opps_eliminated: 2 });
    const b = new URLSearchParams({
      pod: "A",
      match_no: "1",
      round_no: "1",
      simultaneous: "1",
    });
    b.append("player", "Cat");
    b.append("final_life", "-1");
    b.append("total_graveyard", "3");
    b.append("player", "Dan");
    b.append("final_life", "-9");
    b.append("total_graveyard", "5");
    const panel = await (await post("/entry/eliminations", b)).text();
    // Lowest life went out first and takes the worst placement.
    expect(panel).toContain("Dan finished 4th");
    expect(panel).toContain("Cat finished 3rd");
  });

  test("equal lives tie and share the better placement", async () => {
    await turn("Ann", { damage: { 2: 20, 3: 20 }, opps_eliminated: 2 });
    const b = new URLSearchParams({
      pod: "A",
      match_no: "1",
      round_no: "1",
      simultaneous: "1",
    });
    b.append("player", "Cat");
    b.append("final_life", "-5");
    b.append("total_graveyard", "3");
    b.append("player", "Dan");
    b.append("final_life", "-5");
    b.append("total_graveyard", "5");
    const panel = await (await post("/entry/eliminations", b)).text();
    expect(panel).toContain("Cat finished 3rd");
    expect(panel).toContain("Dan finished 3rd");
    expect(panel).not.toContain("finished 4th");
  });

  test("a row left on nobody is skipped", async () => {
    // A tracker offered two rows because two kills were credited may only know
    // one of the deaths yet.
    await turn("Ann", { damage: { 2: 20, 3: 20 }, opps_eliminated: 2 });
    const b = new URLSearchParams({ pod: "A", match_no: "1", round_no: "1" });
    b.append("player", "Dan");
    b.append("final_life", "-5");
    b.append("total_graveyard", "7");
    b.append("player", "");
    b.append("final_life", "");
    b.append("total_graveyard", "");
    const panel = await (await post("/entry/eliminations", b)).text();
    expect(panel).toContain("Dan finished 4th");
    // One death left outstanding, so the form is still there.
    expect(panel).toContain("Who went out");
  });

  test("listing everybody still playing is refused", async () => {
    // The derived placements would run down to the best one and hand it to a
    // player who is dead: the app inventing a winner for a game that had none.
    // Three of four leaves one standing and is allowed, so it takes all four.
    await turn("Ann", { damage: { 1: 10, 2: 10, 3: 10 }, opps_eliminated: 3 });
    const b = new URLSearchParams({ pod: "A", match_no: "1", round_no: "1" });
    for (const [name, life] of [
      ["Ann", "-4"],
      ["Ben", "-1"],
      ["Cat", "-2"],
      ["Dan", "-3"],
    ] as const) {
      b.append("player", name);
      b.append("final_life", life);
      b.append("total_graveyard", "0");
    }
    const res = await post("/entry/eliminations", b);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("leave nobody standing");
  });

  test("a bad digit keeps the other boxes", async () => {
    // Nine boxes is too many to retype over one bad digit.
    await turn("Ann", { damage: { 3: 40 }, opps_eliminated: 1 });
    const b = new URLSearchParams({ pod: "A", match_no: "1", round_no: "1" });
    b.append("player", "Dan");
    b.append("final_life", "minus five");
    b.append("total_graveyard", "7");
    const res = await post("/entry/eliminations", b);
    expect(res.status).toBe(422);
    const panel = await res.text();
    expect(panel).toContain("whole numbers only");
    expect(panel).toContain('value="7"');
    expect(panel).toContain('value="minus five"');
  });

  test("somebody already out is refused, with where to fix it", async () => {
    await turn("Ann", { damage: { 3: 40 }, opps_eliminated: 1 });
    const first = new URLSearchParams({ pod: "A", match_no: "1", round_no: "1" });
    first.append("player", "Dan");
    first.append("final_life", "-5");
    first.append("total_graveyard", "7");
    await post("/entry/eliminations", first);

    await turn("Ben", { damage: { 2: 40 }, opps_eliminated: 1, round: 1 });
    const again = new URLSearchParams({ pod: "A", match_no: "1", round_no: "1" });
    again.append("player", "Dan");
    again.append("final_life", "-6");
    again.append("total_graveyard", "8");
    const res = await post("/entry/eliminations", again);
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("already recorded out");
  });

  test("the winner's numbers are asked for in the same form", async () => {
    // When the deaths would leave one player standing, the game is over and
    // the winner's three numbers are the ones a tracker would otherwise have
    // to come back for after the table has broken up.
    await post(
      "/entry/final",
      new URLSearchParams({
        pod: "A",
        match_no: "1",
        player: "Dan",
        placement: "4",
        final_life: "-1",
        total_graveyard: "1",
      }),
    );
    await post(
      "/entry/final",
      new URLSearchParams({
        pod: "A",
        match_no: "1",
        player: "Cat",
        placement: "3",
        final_life: "-2",
        total_graveyard: "2",
      }),
    );
    const panel = await (await turn("Ann", { damage: { 1: 40 }, opps_eliminated: 1 })).text();
    expect(panel).toContain("and the winner");
    expect(panel).toContain('name="winner"');

    const b = new URLSearchParams({ pod: "A", match_no: "1", round_no: "1", winner: "Ann" });
    b.append("player", "Ben");
    b.append("final_life", "-4");
    b.append("total_graveyard", "9");
    b.set("winner_life", "17");
    b.set("winner_graveyard", "12");
    const saved = await (await post("/entry/eliminations", b)).text();
    expect(saved).toContain("Ben finished 2nd");
    expect(saved).toContain("Ann won");
  });
});

describe("a whole game, played through the forms", () => {
  test("the standings come out of it", async () => {
    await seat();
    // Round one: Ann hits Dan for lethal and is credited the kill.
    await turn("Ann", { round: 1, damage: { 3: 40 }, attacking_creatures: 3, opps_eliminated: 1 });
    const b = new URLSearchParams({ pod: "A", match_no: "1", round_no: "1" });
    b.append("player", "Dan");
    b.append("final_life", "-2");
    b.append("total_graveyard", "14");
    await post("/entry/eliminations", b);

    // Ben kills Cat. Three were still in, so Cat finishes 3rd and two remain:
    // the form offers no winner row yet, because a winner is only due when the
    // outstanding deaths would leave one player standing.
    await turn("Ben", { round: 1, damage: { 2: 41 }, attacking_creatures: 2, opps_eliminated: 1 });
    const c2 = new URLSearchParams({ pod: "A", match_no: "1", round_no: "1" });
    c2.append("player", "Cat");
    c2.append("final_life", "-1");
    c2.append("total_graveyard", "9");
    const third = await (await post("/entry/eliminations", c2)).text();
    expect(third).toContain("Cat finished 3rd");
    expect(third).not.toContain("and the winner");

    // Round two: Ann kills Ben, which ends it. Now one death is due and it
    // would leave one player standing, so the winner's numbers are asked for
    // in the same form.
    const lethal = await (
      await turn("Ann", { round: 2, damage: { 1: 60 }, attacking_creatures: 4, opps_eliminated: 1 })
    ).text();
    expect(lethal).toContain("and the winner");

    const c3 = new URLSearchParams({ pod: "A", match_no: "1", round_no: "2", winner: "Ann" });
    c3.append("player", "Ben");
    c3.append("final_life", "-6");
    c3.append("total_graveyard", "12");
    c3.set("winner_life", "25");
    c3.set("winner_graveyard", "6");
    const done = await (await post("/entry/eliminations", c3)).text();
    expect(done).toContain("Ben finished 2nd");
    expect(done).toContain("Ann won");

    // The display agrees, on this event's placement_points: 1st is 4 points,
    // 2nd 3, 3rd 2, 4th 1.
    const board = await (await get("/display")).text();
    const points = Object.fromEntries(
      [...board.matchAll(/<td class="name">([^<]+)<\/td>\s*<td class="pts">(\d+)<\/td>/g)].map(
        (m) => [m[1], Number(m[2])],
      ),
    );
    expect(points).toEqual({ Ann: 4, Ben: 3, Cat: 2, Dan: 1 });
    // And the pod table counts finishers, not rows.
    const panel = await (await get("/entry?pod=A&match_no=1")).text();
    expect(panel).toContain("4 of 4 finished");
  });
});
