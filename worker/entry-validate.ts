// Parsing and checking a submitted entry form.
//
// Messages are written for a tracker on a phone, not a developer. A generic
// "Input should be a valid integer" says nothing about which box or what to do.
//
// Every message here is placed under the box it belongs to. A message at the
// top of a form with nine numbered boxes in it says nothing about which one.

import { STAT_MAX, TURN_FIELDS } from "./fields.ts";
import { MAX_ROUNDS } from "./entry-rules.ts";

export type Errors = Record<string, string>;

/**
 * The damage boxes were drawn for a different set of opponents than are
 * sitting here now. Every number in them means the wrong player, so the form
 * goes back redrawn and empty rather than saved.
 */
export class StaleTable extends Error {}

export const STALE_TABLE_MESSAGE =
  "the table changed since this form opened: enter the turn again";

/** A blank box means zero, which is most boxes on most turns. */
function blankIsZero(raw: string | undefined): string {
  return raw === undefined || raw.trim() === "" ? "0" : raw.trim();
}

interface IntOptions {
  min?: number;
  max?: number;
  blankIsZero?: boolean;
}

/**
 * One integer box, with the message a tracker gets when it is wrong.
 *
 * Returns null and records an error rather than throwing, so one pass over a
 * form collects everything wrong with it: a tracker should not have to submit
 * four times to find four bad boxes.
 */
function intField(
  raw: string | undefined,
  field: string,
  errors: Errors,
  { min, max, blankIsZero: zero = true }: IntOptions = {},
): number | null {
  const text = zero ? blankIsZero(raw) : (raw ?? "").trim();
  if (text === "") {
    errors[field] ??= "required";
    return null;
  }
  // Deliberately strict: Number("12abc") is NaN but Number("") is 0 and
  // Number(" 12 ") is 12, and parseInt("12abc") is 12. A tracker who typed
  // "12 damage" must be told, not silently credited with 12.
  if (!/^-?\d+$/.test(text)) {
    errors[field] ??= "whole numbers only";
    return null;
  }
  const value = Number(text);
  if (max !== undefined && value > max) {
    errors[field] ??= `at most ${max}`;
    return null;
  }
  if (min !== undefined && value < min) {
    errors[field] ??= `at least ${min}`;
    return null;
  }
  return value;
}

function stringField(raw: string | undefined, field: string, errors: Errors): string {
  const text = (raw ?? "").trim();
  if (text === "") errors[field] ??= "required";
  return text;
}

export interface TurnEntry {
  pod: string;
  match_no: number;
  player: string;
  round_no: number;
  attacking_creatures: number;
  cmdr_dmg_dealt: number;
  noncombat_dmg_dealt: number;
  opps_eliminated: number;
}

/**
 * Pull the damage grid out of a submitted form.
 *
 * Inputs are named by SEAT (`dmg_2`), not by player name: names come from a
 * user-editable roster and can hold spaces, quotes and non-ASCII, none of which
 * survive a round trip through an HTML attribute cleanly.
 *
 * `opponents` is the seating minus the player themselves, so a cell can only
 * ever address somebody actually at the table.
 */
export function cleanDamage(
  submitted: Record<string, string>,
  opponents: string[],
  errors: Errors,
): Map<string, number> {
  const damage = new Map<string, number>();
  opponents.forEach((name, i) => {
    const field = `dmg_${i + 1}`;
    const raw = (submitted[field] ?? "").trim();
    // Absent means zero, and nobody has to type a zero to say "I did not
    // attack them". Distinct from a bad value, which is reported.
    if (raw === "") return;
    if (!/^-?\d+$/.test(raw)) {
      errors[field] ??= "whole numbers only";
      return;
    }
    const value = Number(raw);
    if (value < 0 || value > STAT_MAX) {
      errors[field] ??= `must be between 0 and ${STAT_MAX}`;
      return;
    }
    damage.set(name, value);
  });
  return damage;
}

export interface TurnParse {
  entry: TurnEntry | null;
  damage: Map<string, number>;
  errors: Errors;
}

/**
 * Parse and check a submitted turn form.
 *
 * `crossChecks` are the two rules that read one box against another: commander
 * damage has to be inside the damage grid already, and nobody can eliminate
 * more opponents than are at the table. Both are true of a finished turn,
 * which is what the Save button saves, so it asks for them.
 *
 * The autosave does not. A turn halfway through being typed breaks them
 * innocently (the commander damage box filled in before the grid it belongs
 * in) and refusing to keep those numbers is the very thing the autosave was
 * added to stop. It asks only for the per-box bounds, which no correct entry
 * ever breaks. The Save button stays the gate the finished row goes through.
 *
 * Throws StaleTable when the damage boxes were drawn for other opponents.
 */
export function parseTurn(
  submitted: Record<string, string>,
  context: {
    pods: string[];
    matches: number[];
    /** The seating of the table this form names, empty if there is none. */
    seating: string[];
  },
  options: { crossChecks: boolean },
): TurnParse {
  const errors: Errors = {};
  const pod = stringField(submitted["pod"], "pod", errors);
  const player = stringField(submitted["player"], "player", errors);
  const matchNo = intField(submitted["match_no"], "match_no", errors, {
    min: 1,
    max: MAX_ROUNDS,
    blankIsZero: false,
  });
  const roundNo = intField(submitted["round_no"], "round_no", errors, {
    min: 1,
    max: MAX_ROUNDS,
    blankIsZero: false,
  });

  const stats: Record<string, number | null> = {};
  for (const f of TURN_FIELDS) {
    stats[f.name] = intField(submitted[f.name], f.name, errors, { min: 0, max: STAT_MAX });
  }

  if (pod && !context.pods.includes(pod)) errors["pod"] ??= `unknown pod '${pod}'`;
  if (matchNo !== null && !context.matches.includes(matchNo)) {
    errors["match_no"] ??= `match must be 1-${context.matches.length}`;
  }

  let opponents: string[] = [];
  if (player) {
    if (!context.seating.includes(player)) {
      errors["player"] ??= `'${player}' is not at this table`;
    } else {
      opponents = context.seating.filter((n) => n !== player);
    }
  }

  // Damage boxes are numbered by seat, so a form drawn before a reseat would
  // put each number on whoever sits in that seat now. A form with no `table`
  // field predates the check and is let through.
  const drawnFor = submitted["table"];
  if (opponents.length > 0 && drawnFor !== undefined && drawnFor !== opponents.join("|")) {
    throw new StaleTable();
  }

  const complete =
    Object.keys(errors).length === 0 && matchNo !== null && roundNo !== null && player !== "";
  let damage = new Map<string, number>();
  if (complete) {
    damage = cleanDamage(submitted, opponents, errors);
    if (Object.keys(errors).length === 0 && options.crossChecks) {
      const dealt = [...damage.values()].reduce((a, b) => a + b, 0);
      // Commander damage is combat damage, so it is already inside the grid.
      // Typed only into its own box, it would leave combat damage, and every
      // prize and tiebreak built on it, short.
      if ((stats["cmdr_dmg_dealt"] ?? 0) > dealt) {
        errors["cmdr_dmg_dealt"] =
          "more than the combat damage above: add it to the grid too";
      }
      if ((stats["opps_eliminated"] ?? 0) > opponents.length) {
        errors["opps_eliminated"] = `only ${opponents.length} opponents at this table`;
      }
    }
  }

  const entry: TurnEntry | null =
    matchNo !== null && roundNo !== null && pod !== "" && player !== ""
      ? {
          pod,
          match_no: matchNo,
          player,
          round_no: roundNo,
          attacking_creatures: stats["attacking_creatures"] ?? 0,
          cmdr_dmg_dealt: stats["cmdr_dmg_dealt"] ?? 0,
          noncombat_dmg_dealt: stats["noncombat_dmg_dealt"] ?? 0,
          opps_eliminated: stats["opps_eliminated"] ?? 0,
        }
      : null;

  return { entry, damage, errors };
}

export interface FinalEntry {
  pod: string;
  match_no: number;
  player: string;
  /** null means "still playing", which is a real state and not zero. */
  placement: number | null;
  final_life: number;
  total_graveyard: number;
}

/**
 * Parse the death/win values, with the field names the caller wants them
 * reported under. The elimination form has three rows of them, so a shared
 * "final_life" key would put one row's error under another's box.
 */
export function parseFinalValues(
  submitted: { final_life?: string; total_graveyard?: string },
  keys: { final_life: string; total_graveyard: string },
  errors: Errors,
): { final_life: number; total_graveyard: number } | null {
  // Life is signed: it goes negative on a lethal hit, and -9997 has happened.
  const life = intField(submitted.final_life, keys.final_life, errors, {
    min: -STAT_MAX,
    max: STAT_MAX,
  });
  const yard = intField(submitted.total_graveyard, keys.total_graveyard, errors, {
    min: 0,
    max: STAT_MAX,
  });
  if (life === null || yard === null) return null;
  return { final_life: life, total_graveyard: yard };
}

export function parseFinal(
  submitted: Record<string, string>,
  context: { pods: string[]; matches: number[]; seating: string[]; placements: number[] },
): { entry: FinalEntry | null; errors: Errors } {
  const errors: Errors = {};
  const pod = stringField(submitted["pod"], "pod", errors);
  const player = stringField(submitted["player"], "player", errors);
  const matchNo = intField(submitted["match_no"], "match_no", errors, {
    min: 1,
    max: MAX_ROUNDS,
    blankIsZero: false,
  });

  // Blank is null, not zero: "no placement yet" is a real state, and zero is
  // not a placement anybody can finish in.
  const rawPlacement = (submitted["placement"] ?? "").trim();
  let placement: number | null = null;
  if (rawPlacement !== "") {
    placement = intField(rawPlacement, "placement", errors, { min: 1, blankIsZero: false });
  }

  const values = parseFinalValues(
    { final_life: submitted["final_life"], total_graveyard: submitted["total_graveyard"] },
    { final_life: "final_life", total_graveyard: "total_graveyard" },
    errors,
  );

  if (pod && !context.pods.includes(pod)) errors["pod"] ??= `unknown pod '${pod}'`;
  if (matchNo !== null && !context.matches.includes(matchNo)) {
    errors["match_no"] ??= `match must be 1-${context.matches.length}`;
  }
  if (placement !== null && !context.placements.includes(placement)) {
    errors["placement"] ??= `placement must be one of ${context.placements.join(", ")}`;
  }
  if (player && !context.seating.includes(player)) {
    errors["player"] ??= `'${player}' is not at this table`;
  }

  const entry: FinalEntry | null =
    matchNo !== null && values !== null && pod !== "" && player !== ""
      ? { pod, match_no: matchNo, player, placement, ...values }
      : null;
  return { entry, errors };
}
