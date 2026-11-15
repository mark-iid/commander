// The results sheet: the take-home record of a night, laid out for paper as
// much as for screen. The PDF comes from the browser's own print dialog, which
// keeps the event's look and costs no rendering dependency.
//

import { html } from "hono/html";
import { GAME_STAT_FIELDS } from "../fields.ts";
import type { GamePlayerStat, PlayerStanding, PrizeResult } from "../../shared/scoring.ts";
import type { EventRow } from "../data.ts";
import type { Html } from "./html.ts";
import { layout } from "./layout.ts";

export interface Matrix {
  players: string[];
  /** dealer -> target -> combat damage. */
  cell: Map<string, Map<string, number>>;
  dealt: Map<string, number>;
  taken: Map<string, number>;
  /** A match where nobody connected renders as a wall of zeros that says
   *  nothing, so the sheet omits the grid entirely instead. */
  any: boolean;
}

export interface Section {
  match_no: number;
  pod: string;
  rows: GamePlayerStat[];
  matrix: Matrix | undefined;
  /** Keyed by name alone, since a section is already one match. */
  commanders: Map<string, string>;
}

export interface ResultsData {
  event: EventRow;
  generated: string;
  standings: [number, PlayerStanding][];
  prizes: PrizeResult[];
  sections: Section[];
  rowsRecorded: number;
  rowsExpected: number;
  complete: boolean;
  playersStarted: number;
  rosterSize: number;
}

const stat = (s: GamePlayerStat, name: string): number =>
  (s as unknown as Record<string, number>)[name] ?? 0;

function matrixTable(m: Matrix): Html {
  const total = [...m.dealt.values()].reduce((a, b) => a + b, 0);
  return html`<table class="sheet-table matrix">
            <caption>Combat damage dealt, by opponent</caption>
            <thead>
              <tr>
                <th>Dealt by &darr; / to &rarr;</th>
                ${m.players.map((name) => html`<th class="num">${name}</th>`)}
                <th class="num total">Dealt</th>
              </tr>
            </thead>
            <tbody>
              ${m.players.map(
                (dealer) => html`<tr>
                  <th scope="row">${dealer}</th>
                  ${m.players.map((target) => {
                    if (target === dealer) return html`<td class="num self">&mdash;</td>`;
                    const v = m.cell.get(dealer)?.get(target) ?? 0;
                    return html`<td class="num${v ? "" : " zero"}">${v}</td>`;
                  })}
                  <td class="num total">${m.dealt.get(dealer) ?? 0}</td>
                </tr>`,
              )}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Taken</th>
                ${m.players.map(
                  (name) => html`<td class="num total">${m.taken.get(name) ?? 0}</td>`,
                )}
                <td class="num total">${total}</td>
              </tr>
            </tfoot>
          </table>`;
}

export function resultsPage(d: ResultsData): Html {
  const yetToPlay = d.rosterSize - d.playersStarted;
  const content = html`<article class="results">

  <!-- The sheet has to say how much of the night it covers. A snapshot after
       one round and the final standings look identical otherwise, and the
       difference matters to anyone reading it later. -->
  <header class="sheet-head">
    <h1>${d.event.name} &mdash; Results</h1>
    <p class="sheet-meta">
      ${d.complete
        ? html`Final results &middot; ${d.rosterSize} players &middot;
          ${d.event.games_per_player} games each`
        : html`<strong>Provisional</strong> &mdash; ${d.rowsRecorded} of ${d.rowsExpected}
          player-games recorded${yetToPlay > 0
            ? html`, ${yetToPlay} player${yetToPlay === 1 ? "" : "s"} yet to play`
            : ""}`}
      &middot; generated ${d.generated}
    </p>
  </header>

  <!-- Screen only: on paper these are a button that cannot be pressed. -->
  <div class="sheet-actions">
    <button type="button" onclick="window.print()">Save as PDF</button>
    <a class="button-link" href="/results.csv">Download CSV</a>
    <a class="button-link" href="/results/turns.csv">Download turns CSV</a>
    <span class="hint">Save as PDF opens your browser's print dialog &mdash; choose
    &ldquo;Save as PDF&rdquo; as the destination. The turns CSV has one row per player per
    turn, with damage broken out per opponent.</span>
  </div>

  <section class="sheet-section">
    <h2>Standings</h2>
    <table class="sheet-table">
      <thead>
        <tr>
          <th class="num">#</th>
          <th>Player</th>
          <th class="num">Win points</th>
          <th class="num">Combat damage</th>
          <th class="num">Games</th>
        </tr>
      </thead>
      <tbody>
        ${d.standings.map(
          ([rank, s], i) => html`<tr class="${i === 0 && s.games_played ? "winner-row" : ""}">
            <!-- Shared rank on a tie; see rankedStandings. -->
            <td class="num">${rank}</td>
            <td>${s.player}</td>
            <td class="num">${s.win_points}</td>
            <td class="num">${s.total_damage}</td>
            <td class="num">${s.games_played}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </section>

  <section class="sheet-section">
    <h2>Awards</h2>
    <table class="sheet-table">
      <thead>
        <tr><th>Award</th><th>Winner</th><th class="num">Value</th></tr>
      </thead>
      <tbody>
        ${d.prizes.map(
          (p) => html`<tr class="${p.winner ? "" : "unclaimed"}">
            <td>${p.name}</td>
            <td>${p.winner ?? html`&mdash;`}</td>
            <td class="num">${p.winner ? p.value : ""}</td>
          </tr>`,
        )}
      </tbody>
    </table>
  </section>

  ${d.sections.length === 0
    ? html`<p class="empty">No games recorded yet.</p>`
    : html`<section class="sheet-section round-detail">
      <h2>Game by game</h2>
      <!-- Abbreviated headings, because eleven columns of full stat names do
           not cross a sheet of A4. The legend keeps the sheet self-explanatory
           to someone reading the PDF who never saw the entry form. -->
      <p class="legend">
        ${GAME_STAT_FIELDS.map(
          (f, i) =>
            html`<span><strong>${f.short}</strong> ${f.label}</span>${i <
            GAME_STAT_FIELDS.length - 1
              ? html` &middot; `
              : ""}`,
        )}
      </p>
      ${d.sections.map(
        (sec) => html`<h3>Match ${sec.match_no} &middot; Pod ${sec.pod}</h3>
        <table class="sheet-table">
          <thead>
            <tr>
              <th class="num">Place</th>
              <th>Player</th>
              <th class="num">Life</th>
              ${GAME_STAT_FIELDS.map(
                (f) => html`<th class="num" title="${f.label}">${f.short}</th>`,
              )}
            </tr>
          </thead>
          <tbody>
            ${sec.rows.map(
              (s) => html`<tr>
                <td class="num">${s.placement}</td>
                <!-- The deck goes under the name rather than in a column of
                     its own: this table already gives up width to eleven
                     stats on A4, and a free-text column would not fit. -->
                <td>${s.player}${sec.commanders.get(s.player)
                  ? html`<small class="deck">${sec.commanders.get(s.player)}</small>`
                  : ""}</td>
                <td class="num">${s.final_life}</td>
                ${GAME_STAT_FIELDS.map((f) => html`<td class="num">${stat(s, f.name)}</td>`)}
              </tr>`,
            )}
          </tbody>
        </table>
        ${sec.matrix && sec.matrix.any ? matrixTable(sec.matrix) : ""}`,
      )}
    </section>`}

  <footer class="sheet-foot">
    ${d.event.name} &middot; round-robin, ${d.event.games_per_player} games per player
  </footer>

</article>`;

  return layout(content, {
    title: `Results · ${d.event.name}`,
    heading: d.event.name,
    extraHead: html`<link rel="stylesheet" href="/static/results.css">`,
  });
}
