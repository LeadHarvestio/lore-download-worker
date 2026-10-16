// Output-time segment lookup, identical to shared/source-edit.ts.
export function segmentAtOutput(edit, at) {
  if (!edit) return undefined;
  let cursor = 0;
  for (let index = 0; index < edit.segments.length; index++) {
    const segment = edit.segments[index];
    cursor += (segment.srcEnd - segment.srcStart) / (segment.speed ?? 1);
    if (at < cursor || index === edit.segments.length - 1) return { index, segment };
  }
}
