// Typed view of the entry-rules fixture, so the one unavoidable assertion
// lives in one place.
//
// A JSON import is inferred structurally, which for a list of cases means a
// union of per-case object shapes: `places` on a case with two players is
// `{ Dave: number; Carol: number }` rather than Record<string, number>, and no
// direct cast from that union is accepted. Nothing is really unchecked by
// asserting it, because every field is then compared against the port's output
// and a wrong shape shows up as a failed assertion.

import data from "./entry-rules.json" with { type: "json" };

export interface OrdinalCase {
  n: number;
  ordinal: string;
}

export interface PlacementLabelCase {
  place: number;
  points: number;
  label: string;
}

export interface FinishingOrderCase {
  rows: [string, number][];
  still_in: number;
  simultaneous: boolean;
  places: Record<string, number>;
}

export interface EliminationRowCase {
  place: number;
  label: string;
  order: string;
}

export interface EliminationPromptCase {
  seating: string[];
  out: Record<string, number>;
  credits: [[string, number], number][];
  just_credited: number;
  deaths_due: number;
  elimination_rows: EliminationRowCase[];
  elimination_candidates: string[];
  winner_row: { place: number; label: string } | null;
}

export interface NextUpCase {
  out: string[];
  entered: [string, number][];
  played: number;
  player: string | null;
  round_no: number;
}

export interface SeatAfterCase {
  out: string[];
  player: string;
  round_no: number;
  next_player: string;
  next_round: number;
}

export interface PodSizeCase {
  pod_size: number | null;
  placements: number[];
  expected: number;
}

export interface EntryRulesFixture {
  note: string;
  placement_points: Record<string, number>;
  table: string[];
  ordinals: OrdinalCase[];
  placement_labels: PlacementLabelCase[];
  finishing_orders: FinishingOrderCase[];
  elimination_prompts: EliminationPromptCase[];
  next_up: NextUpCase[];
  seat_after: SeatAfterCase[];
  pod_sizes: PodSizeCase[];
}

export const entryRules = data as unknown as EntryRulesFixture;
