// The projected board's subscriber set, and the fan-out to it.
//
// The set lives in a Durable Object because Workers isolates do not share
// memory and are recycled. A subscriber set in module scope would hold only the
// subscribers that landed in the same isolate, and a save handled elsewhere
// would push to none of them: the board stops updating with no error.
//
// Nothing durable is stored. The subscribers are open connections and cannot
// outlive the object, and the board itself is derived from D1 on demand.

import { DurableObject } from "cloudflare:workers";

/** One connection. */
interface Subscriber {
  writer: WritableStreamDefaultWriter<Uint8Array>;
}

/**
 * How often to send a comment line down an idle stream.
 *
 * Without it an idle connection is closed somewhere between the browser and
 * here, and htmx's SSE extension reconnects,
 * which works but puts the board through "Reconnecting" on a quiet table.
 * Shorter than the shortest proxy idle timeout worth worrying about.
 */
const PING_MS = 25_000;

const encoder = new TextEncoder();

/**
 * One SSE frame.
 *
 * The payload is a rendered HTML partial, which has newlines in it, and SSE is
 * a line protocol: every line of the data has to carry its own `data:` prefix
 * or everything after the first newline is dropped. That is the detail that
 * silently truncates a board to its opening div.
 */
export function sseFrame(event: string, payload: string): string {
  const lines = payload.split("\n").map((line) => `data: ${line}`);
  return `event: ${event}\n${lines.join("\n")}\n\n`;
}

export class Board extends DurableObject<Env> {
  #subscribers = new Set<Subscriber>();
  /**
   * The last board pushed, so a browser that connects between saves gets the
   * current standings rather than nothing until the next one.
   */
  #last: string | null = null;
  #ping: ReturnType<typeof setInterval> | null = null;

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/subscribe") return await this.#subscribe(request);
    if (pathname === "/publish") return await this.#publish(request);
    if (pathname === "/subscribers") {
      // For tests and for a health check: how many screens are attached.
      return Response.json({ subscribers: this.#subscribers.size });
    }
    return new Response("not found", { status: 404 });
  }

  /**
   * Open a stream.
   *
   * The body is the board as the Worker rendered it just now, sent down the
   * new connection immediately so the projector is correct the instant the page
   * loads rather than blank until the next save.
   */
  async #subscribe(request: Request): Promise<Response> {
    const initial = (await request.text()) || this.#last || "";
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const subscriber: Subscriber = { writer };

    this.#subscribers.add(subscriber);
    this.#startPinging();

    if (initial) {
      this.#last = initial;
      // NOT awaited, and this is the whole trick. A TransformStream's readable
      // side has a highWaterMark of 0, so write() does not resolve until
      // somebody reads the other end -- and nobody can, because the stream is
      // the body of the Response this method has not returned yet. Awaiting it
      // deadlocks every connection.
      this.#send(subscriber, sseFrame("leaderboard", initial));
    }

    return new Response(readable, { headers: SSE_HEADERS });
  }

  /** Send a board to every attached screen. */
  async #publish(request: Request): Promise<Response> {
    const html = await request.text();
    this.#last = html;
    const sent = this.#subscribers.size;
    for (const s of [...this.#subscribers]) this.#send(s, sseFrame("leaderboard", html));
    // `sent` is how many screens the frame was handed to, not how many have
    // read it. Waiting for the reads would be worse than useless: an idle
    // projector does not pull until its browser gets round to it, so awaiting
    // would let one screen hold up the save that triggered this.
    return Response.json({ sent });
  }

  /**
   * Hand a frame to one screen, without waiting for it to be read.
   *
   * The write resolves when that connection's reader pulls, which is the
   * client's business and not ours. What we do care about is a write that
   * fails, which is how a closed connection announces itself, and that is the
   * normal way a subscriber ends rather than an error worth reporting.
   */
  #send(s: Subscriber, frame: string): void {
    s.writer.write(encoder.encode(frame)).catch(() => this.#drop(s));
  }

  #drop(s: Subscriber): void {
    this.#subscribers.delete(s);
    // .catch, not try/catch: close() returns a promise, and the connection we
    // are dropping is usually one that has already failed, so the close
    // rejects. A try/catch only sees a synchronous throw, which left an
    // unhandled rejection per dropped screen. Harmless in a browser, an error
    // in the runtime's logs here, and enough to fail a vitest run -- which is
    // how it was found, in CI rather than locally.
    s.writer.close().catch(() => {});
    if (this.#subscribers.size === 0 && this.#ping !== null) {
      clearInterval(this.#ping);
      this.#ping = null;
    }
  }

  #startPinging(): void {
    if (this.#ping !== null) return;
    this.#ping = setInterval(() => {
      // A comment line: valid SSE, ignored by the client, and enough to keep
      // the connection from being reaped. Also how a dead connection is
      // noticed at all on a table where nothing is being entered.
      for (const s of [...this.#subscribers]) this.#send(s, ": ping\n\n");
    }, PING_MS);
  }
}

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  // Nothing between here and the projector may buffer this.
  "cache-control": "no-cache, no-transform",
  // Cloudflare's own buffering, off for this response.
  "x-accel-buffering": "no",
} as const;
