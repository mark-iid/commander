// The SSE fan-out.
//
// The projector is the one screen nobody touches all evening, so the failure
// to design against is not an error but silence: a board that stops updating
// and looks exactly like a board where nothing has happened.

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import app from "./index.ts";
import { sseFrame } from "./board-do.ts";
import { boardStub } from "./events.ts";
import { resetDatabase } from "./test/reset.ts";
import { fixture, seedFixture } from "./test/seed.ts";

const PASSCODE = "test-passcode";

/**
 * A reader over a live SSE body.
 *
 * Held across reads rather than created per call, because cancelling a reader
 * closes the connection: a helper that tidied up after itself made the first
 * read work and every later one return nothing, which looks exactly like a
 * push that never arrived.
 */
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: string[] = [];

  /** Read until `want` more complete frames have arrived, or time runs out. */
  async function frames(want = 1, ms = 3000): Promise<string[]> {
    const deadline = Date.now() + ms;
    while (pending.length < want && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now())),
        ),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      // Frames are separated by a blank line.
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        pending.push(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
      }
    }
    return pending.splice(0, want);
  }

  // Cancelling a reader on a stream that has already errored rejects, and an
  // unhandled rejection fails the whole run.
  return { frames, close: () => void reader.cancel().catch(() => {}) };
}

/** The HTML out of a `leaderboard` frame, with the SSE framing removed. */
function payloadOf(frame: string): string {
  const lines = frame.split("\n");
  expect(lines[0]).toBe("event: leaderboard");
  return lines
    .slice(1)
    .map((l) => {
      expect(l.startsWith("data: "), `line not prefixed: ${l}`).toBe(true);
      return l.slice("data: ".length);
    })
    .join("\n");
}

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

describe("the frame format", () => {
  test("every line of the payload carries its own data prefix", () => {
    // SSE is a line protocol. Without the per-line prefix everything after the
    // first newline is dropped, which truncates the board to its opening div
    // and looks like a rendering bug rather than a protocol one.
    const frame = sseFrame("leaderboard", "<div>\n  <span>one</span>\n</div>");
    expect(frame).toBe(
      "event: leaderboard\ndata: <div>\ndata:   <span>one</span>\ndata: </div>\n\n",
    );
  });

  test("a single-line payload still ends with a blank line", () => {
    // The blank line is what tells the client the frame is complete; without
    // it the board never arrives at all.
    expect(sseFrame("leaderboard", "<div/>")).toBe("event: leaderboard\ndata: <div/>\n\n");
  });

  test("an empty payload is still a well-formed frame", () => {
    expect(sseFrame("leaderboard", "")).toBe("event: leaderboard\ndata: \n\n");
  });
});

describe("the stream", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
    await seedFixture(env.DB);
  });

  test("it answers as an event stream that nothing may buffer", async () => {
    const res = await app.request("/display/stream", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    // Cloudflare's own buffering, and anything else that honours the header.
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    void res.body?.cancel().catch(() => {});
  });

  test("a screen that connects between saves gets the current board", async () => {
    // The projector is correct the instant the page loads rather than blank
    // until somebody saves something.
    const res = await app.request("/display/stream", {}, env);
    const stream = sseReader(res);
    const [frame] = await stream.frames();
    const html = payloadOf(frame!);
    stream.close();
    expect(html).toContain('id="board"');
    // The real night's winners, not an empty board.
    for (const prize of fixture.expected.prizes) {
      expect(html, prize.key).toContain(prize.winner!);
    }
  });

  test("the pushed board is the same partial the page is built from", async () => {
    // One definition of what the room sees.
    const page = await (await app.request("/display", {}, env)).text();
    const res = await app.request("/display/stream", {}, env);
    const stream = sseReader(res);
    const [frame] = await stream.frames();
    const pushed = payloadOf(frame!);
    stream.close();
    const inPage = page.slice(page.indexOf('<div id="board"'), page.lastIndexOf("</div>") + 6);
    // Compared on content rather than byte for byte: the page wraps the same
    // partial, so the standings rows have to match exactly.
    const rows = (s: string) => [...s.matchAll(/<td class="name">([^<]+)<\/td>/g)].map((m) => m[1]);
    expect(rows(pushed)).toEqual(rows(inPage));
    expect(rows(pushed).length).toBe(8);
  });

  test("no event answers 503 rather than an empty stream", async () => {
    // An empty stream is indistinguishable from a working one with nothing
    // happening, which is the whole failure mode to avoid.
    await resetDatabase(env.DB);
    const res = await app.request("/display/stream", {}, env);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("No event configured");
  });
});

describe("the fan-out", () => {
  beforeEach(async () => {
    await resetDatabase(env.DB);
    await seedFixture(env.DB);
  });

  test("a save reaches an open stream", async () => {
    const cookie = await signIn();
    const res = await app.request("/display/stream", {}, env);
    const stream = sseReader(res);
    expect((await stream.frames()).length).toBe(1);

    // Rename a player through admin, which is the cheapest change that alters
    // the board.
    const id = (
      await env.DB.prepare("SELECT player_id FROM players WHERE name = 'Alice'").first<{
        player_id: number;
      }>()
    )!.player_id;
    await app.request(
      `/admin/players/${id}`,
      {
        method: "POST",
        body: new URLSearchParams({ name: "Alicia", prize_eligible: "0" }),
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      },
      env,
    );

    const next = await stream.frames();
    expect(next.length, "no push arrived").toBe(1);
    expect(payloadOf(next[0]!)).toContain("Alicia");
    stream.close();
  });

  test("every attached screen gets it", async () => {
    const cookie = await signIn();
    const a = sseReader(await app.request("/display/stream", {}, env));
    const b = sseReader(await app.request("/display/stream", {}, env));
    await Promise.all([a.frames(), b.frames()]);

    const id = (
      await env.DB.prepare("SELECT player_id FROM players WHERE name = 'Bob'").first<{
        player_id: number;
      }>()
    )!.player_id;
    await app.request(
      `/admin/players/${id}`,
      {
        method: "POST",
        body: new URLSearchParams({ name: "Bobby", prize_eligible: "1" }),
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      },
      env,
    );

    const [fa, fb] = await Promise.all([a.frames(), b.frames()]);
    expect(payloadOf(fa[0]!)).toContain("Bobby");
    expect(payloadOf(fb[0]!)).toContain("Bobby");
    a.close();
    b.close();
  });

  test("a screen that has gone away is dropped and does not break the rest", async () => {
    // A projector unplugged mid-event must not stop the board updating for the
    // tracker watching it on a phone.
    const gone = sseReader(await app.request("/display/stream", {}, env));
    await gone.frames();
    gone.close();

    const alive = sseReader(await app.request("/display/stream", {}, env));
    await alive.frames();

    const stub = boardStub(env);
    const res = await stub.fetch("https://board.invalid/publish", {
      method: "POST",
      body: "<div id=\"board\">pushed</div>",
    });
    expect(res.status).toBe(200);

    const frames = await alive.frames();
    expect(payloadOf(frames[0]!)).toContain("pushed");
    alive.close();
  });

  test("the push goes through waitUntil when there is one", async () => {
    // Production hands the push to waitUntil so a tracker's Save does not wait
    // on the projector. Every other test here takes the fallback branch
    // instead, because app.request without an execution context makes
    // c.executionCtx throw: that is the branch that keeps the board updating
    // where waitUntil is unavailable, and it would be the only branch tested.
    const cookie = await signIn();
    const stream = sseReader(await app.request("/display/stream", {}, env));
    await stream.frames();

    const deferred: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => deferred.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;

    const id = (
      await env.DB.prepare("SELECT player_id FROM players WHERE name = 'Carol'").first<{
        player_id: number;
      }>()
    )!.player_id;
    const res = await app.request(
      `/admin/players/${id}`,
      {
        method: "POST",
        body: new URLSearchParams({ name: "Caroline", prize_eligible: "1" }),
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      },
      env,
      ctx,
    );
    expect(res.status).toBe(200);

    // Deferred, not done: that is the point of it being off the critical path.
    expect(deferred.length).toBe(1);
    await Promise.all(deferred);

    const frames = await stream.frames();
    expect(frames.length, "no push arrived").toBe(1);
    expect(payloadOf(frames[0]!)).toContain("Caroline");
    stream.close();
  });

  test("the object counts what is attached", async () => {
    const before = await (await boardStub(env).fetch("https://board.invalid/subscribers")).json<{
      subscribers: number;
    }>();
    const res = await app.request("/display/stream", {}, env);
    const stream = sseReader(res);
    await stream.frames();
    const after = await (await boardStub(env).fetch("https://board.invalid/subscribers")).json<{
      subscribers: number;
    }>();
    expect(after.subscribers).toBe(before.subscribers + 1);
    stream.close();
  });
});
