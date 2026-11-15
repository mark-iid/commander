// CSV writing: RFC 4180 with QUOTE_MINIMAL quoting and CRLF line endings.
//
// Hand-rolled because the exports have to stay readable in a spreadsheet and
// the data is free text people typed: a deck called `Niv-Mizzet, Parun` has a
// comma in it, and a player could put a quote or a newline in a roster name.
// Getting the quoting wrong shifts every column after it, which is the kind of
// corruption that is invisible until someone reads the sheet months later.

/** One field, quoted only when it has to be, like csv.writer's QUOTE_MINIMAL. */
function field(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replaceAll('"', '""') + '"';
  return s;
}

/**
 * Rows to a CSV document.
 *
 * CRLF line endings, which is what csv.writer emits by default and what RFC
 * 4180 asks for; Excel is the reason it matters.
 */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map(field).join(",")).join("\r\n") + "\r\n";
}

/**
 * A filename stem from the event's name: lowercase, non-alphanumerics to
 * hyphens, trimmed.
 */
export function slug(name: string): string {
  // Letters and numbers in any script, not just ASCII: an event called
  // "Caf\u00e9 Night" keeps its accent rather than becoming "caf--night".
  //
  // Runs of hyphens are not collapsed: one hyphen per non-alphanumeric
  // character, so the sort order of a folder of exports is predictable.
  const out = [...name.toLowerCase()]
    .map((c) => (/[\p{L}\p{N}]/u.test(c) ? c : "-"))
    .join("")
    .replace(/^-+|-+$/g, "");
  return out || "event";
}

/**
 * The timestamp in the export filename, in the event's own timezone.
 *
 * Workers run in UTC with no local zone, so a download at 10pm Eastern would
 * otherwise be stamped with the next day's date. EVENT_TIMEZONE names the
 * room's clock.
 */
export function stamp(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}`;
}

/** "14 Nov 2026, 22:41" in the event's timezone, for the sheet's header. */
export function generatedAt(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}`;
}

export function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: {
      // charset is explicit because the decks carry typographic quotes and
      // accented names, and a spreadsheet guessing the encoding mangles them.
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
