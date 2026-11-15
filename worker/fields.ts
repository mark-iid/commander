// The declarative stat descriptions the forms and the sheets render from.
//
// Adding a stat means editing a list here, plus a migration and a prize in the
// event's configuration, rather than rewriting a form.
//
// `name` is the field name the scoring engine and the event config refer to, so
// it has to match the column and the `metric:` in a prize exactly.

export interface StatField {
  name: string;
  label: string;
  hint: string;
  /**
   * Column heading for dense tables. The results sheet puts every stat beside
   * placement, player and life, and eleven columns of "Most creatures
   * attacking" do not fit across a sheet of A4, so the sheet abbreviates and
   * prints a legend. The forms keep the full label.
   */
  short: string;
}

/**
 * The numeric inputs on one turn row, in the order the sheet asks for them.
 *
 * The per-opponent damage grid sits between attacking_creatures and
 * cmdr_dmg_dealt and is built separately, because its columns depend on who is
 * at the table.
 */
export const TURN_FIELDS: readonly StatField[] = [
  {
    name: "attacking_creatures",
    label: "Attacking creatures",
    hint: "Declared this combat",
    short: "Creatures",
  },
  {
    name: "cmdr_dmg_dealt",
    label: "Commander damage",
    hint: "Already counted in the grid above",
    short: "Cmdr",
  },
  {
    name: "noncombat_dmg_dealt",
    label: "Non-combat damage",
    hint: "Burn, pingers, drains. Not the tiebreaker",
    short: "Non-cbt",
  },
  {
    name: "opps_eliminated",
    label: "Opponents eliminated",
    hint: "Kills credited this turn",
    short: "Elims",
  },
];

/**
 * What a finished game looks like once the turns are aggregated.
 *
 * These are GamePlayerStat field names: the results sheet, the pod table and
 * the public board all render from this list, and none of them is entered by
 * hand. Every one is derived; see shared/aggregate.ts.
 */
export const GAME_STAT_FIELDS: readonly StatField[] = [
  { name: "combat_dmg_dealt", label: "Combat damage dealt", hint: "Summed over the damage grid", short: "Combat" },
  { name: "noncombat_dmg_dealt", label: "Non-combat damage dealt", hint: "Summed over turns", short: "Non-cbt" },
  { name: "cmdr_dmg_dealt", label: "Commander damage dealt", hint: "Summed over turns", short: "Cmdr" },
  { name: "opps_eliminated", label: "Opponents eliminated", hint: "Summed over turns", short: "Elims" },
  { name: "biggest_attack_dealt", label: "Biggest attack dealt", hint: "Best single turn's combat damage", short: "Big hit" },
  { name: "biggest_attack_taken", label: "Biggest attack taken", hint: "Most taken from one attacker in a turn", short: "Big taken" },
  { name: "most_creatures_in_attack", label: "Most creatures attacking", hint: "Best single turn", short: "Creatures" },
  { name: "total_graveyard", label: "Cards in graveyard", hint: "Counted at death or win", short: "Yard" },
];

/** Longest commander a player may be given, on the roster or for one match. */
export const COMMANDER_MAX = 80;

/**
 * Upper bound on every numeric stat a tracker can enter.
 *
 * The event owner's number, raised from 9999 on 2026-11-14: Commander has
 * combos that deal damage in a loop, and a cap a real game can reach is a cap
 * that throws away the game it was reached in. Still small enough that a hand
 * resting on a keypad is rejected at the field rather than reaching storage.
 */
export const STAT_MAX = 99999;
