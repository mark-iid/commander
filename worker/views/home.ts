// The landing page: which event is on, who is leading it, and a way into each
// surface.

import { html } from "hono/html";
import type { Html } from "./html.ts";
import { layout } from "./layout.ts";

export interface HomeData {
  event: { name: string; date: string | null } | null;
  gamesRecorded: number;
  players: number;
  /** Top of the standings, shared ranks included; null when the board is not public to this visitor. */
  leaders: { rank: number; player: string; points: number }[] | null;
  prizesClaimed: number;
  prizesTotal: number;
  /** Surfaces that will ask this visitor for the passcode. */
  locked: string[];
}

const SURFACES = [
  { path: "/display", name: "Display", about: "The projected leaderboard and prizes. Click a prize for its full ranking." },
  { path: "/entry", name: "Entry", about: "Seat a table, record each turn, and log eliminations." },
  { path: "/results", name: "Results", about: "The full results sheet, with CSV exports." },
  { path: "/admin", name: "Admin", about: "Events, the roster, and resets." },
];

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/** "2026-11-14" as "14 November 2026". The date is a calendar day, so read it as UTC. */
function longDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export function homePage(d: HomeData): Html {
  const meta = d.event
    ? [
        ...(d.event.date ? [longDate(d.event.date)] : []),
        plural(d.players, "player"),
        plural(d.gamesRecorded, "game") + " recorded",
      ].join(" · ")
    : "";

  const hero = d.event
    ? html`<section class="card home-hero">
  <h1>${d.event.name}</h1>
  <p class="home-meta">${meta}</p>
  ${d.leaders === null
    ? ""
    : d.leaders.length === 0
      ? html`<p class="empty">No games recorded yet.</p>`
      : html`<ol class="home-leaders">
    ${d.leaders.map(
      (l) => html`<li class="${l.rank === 1 ? "first" : ""}"><span class="rank">${l.rank}</span><span class="name">${l.player}</span><span class="pts">${l.points} pts</span></li>`,
    )}
  </ol>
  <p class="hint">${d.prizesClaimed} of ${d.prizesTotal} prizes claimed</p>`}
</section>`
    : html`<section class="card home-hero">
  <h1>No event yet</h1>
  <p class="empty">No event is configured in the database.</p>
</section>`;

  return layout(
    html`${hero}
<nav class="home-surfaces" aria-label="Surfaces">
  ${SURFACES.map(
    (s) => html`<a class="card surface" href="${s.path}">
    <span class="card-head"><span class="surface-name">${s.name}</span>${d.locked.includes(s.path) ? html`<span class="badge">Passcode</span>` : ""}</span>
    <span class="surface-about">${s.about}</span>
  </a>`,
  )}
</nav>`,
    { title: d.event ? `${d.event.name} · Commander Tracker` : "Commander Tracker" },
  );
}
