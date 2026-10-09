import test from "node:test";
import assert from "node:assert/strict";
import { tokenize } from "./headline.js";

test("every headline word can be highlighted, including more than ten selections", () => {
  const text = "one two three four five six seven eight nine ten eleven twelve";
  assert.ok(tokenize(text, text.split(" ")).every(word => word.hl));
});
test("positioned highlights distinguish repeated words and preserve legacy phrases", () => {
  const text = "Kai reacts while Kai watches";
  assert.deepEqual(tokenize(text, ["@word:3:Kai"]).map(word => word.hl), [false, false, false, true, false]);
  assert.deepEqual(tokenize("  Kai reacts  while Kai watches ", ["@word:3:Kai"]).map(word => word.hl), [false, false, false, true, false]);
  assert.deepEqual(tokenize(text, ["Kai reacts"]).map(word => word.hl), [true, true, false, false, false]);
  assert.ok(tokenize(text, ["@word:3:Other"]).every(word => !word.hl));
});
