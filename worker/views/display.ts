// The projected leaderboard. A standalone kiosk page: its own theme, no
// navigation to click, and nothing client-side but a clock.
//
// hono/html tagged templates rather than JSX: these are HTML with HTMX
// attributes on it. Interpolated values are escaped.

import { html } from "hono/html";
import type { Html } from "./html.ts";
import type { PlayerStanding, PrizeResult } from "../../shared/scoring.ts";
import type { EventRow } from "../data.ts";

export interface BoardData {
  event: EventRow;
  standings: [number, PlayerStanding][];
  prizes: PrizeResult[];
  gamesRecorded: number;
}

/**
 * The whole board.
 *
 * Carries its own #board wrapper with the sse-swap attributes, so an outerHTML
 * swap replaces it with an element that is still subscribed. Rendered inline on
 * first load and pushed verbatim on every save, so there is exactly one
 * definition of what the room sees.
 */
export function board({ standings, prizes, gamesRecorded }: BoardData): Html {
  const claimed = prizes.filter((p) => p.winner).length;
  return html`<div id="board" sse-swap="leaderboard" hx-swap="outerHTML">
  <div id="main">

    <section class="panel nb">
      <div class="ptitle">
        <span>Standings</span>
        <span>${gamesRecorded} game${gamesRecorded === 1 ? "" : "s"}</span>
      </div>
      <!-- --rows drives the row font-size in CSS. Without it the type is fixed
           and a 16-player roster runs off the bottom of a projected board that
           cannot scroll (body is overflow:hidden), silently hiding the last
           players. -->
      <table class="standings" style="--rows: ${standings.length || 1}">
        <thead>
          <tr>
            <th scope="col" class="rank">#</th>
            <th scope="col">Player</th>
            <th scope="col" class="pts">Pts</th>
            <th scope="col" class="dmg">Dmg</th>
          </tr>
        </thead>
        <tbody>
          ${standings.map(
            ([rank, s], i) => html`<tr
              class="${i === 0 && s.games_played ? "leader" : !s.games_played ? "idle" : ""}"
            >
              <!-- rank, not the row number: players tied on points and damage
                   share a number instead of being ordered by sort order alone. -->
              <td class="rank">${rank}</td>
              <td class="name">${s.player}</td>
              <td class="pts">${s.win_points}</td>
              <td class="dmg">${s.total_damage}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </section>

    <section class="panel nb">
      <div class="ptitle">
        <span>Prizes</span>
        <span>${claimed} of ${prizes.length} claimed</span>
      </div>
      ${prizes.length === 0
        ? html`<span class="empty">No prizes configured.</span>`
        : html`<div class="prizes">
            ${prizes.map(
              (p) => html`<div class="prize nbi ${p.winner ? "" : "unclaimed"}">
                <span class="name">${p.name}</span>
                <span class="winner">${p.winner ?? "Unclaimed"}</span>
                <span class="value">${p.winner ? p.value : html`&nbsp;`}</span>
              </div>`,
            )}
          </div>`}
    </section>

  </div>
</div>`;
}

export function displayPage(data: BoardData): Html {
  const { event } = data;
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${event.name} - Leaderboard</title>
  <!-- No content hash on these any more: see worker/assets.ts for what
       replaced it and what was verified. -->
  <link rel="stylesheet" href="/static/norton.css">
  <script src="/static/htmx.min.js"></script>
  <script src="/static/htmx-ext-sse.js" defer></script>
</head>
<body hx-ext="sse" sse-connect="/display/stream">

  <header id="hdr">
    <span class="site-title">${event.name}</span>
    <span class="hdr-right">
      <span class="clock" id="clock">--:--</span>
      <span class="dateline" id="dateline"></span>
    </span>
  </header>

  ${board(data)}

  <footer id="foot">
    <span class="live" id="live">Connecting</span>
    <span>${event.name} &middot; Round-robin, ${event.games_per_player} games</span>
  </footer>

  <script>
    // Clock. The only client-side state on this page: everything else is
    // server-rendered and pushed.
    function tick() {
      const now = new Date();
      document.getElementById("clock").textContent =
        now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      document.getElementById("dateline").textContent =
        now.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
    }
    tick();
    setInterval(tick, 1000);

    // Reflect the SSE connection in the status bar, so a dead projector feed is
    // visible in the room rather than silently frozen.
    const live = document.getElementById("live");
    document.body.addEventListener("htmx:sseOpen", () => {
      document.body.classList.remove("sse-down");
      document.body.classList.add("sse-up");
      live.textContent = "Live";
    });
    document.body.addEventListener("htmx:sseError", () => {
      document.body.classList.remove("sse-up");
      document.body.classList.add("sse-down");
      live.textContent = "Reconnecting";
    });
  </script>
</body>
</html>`;
}
