// The tracker data-entry surface.
//
// One swap target (#entry-panel) for every save, with the pod table swapped out
// of band beside it, so a turn, a finish and a reseat all land the same way.

import { html, raw } from "hono/html";
import type { GamePlayerStat } from "../../shared/scoring.ts";
import type { EventRow } from "../data.ts";
import type { Turn } from "../entry-data.ts";
import type { EliminationPrompt } from "../entry-rules.ts";
import { enteredKey } from "../entry-rules.ts";
import { COMMANDER_MAX, GAME_STAT_FIELDS, TURN_FIELDS } from "../fields.ts";
import type { Errors } from "../entry-validate.ts";
import type { Html } from "./html.ts";
import { layout } from "./layout.ts";

/** What the tracker typed into the elimination form, when it comes back refused. */
export interface ElimEcho {
  rows: { player: string; final_life: string; total_graveyard: string }[];
  winner: { player: string; final_life: string; total_graveyard: string };
  simultaneous: boolean;
}

export interface EntryContext extends EliminationPrompt {
  event: EventRow;
  pods: string[];
  matches: number[];
  roster: string[];
  pod: string;
  match_no: number;
  player: string | null;
  round_no: number;
  round_options: [number, boolean][];
  rounds_played: number;
  seating: string[];
  opponents: string[];
  seatable: string[];
  commanders: Map<string, string>;
  placement_options: [number, string][];
  pod_size: number;
  values: Record<string, string | number>;
  errors: Errors;
  turn: Turn | null;
  final: { placement: number | null } | null;
  turn_grid: Map<string, Turn>;
  pod_stats: GamePlayerStat[];
  /** Who is out, name to the ordinal of their placement. */
  out: Map<string, string>;
  /** Who has entered the round being shown. */
  entered: Set<string>;
  final_open: boolean;
  elim: ElimEcho | null;
  saved: string;
}

const stat = (s: GamePlayerStat, name: string): number =>
  (s as unknown as Record<string, number>)[name] ?? 0;

const val = (c: EntryContext, key: string): string | number => c.values[key] ?? "";

function err(errors: Errors, field: string): Html | string {
  return errors[field] ? html`<span class="err">${errors[field]}</span>` : "";
}

// Every numeric box keeps itself, so nothing typed is lost to a jump to
// another player. On every box rather than inherited from the form, because
// the two controls that must NOT do this (the player select and the round box)
// are in the same form: they re-GET the panel, and a save fired off the same
// change event would file the numbers in front of the tracker under the player
// they just switched TO.
//
// `change` and not `keyup`: it fires when a box is left or Enter is pressed,
// which is one request per box instead of one per digit.
//
// hx-sync is htmx's own answer to the race this otherwise has with the Save
// button (tapping Save straight out of a box fires both) and aborts the
// autosave in favour of the real save, which writes the same row anyway.
const AUTOSAVE = raw(
  'hx-post="/entry/turn/draft" hx-trigger="change" hx-include="#turn-form"' +
    ' hx-swap="none" hx-sync="closest form:abort"',
);

/**
 * The autosave's only visible effect, and the one thing that makes it safe to
 * trust: a save that quietly failed would leave a tracker switching player
 * certain their numbers were kept.
 *
 * `oob` is set when this is the reply to an autosave; the turn form includes it
 * unset, so the element is already on the panel for that swap to land in.
 */
export function draftStatus(message = "", bad = false, oob = false): Html {
  return html`<span id="turn-draft-status" class="draft-status${bad ? " bad" : ""}"
      role="status"${oob ? raw(' hx-swap-oob="true"') : ""}>${message}</span>`;
}

/**
 * Set the table. Seating rotates every match, so this is filled in once per pod
 * per match, before play starts. The selects offer only players not already
 * dealt into the other pod for this same match.
 */
function seatingForm(c: EntryContext): Html {
  return html`<form class="card seating"
      hx-post="/entry/seat"
      hx-target="#entry-panel"
      hx-swap="outerHTML">
  <input type="hidden" name="pod" value="${c.pod}">
  <input type="hidden" name="match_no" value="${c.match_no}">

  <div class="card-head">
    <h2>Pod ${c.pod} &middot; Match ${c.match_no} &mdash; who is playing?</h2>
  </div>

  ${c.errors["seating"] ? html`<p class="err">${c.errors["seating"]}</p>` : ""}
  ${c.errors["pod"] ? html`<p class="err">${c.errors["pod"]}</p>` : ""}
  ${c.errors["match_no"] ? html`<p class="err">${c.errors["match_no"]}</p>` : ""}

  <div class="grid">
    ${Array.from({ length: c.pod_size }, (_, i) => i + 1).map(
      (i) => html`<label class="field">
        <span>Seat ${i}</span>
        <select name="seat">
          <option value="">&mdash;</option>
          ${c.seatable.map(
            (name) =>
              html`<option value="${name}"${c.seating[i - 1] === name ? raw(" selected") : ""}>${name}</option>`,
          )}
        </select>
      </label>`,
    )}
  </div>

  <div class="actions">
    <button type="submit">Set the table</button>
    <!-- Frees these players for the other pod, for a swap between tables.
         Turns already entered are kept and come back if they are reseated. -->
    ${c.seating.length > 0
      ? html`<button type="submit" name="clear" value="1" class="danger"
              hx-confirm="Clear Pod ${c.pod}? Its players become free to seat at the other pod.">Clear this table</button>`
      : ""}
    <span class="hint">Seat order is turn order. Saving a turn moves to the next seat.</span>
  </div>
</form>`;
}

/**
 * Which deck each player at this table brought to this match.
 *
 * Every box carries its player's name in a hidden field beside it: a deck
 * belongs to the person, not to the seat they happen to be in this match.
 */
function commandersForm(c: EntryContext): Html {
  return html`<form class="card decks"
      hx-post="/entry/commanders"
      hx-target="#entry-panel"
      hx-swap="outerHTML">
  <input type="hidden" name="pod" value="${c.pod}">
  <input type="hidden" name="match_no" value="${c.match_no}">

  ${c.errors["commanders"] ? html`<p class="err">${c.errors["commanders"]}</p>` : ""}

  <div class="grid">
    ${c.seating.map(
      (name) => html`<label class="field">
        <span>${name}</span>
        <input type="hidden" name="player" value="${name}">
        <input type="text" name="commander" maxlength="${COMMANDER_MAX}"
               value="${c.commanders.get(name) ?? ""}" placeholder="&mdash;"
               autocomplete="off" aria-label="Commander for ${name}">
      </label>`,
    )}
  </div>

  <div class="actions">
    <button type="submit">Save commanders</button>
    <!-- The boxes open showing the player's roster deck, which is a suggestion
         and not a record until this saves, so say so rather than let a tracker
         read a pre-filled box as something already entered. -->
    <span class="hint">Pre-filled with each player's usual deck. Empty a box to
      record no commander for this match.</span>
  </div>
</form>`;
}

/**
 * One turn cycle for one player: the tracking sheet's row, minus the death/win
 * columns. Saved repeatedly during the game, with no placement asked for,
 * which is what makes saving mid-match possible at all.
 *
 * Laid out to fit one phone screen: a tracker saves forty-odd of these a game,
 * and a form taller than the screen meant a scroll down to Save and back up for
 * the next player, every turn.
 */
function turnForm(c: EntryContext): Html {
  const player = c.player ?? "";
  return html`<form id="turn-form"
      class="card${Object.keys(c.errors).length > 0 ? " has-errors" : ""}"
      data-player="${player}" data-round="${c.round_no}"
      hx-post="/entry/turn"
      hx-target="#entry-panel"
      hx-swap="outerHTML"
      hx-disabled-elt="find button">

  <!-- The selectors drive the GET; the form carries its own copy so a POST is
       self-contained and a stale selector cannot retarget the save. -->
  <input type="hidden" name="pod" value="${c.pod}">
  <input type="hidden" name="match_no" value="${c.match_no}">
  <!-- The damage boxes are numbered by seat, so they mean the opponents this
       form was drawn for. The save refuses if the table has changed since. -->
  <input type="hidden" name="table" value="${c.opponents.join("|")}">

  <!-- Whose turn is the one thing the tracker must never misread, so it is the
       biggest text on the screen. Editing gets a warning colour: it overwrites. -->
  <div class="card-head turn-head">
    <div>
      <h2 class="whose">${player}${c.out.has(player)
        ? html` <small>out, ${c.out.get(player)}</small>`
        : ""}</h2>
      <span class="where">Pod ${c.pod} &middot; Match ${c.match_no}</span>
    </div>
    ${c.turn
      ? html`<span class="badge warn">Editing round ${c.round_no}</span>`
      : html`<span class="badge">New round ${c.round_no}</span>`}
  </div>

  ${err(c.errors, "pod")}${err(c.errors, "match_no")}${err(c.errors, "player")}

  <!-- Whose turn, which cycle, and the first number of it. Changing player or
       round reloads the panel rather than submitting, so a tracker can jump
       back and fix an earlier round. -->
  <div class="grid turn-top">
    <label class="field">
      <span>Player</span>
      <!-- This select IS the form's player field, and also the control that
           switches player: changing it re-GETs the panel (carrying pod, match
           and round from the form) instead of saving. The marks say who has
           entered this round and who is out, so a tracker can see the lap is
           complete. -->
      <select name="player"
              hx-get="/entry/form"
              hx-target="#entry-panel" hx-swap="outerHTML"
              hx-include="#turn-form"
              hx-params="pod,match_no,round_no,player">
        ${c.seating.map(
          (name) =>
            html`<option value="${name}"${name === player ? raw(" selected") : ""}>${name}${c.out.has(name)
              ? ` · out (${c.out.get(name)})`
              : c.entered.has(name)
                ? " ✓"
                : ""}</option>`,
        )}
      </select>
    </label>
    <label class="field">
      <span>Round</span>
      <!-- A selector, like the player picker beside it, because this is the
           same kind of control: it moves the tracker rather than carrying
           data. It offers the rounds played and the next one, so there is no
           way to type 1 for 11 and land on a finished round, which, now that
           every box keeps itself as it is left, is a round quietly overwritten
           rather than a wasted tap. A tick marks a round already entered. -->
      <select name="round_no"
              hx-get="/entry/form"
              hx-trigger="change"
              hx-target="#entry-panel" hx-swap="outerHTML"
              hx-include="#turn-form"
              hx-params="pod,match_no,round_no,player">
        ${c.round_options.map(
          ([value, done]) =>
            html`<option value="${value}"${value === c.round_no ? raw(" selected") : ""}>${value}${done ? " ✓" : ""}</option>`,
        )}
      </select>
      ${err(c.errors, "round_no")}
    </label>
    <label class="field" title="Attacking creatures declared this combat">
      <span>Attackers</span>
      <input type="number" name="attacking_creatures" min="0" step="1" inputmode="numeric"
             value="${val(c, "attacking_creatures")}" ${AUTOSAVE}>
      ${err(c.errors, "attacking_creatures")}
    </label>
  </div>

  <fieldset>
    <legend>Combat damage to
      <small class="legend-note">blank for none</small>
    </legend>
    <div class="grid stat-row">
      ${c.opponents.map(
        (name, i) => html`<label class="field dmg">
          <span>${name}</span>
          <input type="number" name="dmg_${i + 1}" min="0" step="1" inputmode="numeric"
                 value="${val(c, `dmg_${i + 1}`)}" ${AUTOSAVE}>
          ${err(c.errors, `dmg_${i + 1}`)}
        </label>`,
      )}
    </div>
  </fieldset>

  <fieldset>
    <legend>Rest of the turn</legend>
    <div class="grid stat-row rest">
      ${TURN_FIELDS.filter((f) => f.name !== "attacking_creatures").map(
        (f) => html`<label class="field" title="${f.hint}">
          <span>${f.label}</span>
          <input type="number" name="${f.name}" min="0" step="1" inputmode="numeric"
                 value="${val(c, f.name)}" ${AUTOSAVE}>
          ${err(c.errors, f.name)}
        </label>`,
      )}
    </div>
    <small class="legend-note">Commander damage is already in the grid above.
      Non-combat is burn, pingers and drains, and is not the tiebreaker.</small>
  </fieldset>

  <div class="actions">
    <button type="submit"><span class="idle">Save round ${c.round_no}</span><span class="busy">Saving&hellip;</span></button>
    <!-- Save still does what it always did: it is what advances the tracker to
         the next seat and marks the round entered. The boxes keeping
         themselves is only insurance against leaving before tapping it. -->
    ${draftStatus()}
    <span class="hint">Each box is kept as you leave it.</span>
  </div>
</form>`;
}

/**
 * The tracking sheet's "Entered at Player Death or Win" section.
 *
 * Deliberately a separate form from the turn above: these three values are
 * unknowable until a player is out, and requiring them on every save is what
 * used to block a tracker from recording anything mid-game.
 *
 * Collapsed until somebody goes out. Open all game, it doubled the scroll and
 * put a second big Save button right where a thumb lands.
 */
function finalForm(c: EntryContext): Html {
  const player = c.player ?? "";
  const placement = String(val(c, "placement"));
  return html`<details class="card final"${c.final_open ? raw(" open") : ""}>
  <summary class="card-head">
    <h2>${player} is out, or won</h2>
    ${c.final?.placement
      ? html`<span class="badge ok">Finished ${c.out.get(player)}</span>`
      : html`<span class="badge">Still playing</span>`}
  </summary>

  <form id="final-form"
        hx-post="/entry/final"
        hx-target="#entry-panel"
        hx-swap="outerHTML"
        hx-disabled-elt="find button">

    <input type="hidden" name="pod" value="${c.pod}">
    <input type="hidden" name="match_no" value="${c.match_no}">
    <input type="hidden" name="player" value="${player}">
    <!-- Carried so the panel comes back on the round the tracker was in. -->
    <input type="hidden" name="round_no" value="${c.round_no}">

    <div class="grid">
      <label class="field">
        <span>Placement</span>
        <select name="placement">
          <option value=""${placement === "" ? raw(" selected") : ""}>&mdash; still playing</option>
          ${c.placement_options.map(
            ([value, label]) =>
              html`<option value="${value}"${placement === String(value) ? raw(" selected") : ""}>${label}</option>`,
          )}
        </select>
        <small>Order of elimination, filled in for the next one out. Ties both take the placement.</small>
        ${err(c.errors, "placement")}
      </label>

      <label class="field">
        <span>Final life total</span>
        <!-- No inputmode here, unlike every other box: iOS's numeric keypad
             has no minus key, and life at death is usually negative.
             type=number on its own brings up a keyboard that has one. -->
        <input type="number" name="final_life" step="1" value="${val(c, "final_life")}">
        <small>Life at death (may be negative) or at time.</small>
        ${err(c.errors, "final_life")}
      </label>

      <label class="field">
        <span>Total cards in graveyard</span>
        <input type="number" name="total_graveyard" min="0" step="1" inputmode="numeric"
               value="${val(c, "total_graveyard")}">
        <small>Count the pile once, at the end.</small>
        ${err(c.errors, "total_graveyard")}
      </label>
    </div>

    <div class="actions">
      <button type="submit"><span class="idle">Save ${player}'s finish</span><span class="busy">Saving&hellip;</span></button>
    </div>
  </form>
</details>`;
}

/**
 * Everybody a turn put out, in one submit.
 *
 * Shown only while there are deaths outstanding, and above the turn form,
 * because for as long as it is here it is the thing to do next. Recording the
 * deaths is what removes it.
 *
 * One row per death, in the order the players went out. The placement is not
 * asked for: it follows from the order and from how many were still playing,
 * so the tracker types two numbers per row instead of choosing a place that
 * another row might also claim.
 */
function eliminationsForm(c: EntryContext): Html {
  const prior = (i: number) => c.elim?.rows[i];
  return html`<form class="card eliminations${c.errors["eliminations"] ? " has-errors" : ""}"
      hx-post="/entry/eliminations"
      hx-target="#entry-panel"
      hx-swap="outerHTML"
      hx-disabled-elt="find button">

  <input type="hidden" name="pod" value="${c.pod}">
  <input type="hidden" name="match_no" value="${c.match_no}">
  <!-- Carried so the panel comes back on the round the tracker was in. -->
  <input type="hidden" name="round_no" value="${c.round_no}">

  <div class="card-head">
    <h2>${c.deaths_due === 1 ? "Who went out?" : "Who went out, in order?"}</h2>
    <span class="badge warn">${c.deaths_due} to record</span>
  </div>

  ${err(c.errors, "eliminations")}

  ${c.elimination_rows.map(
    (row, i) => html`<fieldset class="elim-row">
      <legend>${row.order} out <small>finishes ${row.label}</small></legend>
      <div class="grid">
        <label class="field">
          <span>Player</span>
          <select name="player" aria-label="Who went out ${row.order}">
            <option value="">&mdash; nobody yet</option>
            ${c.elimination_candidates.map(
              (name) =>
                html`<option value="${name}"${prior(i)?.player === name ? raw(" selected") : ""}>${name}</option>`,
            )}
          </select>
        </label>

        <label class="field">
          <span>Final life total</span>
          <!-- No inputmode, like the single-player form: iOS's numeric keypad
               has no minus key and life at death is usually negative. -->
          <input type="number" name="final_life" step="1"
                 value="${prior(i)?.final_life ?? ""}"
                 aria-label="Life at death for the ${row.order} player out">
          ${err(c.errors, `elim_life_${i}`)}
        </label>

        <label class="field">
          <span>Cards in graveyard</span>
          <input type="number" name="total_graveyard" min="0" step="1" inputmode="numeric"
                 value="${prior(i)?.total_graveyard ?? ""}"
                 aria-label="Graveyard count for the ${row.order} player out">
          ${err(c.errors, `elim_yard_${i}`)}
        </label>
      </div>
    </fieldset>`,
  )}

  ${c.elimination_rows.length > 1
    ? html`<!-- The usual case for two rows at once is one attack killing both,
             where there is no order to list. The event owner's rule ranks
             those by life at death, so ticking this derives the places from
             the numbers above instead of from the order of the rows. -->
      <label class="field check">
        <input type="checkbox" name="simultaneous" value="1"${c.elim?.simultaneous ? raw(" checked") : ""}>
        <span>All killed at the same moment</span>
        <small>Then the order comes from the life totals above, least negative
          higher. Equal totals tie and share the placement.</small>
      </label>`
    : ""}

  ${c.winner_row
    ? html`<!-- These deaths leave one player standing, so the game is over and
             the winner's own three numbers are due as well. Asked for here
             rather than left for a tracker to come back to once the table has
             broken up. -->
      <fieldset class="elim-row winner">
        <legend>&hellip;and the winner <small>finishes ${c.winner_row.label}</small></legend>
        <div class="grid">
          <label class="field">
            <span>Player</span>
            <select name="winner" aria-label="Who won">
              <option value="">&mdash; not yet</option>
              ${c.elimination_candidates.map(
                (name) =>
                  html`<option value="${name}"${c.elim?.winner.player === name ? raw(" selected") : ""}>${name}</option>`,
              )}
            </select>
          </label>

          <label class="field">
            <span>Final life total</span>
            <input type="number" name="winner_life" step="1"
                   value="${c.elim?.winner.final_life ?? ""}"
                   aria-label="Life total for the winner">
            ${err(c.errors, "winner_life")}
          </label>

          <label class="field">
            <span>Cards in graveyard</span>
            <input type="number" name="winner_graveyard" min="0" step="1" inputmode="numeric"
                   value="${c.elim?.winner.total_graveyard ?? ""}"
                   aria-label="Graveyard count for the winner">
            ${err(c.errors, "winner_graveyard")}
          </label>
        </div>
      </fieldset>`
    : ""}

  <div class="actions">
    <button type="submit"><span class="idle">Save who went out</span><span class="busy">Saving&hellip;</span></button>
    <span class="hint">Leave a row on &ldquo;nobody yet&rdquo; if you only know one of them;
      it stays here until it is filled in.</span>
  </div>
</form>`;
}

/**
 * The pod table: totals so far and the grid of turns entered.
 *
 * `oob` is set only when the panel is swapped, so the same partial serves the
 * initial page render and out-of-band HTMX swaps.
 */
export function podTable(c: EntryContext, oob = false): Html {
  // Counts players who have FINISHED, not players who have a row: every seated
  // player has a row from the moment the table is set, so counting rows would
  // show "4 of 4" before a card was played.
  const finished = c.pod_stats.filter((s) => s.placement !== null).length;
  const rounds = Array.from({ length: c.rounds_played }, (_, i) => i + 1);
  const query = (name: string, r: number) =>
    `pod=${encodeURIComponent(c.pod)}&match_no=${c.match_no}` +
    `&player=${encodeURIComponent(name)}&round_no=${r}`;

  return html`<section id="pod-table" class="card"${oob ? raw(' hx-swap-oob="true"') : ""}>
  <div class="card-head">
    <h2>Pod ${c.pod} &middot; Match ${c.match_no}</h2>
    <span class="badge${finished >= c.pod_size ? " ok" : ""}">
      ${finished} of ${c.pod_size} finished
    </span>
  </div>

  ${c.seating.length === 0
    ? html`<p class="empty">This table has not been set yet.</p>`
    : html`<h3>Totals so far <small class="legend-note">derived from the turns below</small></h3>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">Place</th>
            <th scope="col">Life</th>
            ${GAME_STAT_FIELDS.map((f) => html`<th scope="col" class="num">${f.short}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${c.pod_stats.map(
            (s) => html`<tr class="${s.player === c.player ? "current" : ""}">
              <th scope="row">${s.player}</th>
              <td>${s.placement ?? html`&mdash;`}</td>
              <td>${s.placement !== null ? s.final_life : html`&mdash;`}</td>
              ${GAME_STAT_FIELDS.map((f) => html`<td class="num">${stat(s, f.name)}</td>`)}
            </tr>`,
          )}
        </tbody>
      </table>
    </div>

    ${c.rounds_played > 0
      ? html`<h3>Turns entered <small class="legend-note">combat damage per turn, tap one to open it</small></h3>
      <div class="table-scroll">
        <table class="turn-grid">
          <thead>
            <tr>
              <th scope="col">Player</th>
              ${rounds.map((r) => html`<th scope="col" class="num">R${r}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${c.seating.map(
              (name) => html`<tr class="${name === c.player ? "current" : ""}">
                <th scope="row">${name}</th>
                ${rounds.map((r) => {
                  const t = c.turn_grid.get(enteredKey(name, r));
                  const dealt = t ? [...t.damage.values()].reduce((a, b) => a + b, 0) : null;
                  // The cell shows that turn's combat damage, which is the
                  // number a tracker is most likely to be checking for a typo.
                  // A blank cell means the turn was never entered. Either way
                  // it opens that turn, since this grid is where a wrong or
                  // missing one gets spotted.
                  const classes = [
                    "num",
                    t ? "" : "missing",
                    name === c.player && r === c.round_no ? "here" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return html`<td class="${classes}">
                    <a href="/entry?${raw(query(name, r))}"
                       hx-get="/entry/form?${raw(query(name, r))}"
                       hx-target="#entry-panel" hx-swap="outerHTML"
                       aria-label="${name}, round ${r}">${dealt === null ? html`&middot;` : dealt}</a>
                  </td>`;
                })}
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`
      : html`<p class="empty">No turns recorded for this match yet.</p>`}`}
</section>`;
}

/**
 * The whole per-table surface. One hx-target for every save, so a turn, a
 * finish and a reseat all swap the same node and nothing can drift apart.
 *
 * `fullPage` suppresses the out-of-band copy of the pod table: on the first
 * render the table is included directly by the page, and two nodes with the
 * same id would be an invalid document.
 */
export function panel(c: EntryContext, { fullPage = false } = {}): Html {
  return html`<div id="entry-panel">
  <!-- The page scrolls here after every save, so this is the first thing the
       tracker sees: proof the last tap landed. -->
  ${c.saved ? html`<p class="saved" role="status">✓ ${c.saved}</p>` : ""}

  ${c.seating.length === 0
    ? seatingForm(c)
    : html`<!-- Above the turn form, and only while there are eliminations
             credited on a turn that nobody has been recorded against yet: for
             as long as it is here it is the thing to do next, and recording
             them removes it. -->
      ${c.deaths_due > 0 ? eliminationsForm(c) : ""}

      ${turnForm(c)}
      ${finalForm(c)}

      <!-- Both once-per-match forms, below the per-turn ones that are tapped
           all game. Open the decks one when a box is why the form came back. -->
      <details class="card decks-wrap"${c.errors["commanders"] ? raw(" open") : ""}>
        <summary>Commanders for this match</summary>
        ${commandersForm(c)}
      </details>

      <details class="card reseat">
        <summary>Change who is at this table</summary>
        ${seatingForm(c)}
      </details>`}
</div>
${fullPage ? "" : podTable(c, true)}`;
}

export function entryPage(c: EntryContext): Html {
  const content =
    c.roster.length === 0
      ? html`<h1>Data entry</h1>
<p class="empty">No players on the roster. Add players in <a href="/admin">/admin</a> and reload.</p>`
      : html`<h1>Data entry</h1>

<!-- Pod and match pick the table. Everything else (who is seated, whose turn,
     which round) depends on that table, so it lives inside the panel. -->
<form id="selectors"
      hx-get="/entry/form"
      hx-target="#entry-panel"
      hx-swap="outerHTML"
      hx-trigger="change">
  <label>
    Pod
    <select name="pod">
      ${c.pods.map(
        (p) => html`<option value="${p}"${p === c.pod ? raw(" selected") : ""}>${p}</option>`,
      )}
    </select>
  </label>
  <label>
    Match
    <select name="match_no">
      ${c.matches.map(
        (m) => html`<option value="${m}"${m === c.match_no ? raw(" selected") : ""}>${m}</option>`,
      )}
    </select>
  </label>
</form>

${panel(c, { fullPage: true })}
${podTable(c)}

${raw(`<script>
  // After the panel is swapped, show the tracker what happened. They tapped
  // Save at the bottom of the form, but the confirmation, the next player's
  // name and any field error are all above it, and htmx leaves the page
  // scrolled where it was. An error goes to the middle of the screen, so the
  // box it is about is in view; anything else goes to the top of the panel.
  document.addEventListener("htmx:afterSettle", function (evt) {
    var panel = document.getElementById("entry-panel");
    if (!panel || !panel.contains(evt.detail.elt)) return;
    var err = panel.querySelector(".err");
    if (err) {
      err.scrollIntoView({ block: "center" });
    } else {
      panel.scrollIntoView({ block: "start" });
    }
  });
</script>`)}`;

  return layout(content, {
    title: `Entry · ${c.event.name}`,
    heading: c.event.name,
  });
}
