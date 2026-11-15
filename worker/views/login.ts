// The sign-in page. One shared passcode, no accounts.

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
