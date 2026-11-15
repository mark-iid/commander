// Serving the stylesheets and the vendored htmx.
//
// The content hash the Jinja templates put on every asset URL is gone. It
// existed because the app was served through a Cloudflare Tunnel and the edge
// cached /static for four hours, so a new load could be handed a stale
// stylesheet long after a deploy. Workers Assets answers with
// `Cache-Control: public, max-age=0, must-revalidate` and a content ETag
// instead, so a new load revalidates and gets the current file. Verified
// against `wrangler dev`, which serves the real asset pipeline; the vitest
// runtime wires the binding but does not serve the directory, so that half
// cannot be asserted in the suite.
//
// Worth being precise about what neither approach fixes: a page that is never
// reloaded at all, which is exactly the projector. Its HTML would have to be
// fetched again to learn about a new hashed URL, so the hash never helped
// there either. What changed is that a fresh load is now always current.

/**
 * Where an asset lives inside the assets directory.
 *
 * Pages reference /static/*. The binding serves files relative to its own
 * root, so static/app.css is /app.css to it, and forwarding the request
 * untouched returns 404 for every asset on every page. A function so it can be
 * tested without an asset server.
 */
export function assetPath(pathname: string): string {
  return pathname.startsWith("/static/") ? pathname.slice("/static".length) : pathname;
}

export function assetRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = assetPath(url.pathname);
  return new Request(url, request);
}
