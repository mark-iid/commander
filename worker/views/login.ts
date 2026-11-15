// Ported from app/templates/auth/login.html.
//
// The transport warning that template carried is gone with the thing it warned
// about: it fired when the page was served over plain HTTP while cookies were
// Secure, which happened by reaching the container directly on the LAN. The
// Worker answers on one HTTPS hostname and browsers treat localhost as secure,
// so there is no longer a case where a correct passcode lands back here.

import { html } from "hono/html";
import type { Html } from "./html.ts";
import { layout } from "./layout.ts";

export function loginPage(next: string, error: string | null): Html {
  return layout(
    html`<h1>Sign in</h1>

<form class="card${error ? " has-errors" : ""}" method="post" action="/login">
  <input type="hidden" name="next" value="${next}">

  <div class="card-head">
    <h2>Tracker passcode</h2>
    ${error ? html`<span class="badge bad">${error}</span>` : ""}
  </div>

  <label class="field">
    <span>Passcode</span>
    <!-- autofocus + current-password so phone keyboards and password managers
         behave; trackers sign in on their own devices at the table. -->
    <input type="password" name="passcode" autocomplete="current-password"
           autocapitalize="none" autocorrect="off" spellcheck="false" autofocus required>
    <small>Shared passcode for this event. Ask the organiser.</small>
  </label>

  <div class="actions">
    <button type="submit">Sign in</button>
    <span class="hint">Signing in covers data entry and admin on this device.</span>
  </div>
</form>`,
    { title: "Sign in · Commander Tracker" },
  );
}
