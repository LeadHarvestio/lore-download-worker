import { test } from "node:test";
import assert from "node:assert/strict";
import { censorText, censorWords, containsExpletive, expletiveRanges, muteVolumeFilter } from "./censorship.js";

test("literal masks preserve case, inflections, punctuation and compounds", () => {
  assert.equal(censorText("fuck bitch shit nigga"), "f*ck b*tch sh*t n*gga");
  assert.equal(censorText("FUCKING! Motherfucker, bitches' bullshit."), "F*CKING! Motherf*cker, b*tches' bullsh*t.");
});
test("ordinary words are not substring-censored", () => {
  const ordinary = "class assistant assignment Scunthorpe hello shitake caféshit";
  assert.equal(censorText(ordinary), ordinary);
});
test("raw words remain reversible and masked words remain detectable", () => {
  const raw = [{ text: "shit!", start: 1, end: 1.4 }];
  assert.equal(censorWords(raw)[0].text, "sh*t!");
  assert.equal(raw[0].text, "shit!");
  assert.equal(containsExpletive("sh*t!"), true);
});
test("voice muting is limited to padded offending timestamps", () => {
  const ranges = expletiveRanges([{ word: "hello", start: 0, end: .3 }, { word: "fuck", start: 1, end: 1.4 }, { word: "shit", start: 1.4, end: 1.7 }], 4);
  assert.deepEqual(ranges, [{ start: .96, end: 1.76 }]);
  assert.equal(muteVolumeFilter(ranges), "volume=0:enable='between(t,0.960,1.760)'");
  assert.equal(muteVolumeFilter([]), "");
});
