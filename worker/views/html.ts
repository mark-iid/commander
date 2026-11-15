import type { HtmlEscapedString } from "hono/utils/html";

/**
 * What hono/html's `html` tagged template actually returns.
 *
 * It is a union because an interpolated value may be a promise, and the
 * template has to stay a promise if one was. Every view here interpolates only
 * resolved values, so the runtime result is always a string, but writing the
 * union is cheaper than asserting it away in each view. `c.html()` takes both.
 */
export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;
