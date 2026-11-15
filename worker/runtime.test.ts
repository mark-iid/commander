// The runtime itself, rather than anything built on it.
//
// Worth its own file because the other Worker tests would pass against a
// convincing fake: these assert that the thing under them really is workerd
// with a real D1 binding and the migration applied from migrations/. D1
// enforcing foreign keys is the one that matters, since the node:sqlite tests
// have to turn that on by hand and could therefore be testing a looser
// database than production runs.
import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import app from "./index.ts";

test("D1 has the schema the migration builds", async () => {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all<{ name: string }>();
  const tables = results.map((r) => r.name);
  expect(tables).toContain("events");
  expect(tables).toContain("turn_damage");
  expect(tables).toContain("active_event");
});

test("D1 enforces the constraints the migration declares", async () => {
  await env.DB.prepare("INSERT INTO events (event_id, name) VALUES (1, 'Night')").run();
  await expect(
    env.DB.prepare("INSERT INTO pods (event_id, label, position) VALUES (99, 'A', 1)").run(),
  ).rejects.toThrow();
});

test("the Worker answers", async () => {
  const res = await app.request("/", {}, env);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Commander Tracker");
});
