import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, generateScript } from "../lib/scriptgen.mjs";

const poi = { name: "Gas Works Park", side: "left", sourceText: "A public park on Lake Union built on a former gasification plant." };

test("buildPrompt grounds on source text, forbids invention, includes side", () => {
  const p = buildPrompt(poi, "left");
  assert.match(p, /Gas Works Park/);
  assert.match(p, /former gasification plant/);
  assert.match(p, /on your left/i);
  assert.match(p, /do not invent/i);
});

test("generateScript returns the model's text", async () => {
  const client = { messages: { create: async () => ({ content: [{ type: "text", text: "On your left, that's Gas Works Park..." }] }) } };
  const out = await generateScript(poi, "left", { client });
  assert.match(out, /Gas Works Park/);
});
