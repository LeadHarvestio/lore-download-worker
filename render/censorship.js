const rules = [
  ["(?:mother)?fuck(?:s|ed|ing|in|er|ers|head|heads|face|faces|boy|boys)?", "fuck", 1],
  ["bitch(?:es|y|ing|ed)?", "bitch", 1],
  ["(?:bull|horse|dip|bat)?shit(?:s|ty|ting|ted|head|heads|show|shows|bag|bags)?", "shit", 2],
  ["nigg(?:a|as|er|ers)", "nigg", 1],
  ["(?:dumb|jack|bad)?ass(?:es|hole|holes|hat|hats|wipe|wipes)?", "ass", 1],
  ["bastard(?:s)?", "bastard", 1],
  ["dick(?:s|head|heads)?", "dick", 1],
  ["cock(?:s|sucker|suckers)?", "cock", 1],
  ["puss(?:y|ies)", "puss", 1],
  ["cunt(?:s)?", "cunt", 1],
  ["twat(?:s)?", "twat", 2],
  ["whore(?:s)?", "whore", 2],
  ["slut(?:s|ty)?", "slut", 2],
  ["(?:god)?damn(?:s|ed|ing|it)?", "damn", 1],
  ["hell", "hell", 1]
];
const boundary = (pattern) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "giu");
const masked = boundary("(?:mother)?f\\*+(?:ck|k)(?:s|ed|ing|in|er|ers)?|b\\*tch(?:es|y|ing|ed)?|(?:bull|horse|dip|bat)?sh\\*t(?:s|ty|ting|ted|head|heads|show|shows)?|n\\*gg(?:a|as|er|ers)|a\\*s(?:es|hole|holes)?");
function censorText(text) {
  return rules.reduce((result, [pattern, root, offset]) => result.replace(boundary(pattern), (match) => {
    const index = match.toLowerCase().lastIndexOf(root) + offset;
    return match.slice(0, index) + "*" + match.slice(index + 1);
  }), text);
}
function containsExpletive(text) {
  masked.lastIndex = 0;
  return censorText(text) !== text || masked.test(text);
}
function censorWords(words) {
  return words.map((w) => ({
    ...w,
    ...typeof w.word === "string" ? { word: censorText(w.word) } : {},
    ...typeof w.text === "string" ? { text: censorText(w.text) } : {}
  }));
}
function expletiveRanges(words, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const ranges = words.filter((w) => containsExpletive(w.word ?? w.text ?? "") && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start).map((w) => ({ start: Math.max(0, w.start - 0.04), end: Math.min(duration, w.end + 0.06) })).filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
function muteVolumeFilter(ranges) {
  if (!ranges.length) return "";
  for (const r of ranges) if (!Number.isFinite(r.start) || !Number.isFinite(r.end) || r.start < 0 || r.end <= r.start) throw new Error("Invalid mute interval.");
  const expression = ranges.map((r) => `between(t,${r.start.toFixed(3)},${r.end.toFixed(3)})`).join("+");
  return `asetnsamples=n=441:p=0,volume=0:enable='${expression}'`;
}
export {
  censorText,
  censorWords,
  containsExpletive,
  expletiveRanges,
  muteVolumeFilter
};
