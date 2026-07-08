import { test } from "node:test";
import assert from "node:assert/strict";
import { audioName } from "../lib/tts.mjs";

test("audioName is deterministic and content-addressed", () => {
  const a = audioName("en-US-AndrewNeural", "hello world");
  const b = audioName("en-US-AndrewNeural", "hello world");
  const c = audioName("en-US-AndrewNeural", "different");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^audio\/[0-9a-f]{16}\.mp3$/);
});
