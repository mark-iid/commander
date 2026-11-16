// The projected leaderboard. A standalone kiosk page: its own theme, no
// navigation, and nothing client-side but a clock and closing a prize's
// ranking.
//
// hono/html tagged templates rather than JSX: these are HTML with HTMX
// attributes on it. Interpolated values are escaped.

import { html } from "hono/html";
import type { Html } from "./html.ts";
import type { PlayerStanding, Prize, PrizeRankRow, PrizeResult } from "../../shared/scoring.ts";
import type { EventRow } from "../data.ts";
import { GAME_STAT_FIELDS } from "../fields.ts";
import { ICON_LINKS } from "./layout.ts";

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
export function board({ event, standings, prizes, gamesRecorded }: BoardData): Html {
  const claimed = prizes.filter((p) => p.winner).length;
  return html`<div id="board" sse-swap="leaderboard" hx-swap="outerHTML" data-event="${eventKey(event)}">
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
              (p) => html`<button
                type="button"
                class="prize nbi ${p.winner ? "" : "unclaimed"}"
                hx-get="/display/prize/${encodeURIComponent(p.key)}"
                hx-target="#prize-detail"
                hx-swap="innerHTML"
              >
                <span class="name">${p.name}</span>
                <span class="winner">${p.winner ?? "Unclaimed"}</span>
                <span class="value">${p.winner ? p.value : html`&nbsp;`}</span>
              </button>`,
            )}
          </div>`}
    </section>

  </div>
</div>`;
}

export interface PrizeDetailData {
  prize: Prize;
  result: PrizeResult;
  rows: PrizeRankRow[];
}

// Fields a prize or tiebreak can name that are not on the entry forms.
const OTHER_LABELS: Record<string, string> = {
  win_points: "Win points",
  total_damage: "Total damage",
  combat_dmg_taken: "Combat damage taken",
  creatures_attacked_with: "Creatures attacked with",
};

function fieldLabel(field: string): string {
  return GAME_STAT_FIELDS.find((f) => f.name === field)?.label ?? OTHER_LABELS[field] ?? field;
}

function scopeLabel(field: string, scope: "night" | "peak"): string {
  if (field === "win_points" || field === "total_damage") return "";
  return scope === "peak" ? ", best game" : ", night total";
}

/**
 * One prize's full ranking, opened over the board by clicking the prize.
 *
 * Refreshes itself on every push (hx-trigger sse:leaderboard), so it does not
 * go stale while it is open. Reuses the standings table's classes: the winner
 * gets the leader bar, a player who takes no prize is dimmed and tagged.
 */
export function prizeDetail({ prize, result, rows }: PrizeDetailData): Html {
  const tb = prize.tiebreak;
  return html`<section
  class="panel nb prize-detail"
  hx-get="/display/prize/${encodeURIComponent(prize.key)}"
  hx-trigger="sse:leaderboard"
  hx-swap="outerHTML"
>
  <div class="ptitle">
    <span>${prize.name}</span>
    <span>${prize.agg === "max" ? "Highest" : "Lowest"} wins</span>
  </div>
  ${rows.length === 0
    ? html`<span class="empty">Nobody has played yet.</span>`
    : html`<table class="standings" style="--rows: ${rows.length}">
        <thead>
          <tr>
            <th scope="col" class="rank">#</th>
            <th scope="col">Player</th>
            <th scope="col" class="pts">${fieldLabel(prize.metric)}${scopeLabel(prize.metric, prize.scope)}</th>
            ${tb
              ? html`<th scope="col" class="dmg">Tiebreak: ${fieldLabel(tb.field)}${scopeLabel(tb.field, tb.scope)}</th>`
              : ""}
          </tr>
        </thead>
        <tbody>
          ${rows.map(
            (r) => html`<tr class="${r.player === result.winner ? "leader" : r.eligible ? "" : "idle"}">
              <td class="rank">${r.rank}</td>
              <td class="name">${r.player}${r.eligible ? "" : html` <span class="tag">no prize</span>`}</td>
              <td class="pts">${r.value}</td>
              ${tb ? html`<td class="dmg">${r.tiebreak}</td>` : ""}
            </tr>`,
          )}
        </tbody>
      </table>`}
  <div class="hint">${result.winner ? "" : "Unclaimed. "}Click or press Esc to close</div>
</section>`;
}

/**
 * What the page header was rendered for. A pushed board only replaces #board,
 * so when the active event changes or is renamed the header, title and footer
 * are stale; the page compares this and reloads.
 */
function eventKey(event: EventRow): string {
  return `${event.event_id}:${event.name}`;
}

export function displayPage(data: BoardData): Html {
  const { event } = data;
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${event.name} - Leaderboard</title>
  ${ICON_LINKS}
  <!-- No content hash on these any more: see worker/assets.ts for what
       replaced it and what was verified. -->
  <link rel="stylesheet" href="/static/norton.css">
  <script src="/static/htmx.min.js"></script>
  <script src="/static/htmx-ext-sse.js" defer></script>
</head>
<body hx-ext="sse" sse-connect="/display/stream" data-event="${eventKey(event)}">

  <header id="hdr">
    <span class="site-title">${event.name}</span>
    <span class="hdr-right">
      <span class="clock" id="clock">--:--</span>
      <span class="dateline" id="dateline"></span>
    </span>
  </header>

  ${board(data)}

  <!-- A prize's full ranking is fetched into here when the prize is clicked.
       The prize buttons set hx-swap="innerHTML" explicitly: htmx attributes
       inherit, and #board's outerHTML would replace this container itself. -->
  <div id="prize-detail"></div>

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

    // A board for a different event, or a renamed one, means everything
    // outside #board is out of date. htmx:load, because the SSE extension
    // reports its message on the board it just replaced, which is detached
    // and bubbles nowhere.
    document.body.addEventListener("htmx:load", (e) => {
      if (e.target.id === "board" && e.target.dataset.event !== document.body.dataset.event) {
        location.reload();
      }
    });

    // Any click on an open ranking, or Escape, closes it.
    const detail = document.getElementById("prize-detail");
    detail.addEventListener("click", () => detail.replaceChildren());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") detail.replaceChildren();
    });

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
