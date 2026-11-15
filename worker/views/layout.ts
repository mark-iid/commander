// The shell every surface but the projected board sits in.
//
// Ported from app/templates/base.html. The HTMX configuration and the failed
// request banner come across verbatim, because they are about the venue's wifi
// rather than about the server: a save that did not land has to say so, and
// htmx shows nothing by default for a dropped connection.
//
// The content hash on asset URLs is gone; worker/assets.ts has what replaced
// it, what was verified and how.

import { html, raw } from "hono/html";
import type { Html } from "./html.ts";

export interface LayoutOptions {
  title?: string;
  heading?: string;
  extraHead?: Html;
}

export function layout(content: Html, options: LayoutOptions = {}): Html {
  const title = options.title ?? "Commander Tracker";
  const heading = options.heading ?? "Commander Tracker";
  return html`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${options.extraHead ?? ""}
  <link rel="stylesheet" href="/static/app.css">
  <!-- Vendored, not CDN: entry must keep working if the venue's wifi doesn't. -->
  <script src="/static/htmx.min.js" defer></script>
  ${raw(`<script>
    document.addEventListener("DOMContentLoaded", function () {
      // htmx ignores 4xx responses by default; we return 422 with the form
      // re-rendered around inline field errors, so let that one swap.
      htmx.config.responseHandling = [
        { code: "204", swap: false },
        { code: "[23]..", swap: true },
        { code: "422", swap: true },
        { code: "[45]..", swap: false, error: true },
      ];
      // Venue wifi can hang a request rather than fail it. Without a timeout
      // the Save button just sits there; with one, the tracker is told.
      htmx.config.timeout = 15000;
    });

    // A save that did not land has to say so. htmx neither swaps a failed
    // response nor shows anything for a dropped connection, so a tracker
    // tapping Save on bad wifi saw nothing happen and moved on, and the turn
    // was gone. Cleared by the next request that reaches the server.
    (function () {
      function show(evt, why) {
        var box = document.getElementById("request-failed");
        if (!box) return;
        var saving = (evt.detail.requestConfig || {}).verb === "post";
        box.querySelector("strong").textContent = saving ? "Not saved." : "Did not load.";
        box.querySelector("span").textContent = why + (saving ? " Tap Save again." : " Try again.");
        box.hidden = false;
      }
      document.addEventListener("htmx:sendError", function (evt) {
        show(evt, "Could not reach the server. Check the wifi.");
      });
      document.addEventListener("htmx:timeout", function (evt) {
        show(evt, "The server took too long to answer.");
      });
      document.addEventListener("htmx:responseError", function (evt) {
        // A signed-out session answers 401 with HX-Redirect, and htmx is about
        // to navigate to the login page. That is not a failure to report.
        if (evt.detail.xhr.getResponseHeader("HX-Redirect")) return;
        show(evt, "The server hit an error (" + evt.detail.xhr.status + ").");
      });
      document.addEventListener("htmx:afterRequest", function (evt) {
        var box = document.getElementById("request-failed");
        if (box && evt.detail.successful) box.hidden = true;
      });
    })();
  </script>`)}
</head>
<body>
  <header class="topbar">
    <span class="brand">${heading}</span>
    <nav>
      <a href="/entry">Entry</a>
      <a href="/display">Display</a>
      <a href="/results">Results</a>
      <a href="/admin">Admin</a>
    </nav>
  </header>
  <main>
    ${content}
  </main>
  <div id="request-failed" class="request-failed" role="alert" hidden>
    <strong></strong> <span></span>
  </div>
</body>
</html>`;
}
