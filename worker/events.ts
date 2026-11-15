// Telling the projected board that something changed.
//
// The one place every write path calls. The fan-out lives in a Durable Object
// (worker/board-do.ts) because Workers isolates do not share memory.
//
// The payload is the rendered board rather than a signal, so one render serves
// every screen, and it is the same function the page is built from: one
// definition of what the room sees.

import type { Context } from "hono";
import { activeEvent } from "./data.ts";
import { boardData } from "./routes/display.ts";
import { board } from "./views/display.ts";

/** The one object the whole event's screens attach to. */
export function boardStub(env: Env): DurableObjectStub {
  // Named, not a random id: every isolate has to reach the same one, and the
  // name is what makes that true without storing an id anywhere.
  return env.BOARD.get(env.BOARD.idFromName("display"));
}

/** The board as HTML, or null if there is no event to render. */
export async function renderBoard(db: D1Database): Promise<string | null> {
  const event = await activeEvent(db);
  if (!event) return null;
  const data = await boardData(db, event.event_id);
  if (!data) return null;
  return String(await board(data));
}

/**
 * Push the current board to every attached screen.
 *
 * Deliberately off the critical path. A tracker's Save should not wait on the
 * projector: the render is a handful of D1 reads and the push is another hop,
 * and a tracker with a table waiting notices 200ms far more than the room
 * notices the board arriving a moment later.
 *
 * waitUntil keeps the work alive after the response is returned. It is not
 * available in every context, so when it is missing the push is awaited
 * instead: a slower save is better than a board that never updates.
 */
export async function statsChanged(c: Context<{ Bindings: Env }>): Promise<void> {
  const push = async () => {
    const html = await renderBoard(c.env.DB);
    if (html === null) return;
    await boardStub(c.env).fetch("https://board.invalid/publish", {
      method: "POST",
      body: html,
    });
  };

  try {
    c.executionCtx.waitUntil(push());
  } catch {
    await push();
  }
}
