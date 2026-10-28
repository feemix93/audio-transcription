import test from "node:test";
import assert from "node:assert/strict";
import { extensionOf, ALLOWED_EXTENSIONS } from "../src/audio/media.js";

test("extensionOf normalizes extension case", () => {
  assert.equal(extensionOf("recording.MP3"), ".mp3");
});

test("common audio formats are allowed", () => {
  for (const ext of [".mp3", ".wav", ".m4a", ".webm", ".flac"]) {
    assert.equal(ALLOWED_EXTENSIONS.has(ext), true);
  }
});

test("non-audio extensions are not allowed", () => {
  assert.equal(ALLOWED_EXTENSIONS.has(".exe"), false);
  assert.equal(ALLOWED_EXTENSIONS.has(".pdf"), false);
});
