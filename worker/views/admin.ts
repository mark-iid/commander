// The admin surface: events, the roster, and the danger zone.
//
// Events are created by copying an existing one's pods, scoring and prizes, and
// optionally its roster. Switching the active event reloads the page, because
// every other region on it is about the event that was active.
//
// Prize eligibility is a checkbox per player, because it is a column rather
// than a list of names in a config file: renaming a player cannot change it.
//
// "Reset everything" leaves the roster empty. There is no configuration file to
// rebuild it from, and the confirmation says so.

import { html, raw } from "hono/html";
import { COMMANDER_MAX } from "../fields.ts";
import type { EventSummary } from "../admin-data.ts";
import type { EventRow } from "../data.ts";
import type { Html } from "./html.ts";
import { layout } from "./layout.ts";

export const NAME_MAX = 60;
export const EVENT_NAME_MAX = 80;

export interface EventsState {
  events: EventSummary[];
  /** The event awaiting delete confirmation, with what it holds. */
  armed: (EventSummary & { stat_rows: number }) | null;
  error: string | null;
  notice: string | null;
  /** What the operator typed on a failed create, so it is not blanked. */
  form: { name: string; date: string };
}

export interface PlayerRow {
  player_id: number;
  name: string;
  commander: string | null;
  prize_eligible: number;
}

export interface ResetState {
  /** The scope awaiting confirmation, or null for the idle panel. */
  armed: string | null;
  games: number;
  stat_rows: number;
  player_count: number;
  reset_notice: string | null;
  reset_error: string | null;
}

export interface AdminContext extends ResetState {
  event: EventRow;
  players: PlayerRow[];
  error: string | null;
  notice: string | null;
  /** What the operator typed on a failed add, so it is not blanked. */
  form: { name: string; commander: string };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The whole roster region. Add, save and delete all swap this one element, so
 * there is a single place for the result banner to land.
 *
 * `oob` is set when something other than a roster action needs to refresh it: a
 * reset targets the danger zone, so the roster has to ride along out of band
 * rather than as the response body.
 */
export function rosterSection(c: AdminContext, oob = false): Html {
  return html`<section id="roster" class="card${c.error ? " has-errors" : ""}"${oob ? raw(' hx-swap-oob="true"') : ""}>

  <div class="card-head">
    <h2>Players</h2>
    ${c.error
      ? html`<span class="badge bad">${c.error}</span>`
      : c.notice
        ? html`<span class="badge ok">${c.notice}</span>`
        : html`<span class="badge">${plural(c.players.length, "player")}</span>`}
  </div>

  ${c.players.length === 0
    ? html`<p class="empty">No players yet. Add the first one below.</p>`
    : html`<div class="table-scroll">
      <!-- data-label carries each column heading down into the cell, because on
           a phone the rows stack into blocks and thead is hidden. -->
      <table class="roster-table">
        <thead>
          <tr><th>Name</th><th>Commander</th><th>Prizes</th><th>Actions</th></tr>
        </thead>
        <tbody>
          ${c.players.map(
            (p) => html`<!-- No form here: a form is not valid inside a table row, so the
                 buttons post the row's own inputs via hx-include. -->
            <tr>
              <td data-label="Name">
                <input type="text" name="name" maxlength="${NAME_MAX}"
                       value="${p.name}" aria-label="Name for ${p.name}">
              </td>
              <td data-label="Commander">
                <input type="text" name="commander" maxlength="${COMMANDER_MAX}" placeholder="&mdash;"
                       value="${p.commander ?? ""}" aria-label="Commander for ${p.name}">
              </td>
              <td data-label="Prizes">
                <!-- Unticked is the organiser who plays and scores but takes no
                     prize: each one they would have won goes to the runner-up.
                     They stay in the standings. -->
                <label class="check">
                  <input type="checkbox" name="prize_eligible" value="1"
                         ${p.prize_eligible ? raw("checked") : ""}
                         aria-label="${p.name} can win prizes">
                  <span>Eligible</span>
                </label>
              </td>
              <td class="row-actions">
                <button type="button"
                        hx-post="/admin/players/${p.player_id}"
                        hx-include="closest tr"
                        hx-target="#roster"
                        hx-swap="outerHTML">Save</button>
                <button type="button" class="danger"
                        hx-post="/admin/players/${p.player_id}/delete"
                        hx-confirm="Delete ${p.name} from the roster?"
                        hx-target="#roster"
                        hx-swap="outerHTML">Delete</button>
              </td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>
    <p class="hint">Renaming is safe: recorded games follow the player, not the name.
    A player who has played a game cannot be deleted.</p>`}

  <form hx-post="/admin/players"
        hx-target="#roster"
        hx-swap="outerHTML">
    <fieldset>
      <legend>Add a player</legend>
      <div class="grid">
        <label class="field">
          <span>Name</span>
          <input type="text" name="name" maxlength="${NAME_MAX}" value="${c.form.name}">
        </label>
        <label class="field">
          <span>Commander</span>
          <input type="text" name="commander" maxlength="${COMMANDER_MAX}" value="${c.form.commander}">
          <small>Optional. Free text.</small>
        </label>
        <label class="field check">
          <input type="checkbox" name="prize_eligible" value="1" checked>
          <span>Can win prizes</span>
          <small>Untick for the organiser, who plays and scores but takes no prize.</small>
        </label>
      </div>
      <div class="actions">
        <button type="submit">Add player</button>
      </div>
    </fieldset>
  </form>

</section>`;
}

/**
 * The events region. Every event action swaps this one element, except a change
 * of active event, which reloads the page.
 */
export function eventsSection(s: EventsState): Html {
  const active = s.events.find((e) => e.active);
  return html`<section id="events" class="card${s.error ? " has-errors" : ""}">

  <div class="card-head">
    <h2>Events</h2>
    ${s.error
      ? html`<span class="badge bad">${s.error}</span>`
      : s.notice
        ? html`<span class="badge ok">${s.notice}</span>`
        : html`<span class="badge">${plural(s.events.length, "event")}</span>`}
  </div>

  ${s.armed
    ? html`<div class="confirm">
      <p class="confirm-lead">Delete ${s.armed.name}?</p>
      <p>This permanently deletes the event with
        <strong>${plural(s.armed.games, "game")}</strong>,
        <strong>${plural(s.armed.stat_rows, "stat row")}</strong> and
        <strong>${plural(s.armed.players, "player")}</strong>, its prizes and its scoring.
        No other event is touched.</p>
      <p class="hint">A restore point is recorded first, and named in the result.</p>
      <div class="actions">
        <form hx-post="/admin/events/${s.armed.event_id}/delete" hx-target="#events" hx-swap="outerHTML">
          <button type="submit" class="danger">Yes, delete ${s.armed.name}</button>
        </form>
        <button type="button" hx-get="/admin/events" hx-target="#events" hx-swap="outerHTML">Cancel</button>
      </div>
    </div>`
    : ""}

  <div class="table-scroll">
    <table class="roster-table">
      <thead>
        <tr><th>Name</th><th>Date</th><th>Recorded</th><th>Actions</th></tr>
      </thead>
      <tbody>
        ${s.events.map(
          (e) => html`<tr>
            <td data-label="Name">
              <input type="text" name="name" maxlength="${EVENT_NAME_MAX}"
                     value="${e.name}" aria-label="Name for ${e.name}">
            </td>
            <td data-label="Date">
              <input type="date" name="date" value="${e.date ?? ""}" aria-label="Date for ${e.name}">
            </td>
            <td data-label="Recorded">
              ${plural(e.games, "game")} &middot; ${plural(e.players, "player")}
              ${e.active ? html`<span class="badge ok">Active</span>` : ""}
            </td>
            <td class="row-actions">
              <button type="button"
                      hx-post="/admin/events/${e.event_id}"
                      hx-include="closest tr"
                      hx-target="#events"
                      hx-swap="outerHTML">Save</button>
              <a class="button-link" href="/results?event=${e.event_id}">Results</a>
              ${e.active
                ? ""
                : html`<button type="button"
                        hx-post="/admin/events/${e.event_id}/activate"
                        hx-target="#events"
                        hx-swap="outerHTML">Make active</button>
                  <button type="button" class="danger"
                        hx-get="/admin/events/${e.event_id}/delete"
                        hx-target="#events"
                        hx-swap="outerHTML">Delete</button>`}
            </td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>
  <p class="hint">The active event is the one on the display, at /entry and on this page.
  The active event cannot be deleted.</p>

  <form hx-post="/admin/events" hx-target="#events" hx-swap="outerHTML">
    <fieldset>
      <legend>New event</legend>
      <div class="grid">
        <label class="field">
          <span>Name</span>
          <input type="text" name="name" maxlength="${EVENT_NAME_MAX}" value="${s.form.name}">
        </label>
        <label class="field">
          <span>Date</span>
          <input type="date" name="date" value="${s.form.date}">
          <small>Optional.</small>
        </label>
        <label class="field">
          <span>Copy prizes, scoring and pods from</span>
          <select name="copy_from">
            ${s.events.map(
              (e) => html`<option value="${e.event_id}"${e === active ? raw(" selected") : ""}>${e.name}</option>`,
            )}
          </select>
          <small>Results are never copied.</small>
        </label>
        <label class="field check">
          <input type="checkbox" name="copy_roster" value="1" checked>
          <span>Copy its roster</span>
          <small>Players, commanders and prize eligibility. Untick to start with nobody.</small>
        </label>
        <label class="field check">
          <input type="checkbox" name="make_active" value="1" checked>
          <span>Make it the active event</span>
        </label>
      </div>
      <div class="actions">
        <button type="submit">Create event</button>
      </div>
    </fieldset>
  </form>

</section>`;
}

/**
 * The danger zone, in one of two states. `armed` is the scope awaiting
 * confirmation; when it is unset this is just the two buttons.
 *
 * Both states are server-rendered, so the counts quoted in the confirmation are
 * read from the database at the moment of asking rather than baked into the
 * page when it loaded.
 */
export function dangerZone(c: ResetState): Html {
  return html`<section id="danger-zone" class="card danger-zone${c.reset_error ? " has-errors" : ""}">

  <div class="card-head">
    <h2>Danger zone</h2>
    ${c.reset_error
      ? html`<span class="badge bad">${c.reset_error}</span>`
      : c.reset_notice
        ? html`<span class="badge ok">${c.reset_notice}</span>`
        : html`<span class="badge">${plural(c.stat_rows, "stat row")}
            &middot; ${plural(c.games, "game")}
            &middot; ${plural(c.player_count, "player")}</span>`}
  </div>

  ${c.armed
    ? html`<div class="confirm">
      <p class="confirm-lead">Are you sure?</p>

      ${c.armed === "results"
        ? html`<p>This permanently deletes
            <strong>${plural(c.stat_rows, "stat row")}</strong>
            across <strong>${plural(c.games, "game")}</strong>.
            The leaderboard goes back to zero.</p>
          <p>The roster is kept: all ${plural(c.player_count, "player")}
            stay exactly as they are.</p>`
        : html`<p>This permanently deletes
            <strong>${plural(c.stat_rows, "stat row")}</strong>
            across <strong>${plural(c.games, "game")}</strong>,
            <em>and</em> removes all
            <strong>${plural(c.player_count, "player")}</strong>.</p>
          <p class="warn">The roster is left <strong>empty</strong> and you will have to add
            every player again. There is no longer a config roster to rebuild it from:
            the roster lives in the database.</p>`}

      <p class="hint">A restore point is recorded first, and named in the result.
        Nothing on this page can undo a reset.</p>

      <div class="actions">
        <form hx-post="/admin/reset"
              hx-target="#danger-zone"
              hx-swap="outerHTML">
          <input type="hidden" name="scope" value="${c.armed}">
          <button type="submit" class="danger">
            Yes, ${c.armed === "all" ? "reset everything" : "delete all results"}
          </button>
        </form>
        <button type="button"
                hx-get="/admin/reset"
                hx-target="#danger-zone"
                hx-swap="outerHTML">Cancel</button>
      </div>
    </div>`
    : html`<p class="hint">These clear the active event. To start a new tournament, create a new
      event above instead, which keeps this one's results. Both resets record a restore point
      first and are safe to run while trackers are connected, but neither can be undone from
      this page.</p>

    <div class="actions">
      <button type="button" class="danger"
              hx-get="/admin/reset/confirm?scope=results"
              hx-target="#danger-zone"
              hx-swap="outerHTML">Clear all results</button>
      <button type="button" class="danger"
              hx-get="/admin/reset/confirm?scope=all"
              hx-target="#danger-zone"
              hx-swap="outerHTML">Reset everything</button>
    </div>
    <p class="hint"><strong>Clear all results</strong> deletes games and stats, keeping the
      roster. <strong>Reset everything</strong> also throws the roster away: that is the one
      that clears out test players.</p>`}

</section>`;
}

/**
 * Response to a completed reset. The danger zone is the swap target; the roster
 * rides along out of band because a scope=all reset replaced every row in it,
 * and even a results-only reset changes what the roster can do, since players
 * who were undeletable because they had stats are now deletable.
 */
export function resetDone(c: AdminContext): Html {
  return html`${dangerZone(c)}${rosterSection(c, true)}`;
}

export function adminPage(c: AdminContext, events: EventsState): Html {
  return layout(
    html`<h1>Admin</h1>

${eventsSection(events)}

<h2>Roster for ${c.event.name}</h2>
<p class="hint">Untick <strong>Eligible</strong> for the organiser: they play and score,
and each prize they would have won goes to the runner-up.</p>

${rosterSection(c)}

${dangerZone(c)}`,
    { title: `Admin · ${c.event.name}`, heading: c.event.name },
  );
}
