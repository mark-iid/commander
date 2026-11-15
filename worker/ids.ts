// Path and query values that name a row by id.

/**
 * SQLite stores INTEGER as signed 64-bit, so an id wider than that cannot be
 * bound at all. Only the upper bound is checked, because the shape test below
 * already rejects anything with a sign in it.
 */
const SQLITE_INT_MAX = 9223372036854775807n;

/**
 * A path segment or query value to a row id, or null.
 *
 * Strict on purpose. An id has no business meaning " 12 ", "1_2" or the
 * non-ASCII digits that Number() and parseInt() variously accept, and an id
 * wider than SQLite can bind would fail inside the query rather than as this
 * helper's polite refusal. BigInt is used for the range test because a Number
 * loses precision above 2^53 and would compare equal to the wrong things.
 */
export function idOf(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = BigInt(raw);
  if (value > SQLITE_INT_MAX) return null;
  return Number(value);
}
