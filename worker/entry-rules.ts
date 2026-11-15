// The rules the entry surface decides by.
//
// Pure functions, kept apart from the routes because this is where the event
// owner's settled rules live and every one of them fails silently when it is
// wrong: a player credited the wrong placement, a death prompt that never
// appears, a tracker landing on a turn that is already saved. None of those
// raise anything.
//
// Held to recorded answers over 61 cases in shared/fixtures/entry-rules.json
// (worker/entry-rules.test.ts).

/** Cap on a round number. A game is turns, not hours, but the box is typed. */
export const MAX_ROUNDS = 99;

const ORDINAL_SUFFIXES: Record<number, string> = { 1: "st", 2: "nd", 3: "rd" };

/**
 * 1 -> 1st, 2 -> 2nd, 11 -> 11th, 21 -> 21st.
 *
 * Placements come from placement_points, which is config, so this cannot
 * assume the 1..4 of a Commander pod: a table of 21 would have been "21th".
 */
export function ordinal(n: number): string {
  const teen = n % 100;
  const suffix =
    teen === 11 || teen === 12 || teen === 13 ? "th" : (ORDINAL_SUFFIXES[n % 10] ?? "th");
  return `${n}${suffix}`;
}

/**
 * "1st — 4 pts".
 *
 * Rendered on the placement select and in the elimination form's legends.
 */
export function placementLabel(place: number, points: number): string {
  return `${ordinal(place)} — ${points} pt${points === 1 ? "" : "s"}`;
}

/**
 * How many players sit at one table.
 *
 * Defaults to the number of placement tiers, because those are the finishing
 * positions at a table: placement_points runs 1..4 exactly because a pod seats
 * four, and you cannot come fourth at a table of three. pod_size states it
 * outright for events whose pods do not seat one player per placement.
 */
export function expectedPodSize(podSize: number | null, placements: number[]): number {
  return podSize || placements.length;
}

/**
 * Who a tracker opening this table most likely wants.
 *
 * The first player still in the game who has not entered the round in
 * progress, or, once all of them have, the first of them in the next round.
 * This is what a reload lands on. It used to be seat 1 in the latest round,
 * which after seat 1 had already played meant a tracker reopening the page was
 * shown a turn that was already saved, under a badge small enough to miss.
 */
export function nextUp(
  seating: string[],
  out: Set<string>,
  entered: Set<string>,
  played: number,
): { player: string | null; round_no: number } {
  const stillIn = seating.filter((n) => !out.has(n));
  const active = stillIn.length > 0 ? stillIn : seating;
  if (active.length === 0) return { player: null, round_no: 1 };
  const current = Math.max(played, 1);
  for (const name of active) {
    if (!entered.has(enteredKey(name, current))) return { player: name, round_no: current };
  }
  return { player: active[0]!, round_no: Math.min(current + 1, MAX_ROUNDS) };
}

/** The turn_grid / entered-set key. NUL-separated: a name can hold anything. */
export function enteredKey(player: string, roundNo: number): string {
  return `${player}\u0000${roundNo}`;
}

/**
 * The seat that plays after `player`, skipping anyone already out.
 *
 * Passing the last seat starts the next round. A player knocked out keeps
 * their seat, because their turns still count, but nobody takes turns for
 * them, and landing on them every lap made the tracker reselect by hand.
 */
export function seatAfter(
  seating: string[],
  out: Set<string>,
  player: string,
  roundNo: number,
): { player: string; round_no: number } {
  const i = seating.indexOf(player);
  for (let step = 1; step <= seating.length; step++) {
    const j = (i + step) % seating.length;
    if (!out.has(seating[j]!) || step === seating.length) {
      return {
        player: seating[j]!,
        round_no: Math.min(j <= i ? roundNo + 1 : roundNo, MAX_ROUNDS),
      };
    }
  }
  throw new Error("unreachable: the loop returns on its last step");
}

/**
 * Placement per player going out, from the order they went out in.
 *
 * `rows` is [player, life at death] in the order the tracker listed them,
 * first out first, and `stillIn` is how many were playing before any of it:
 * the first player out of a table of four finishes 4th, so the placements run
 * down from there. Asking for the order and deriving the number is fewer taps
 * than a placement select per row, and it cannot produce two players claiming
 * the same place by accident.
 *
 * `simultaneous` is one attack killing several at once, where there is no
 * order of elimination to list. The event owner's rule ranks those by life at
 * death, least negative higher, so the lowest life went out first and takes
 * the worst placement.
 *
 * Identical totals are a genuine tie, and a tie takes the BEST placement of
 * the block it occupies, leaving the rest unused: two players tied over 3rd
 * and 4th both finish 3rd and nobody finishes 4th. The alternative docks both
 * of them a place for having died at the same moment.
 */
export function finishingOrder(
  rows: [string, number][],
  stillIn: number,
  simultaneous: boolean,
): Map<string, number> {
  // Ascending by life. Array.prototype.sort is stable, which matters: two
  // players on the same life keep the order the tracker listed them in.
  const ordered = simultaneous ? [...rows].sort((a, b) => a[1] - b[1]) : [...rows];
  const places = new Map<string, number>();
  let i = 0;
  while (i < ordered.length) {
    // The list is sorted, so everybody on this life total is contiguous.
    const block = simultaneous
      ? ordered.slice(i).filter((r) => r[1] === ordered[i]![1])
      : [ordered[i]!];
    const place = stillIn - i - (block.length - 1);
    for (const [player] of block) places.set(player, place);
    i += block.length;
  }
  return places;
}

export interface EliminationRow {
  place: number;
  label: string;
  order: string;
}

export interface EliminationPrompt {
  deaths_due: number;
  elimination_rows: EliminationRow[];
  elimination_candidates: string[];
  winner_row: { place: number; label: string } | null;
}

/**
 * The rows to offer for deaths that have been credited but not recorded.
 *
 * A turn form says how many opponents a player eliminated; the dead players'
 * own sections say who they were and in what order they went. Those are two
 * different forms, so the count is the only thing that knows a death is
 * outstanding: eliminations credited on the turns, minus the players already
 * recorded out.
 *
 * Derived on every render rather than set by the save that triggered it, so a
 * reload does not lose the prompt, a second tracker opening the table sees it
 * too, and recording the deaths is what makes it go away. A death nobody was
 * credited for (a concede, a deck-out, a game called on time) never raises the
 * count, and is still recorded on the player's own form.
 */
export function eliminationPrompt(
  seating: string[],
  out: Map<string, number>,
  creditedPerTurn: number[],
  placementPoints: Map<number, number>,
  justCredited = 0,
): EliminationPrompt {
  const places = [...placementPoints.keys()];
  const best = places.length > 0 ? Math.min(...places) : 1;
  const stillIn = seating.filter((n) => !out.has(n));
  const credited = creditedPerTurn.reduce((a, b) => a + b, 0);
  // The winner holds a placement without having gone out, so they are not a
  // recorded death. Counting them as one would hide the last elimination of
  // every game: the one that ends it.
  const recorded = [...out.values()].filter((place) => place !== best).length;
  let due = Math.max(0, Math.min(credited - recorded, stillIn.length));

  // A death nobody was credited for (a suicide, a concede, a deck-out) makes
  // that difference smaller, and can cancel a kill that IS outstanding: credit
  // one elimination, record one suicide, and the count nets to nothing with a
  // death still unrecorded. Counts alone cannot tell those apart, so the turn
  // that credits the kill raises the rows itself, and the derived count only
  // has to keep them there afterwards. A reload in that state still loses the
  // prompt, and the player's own form is the fallback it always was.
  if (justCredited > 0) due = Math.max(due, Math.min(justCredited, stillIn.length));

  const label = (place: number): string => {
    const points = placementPoints.get(place);
    return points === undefined ? ordinal(place) : placementLabel(place, points);
  };

  return {
    deaths_due: due,
    // Worst placement first: the first player out of a table of four finishes
    // 4th, so the order of the rows IS the order of elimination.
    elimination_rows: Array.from({ length: due }, (_, i) => ({
      place: stillIn.length - i,
      label: label(stillIn.length - i),
      // The row is headed by its place in the order, because that is what the
      // tracker is being asked for; the placement it earns is shown
      // underneath as the consequence.
      order: ordinal(i + 1),
    })),
    elimination_candidates: stillIn,
    // When these deaths would leave one player standing, that player has won,
    // and their own three numbers are the ones a tracker has to come back for
    // after the table has broken up. Offered in the same form.
    winner_row:
      due > 0 && stillIn.length - due === 1 ? { place: best, label: label(best) } : null,
  };
}
