// Typed view of the golden fixture, so both test files agree on its shape and
// the one unavoidable assertion lives in one place.
//
// A JSON import widens string literals: `agg: "max"` in the file arrives as
// `string`, which does not satisfy the "max" | "min" union the engine takes.
// Nothing is really unchecked by asserting it, because the golden test compares
// the whole computed result against the recorded output, where a wrong `agg`
// shows up as a different winner.

import type {
  EventConfigInput,
  GamePlayerStat,
  PlayerStanding,
  PrizeResult,
} from "../scoring.ts";
import data from "./fall-2026.json" with { type: "json" };

export interface Fixture extends EventConfigInput {
  note: string;
  roster: string[];
  /** The rows as stored, keyed by table. Phase 1 replays these against D1. */
  raw: Record<string, Record<string, number | string | null>[]>;
  /** What the aggregation query makes of `raw`. */
  derived: GamePlayerStat[];
  /** What the scoring engine makes of `derived`. */
  expected: {
    standings: PlayerStanding[];
    ranked: [number, string][];
    prizes: PrizeResult[];
  };
}

export const fixture = data as unknown as Fixture;
