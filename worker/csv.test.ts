// The CSV writer, held to Python's csv.writer.
//
// The exports are the take-home record of a night and the data is free text
// people typed: a deck called `Niv-Mizzet, Parun` has a comma in it, and a
// roster name could contain a quote or a newline. Getting the quoting wrong
// shifts every column after it, which is invisible until somebody reads the
// sheet months later.
//
// The byte comparison in results.test.ts does not cover this on its own: no
// field in the real Fall 2026 night contains an ASCII double quote, so
// deleting the quote-doubling left every other test green. Verified by
// mutation, which is why this file exists.
//
// shared/fixtures/csv-quoting.json holds Python's own rendering of rows chosen
// to exercise every branch of QUOTE_MINIMAL, so this is parity with the
// implementation that produced the committed exports rather than with a
// reading of RFC 4180.

import { expect, test } from "vitest";
import quoting from "../shared/fixtures/csv-quoting.json" with { type: "json" };
import { slug, stamp, toCsv } from "./csv.ts";

test("it writes what Python's csv.writer writes", () => {
  const rows = quoting.rows as (string | number | null)[][];
  expect(toCsv(rows)).toBe(quoting.csv);
});

test("the cases that matter, named so a failure says which", () => {
  expect(toCsv([["plain"]])).toBe("plain\r\n");
  // A comma forces quoting.
  expect(toCsv([["Niv-Mizzet, Parun"]])).toBe('"Niv-Mizzet, Parun"\r\n');
  // A double quote forces quoting AND is doubled inside.
  expect(toCsv([['he said "hi"']])).toBe('"he said ""hi"""\r\n');
  expect(toCsv([['"']])).toBe('""""\r\n');
  // Newlines and carriage returns force quoting; the field keeps them.
  expect(toCsv([["line\nbreak"]])).toBe('"line\nbreak"\r\n');
  expect(toCsv([["carriage\rreturn"]])).toBe('"carriage\rreturn"\r\n');
  // null and undefined are empty, not the word "null".
  expect(toCsv([[null, undefined, "", 0]])).toBe(",,,0\r\n");
  // Nothing else is quoted: a semicolon or a space is not special.
  expect(toCsv([[" leading", "semi;colon"]])).toBe(" leading,semi;colon\r\n");
});

test("the filename stem strips what a filesystem would not thank us for", () => {
  expect(slug("Fall 2026 Battle of the Commanders")).toBe(
    "fall-2026-battle-of-the-commanders",
  );
  // Punctuation becomes hyphens, one per character and runs not collapsed,
  // which is what the FastAPI app did. Checked against it:
  //   "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")
  expect(slug("Jim's Night / Round #1")).toBe("jim-s-night---round--1");
  // Letters keep their accents, because Python's isalnum() is Unicode-aware.
  // An ASCII-only character class here would give "caf--night".
  expect(slug("Caf\u00e9 Night")).toBe("caf\u00e9-night");
  expect(slug("\u6771\u4eac Night")).toBe("\u6771\u4eac-night");
  // An event named entirely in punctuation still produces a usable name.
  expect(slug("!!!")).toBe("event");
  expect(slug("")).toBe("event");
});

test("the stamp is read in the timezone it is given", () => {
  // 2026-11-15T02:30Z is still the 14th in New York. A Worker has no local
  // zone, so without this the one artefact people keep carries tomorrow's
  // date for any evening download.
  const at = new Date("2026-11-15T02:30:00Z");
  expect(stamp(at, "UTC")).toBe("20261115-0230");
  expect(stamp(at, "America/New_York")).toBe("20261114-2130");
});
