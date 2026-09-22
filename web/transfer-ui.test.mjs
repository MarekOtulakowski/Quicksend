// Verifies dedupeFilename, the pure logic behind "choose a save
// folder once" (see docs/DECISIONS.md): writing straight into a
// chosen folder has no per-file dialog left for a user to notice and
// rename a colliding filename themselves, so this has to do it.
//
// Run with: node --test web/transfer-ui.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { dedupeFilename } from "./transfer-ui.js";

test("dedupeFilename returns the name unchanged the first time it's seen", () => {
  const used = new Set();
  assert.equal(dedupeFilename(used, "photo.jpg"), "photo.jpg");
  assert.ok(used.has("photo.jpg"));
});

test("dedupeFilename appends (1), (2), ... before the extension on repeats", () => {
  const used = new Set();
  assert.equal(dedupeFilename(used, "photo.jpg"), "photo.jpg");
  assert.equal(dedupeFilename(used, "photo.jpg"), "photo (1).jpg");
  assert.equal(dedupeFilename(used, "photo.jpg"), "photo (2).jpg");
});

test("dedupeFilename handles a name with no extension", () => {
  const used = new Set();
  assert.equal(dedupeFilename(used, "README"), "README");
  assert.equal(dedupeFilename(used, "README"), "README (1)");
});

test("dedupeFilename skips over a candidate that's already taken by coincidence", () => {
  const used = new Set(["photo (1).jpg"]);
  // "photo.jpg" collides, and its first choice of disambiguator is
  // already (coincidentally) taken too — must skip past it to (2).
  used.add("photo.jpg");
  assert.equal(dedupeFilename(used, "photo.jpg"), "photo (2).jpg");
});

test("dedupeFilename treats different names independently", () => {
  const used = new Set();
  assert.equal(dedupeFilename(used, "a.txt"), "a.txt");
  assert.equal(dedupeFilename(used, "b.txt"), "b.txt");
  assert.equal(dedupeFilename(used, "a.txt"), "a (1).txt");
});
