// shared/source-edit.ts
import { z as z2 } from "zod";

// shared/affine-transform.ts
import { z } from "zod";
var affineTransformSchema = z.object({
  version: z.literal(1),
  rotationDeg: z.number().finite().min(-180).max(180).optional(),
  scaleX: z.number().finite().min(0.1).max(3).optional(),
  scaleY: z.number().finite().min(0.1).max(3).optional()
}).strict();

// shared/source-edit.ts
var segmentDuration = (segment) => (segment.srcEnd - segment.srcStart) / (segment.speed ?? 1);
function applySegmentPlacementToAll(edit, index, defaults) {
  const selected = edit.segments[index];
  if (!selected) throw new Error("Select a video segment first.");
  const placement = {
    xPct: selected.transform?.xPct ?? defaults?.xPct ?? 50,
    yPct: selected.transform?.yPct ?? defaults?.yPct ?? 50,
    zoom: selected.transform?.zoom ?? defaults?.zoom ?? 1,
    ...defaults?.affine || edit.segments.some((s) => s.transform?.affine) ? { affine: selected.transform?.affine ?? defaults?.affine ?? { version: 1 } } : {}
  };
  return { ...edit, segments: edit.segments.map((segment) => ({
    ...segment,
    transform: { ...segment.transform, ...placement }
  })) };
}
var sourceEditSchema = z2.object({
  version: z2.literal(2).optional(),
  segments: z2.array(z2.object({
    instanceId: z2.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/).optional(),
    outputStart: z2.number().finite().min(0).max(1800).optional(),
    punchScale: z2.number().finite().min(1).max(1.15).optional(),
    srcStart: z2.number().finite().min(0).max(1800),
    srcEnd: z2.number().finite().positive().max(1800),
    speed: z2.number().finite().min(0.25).max(4).optional(),
    transform: z2.object({
      affine: affineTransformSchema.optional(),
      xPct: z2.number().finite().min(0).max(100).optional(),
      yPct: z2.number().finite().min(0).max(100).optional(),
      zoom: z2.number().finite().min(1).max(3).optional(),
      cropLeftPct: z2.number().finite().min(0).max(40).optional(),
      cropRightPct: z2.number().finite().min(0).max(40).optional(),
      cropTopPct: z2.number().finite().min(0).max(40).optional(),
      cropBottomPct: z2.number().finite().min(0).max(40).optional()
    }).strict().optional()
  }).strict()).min(1).max(40)
}).strict().superRefine((edit, ctx) => {
  let previousEnd = 0;
  const ids = /* @__PURE__ */ new Set();
  edit.segments.forEach((segment, index) => {
    if (segment.srcEnd <= segment.srcStart || (edit.version === 2 ? segment.outputStart === void 0 || !segment.instanceId || ids.has(segment.instanceId) || segment.outputStart < previousEnd - 1e-8 : segment.srcStart < previousEnd || segment.instanceId !== void 0 || segment.outputStart !== void 0)) {
      ctx.addIssue({ code: "custom", path: ["segments", index], message: edit.version === 2 ? "Source instances require unique IDs and ordered, non-overlapping output positions." : "Segments must be ordered, non-overlapping and have positive duration." });
    }
    if (segment.instanceId) ids.add(segment.instanceId);
    previousEnd = edit.version === 2 ? (segment.outputStart ?? 0) + segmentDuration(segment) : segment.srcEnd;
  });
  if (outputDuration(edit) > 1800) ctx.addIssue({ code: "custom", message: "Edited output exceeds 30 minutes." });
});
function outputDuration(edit) {
  return sourceInstances(edit).at(-1)?.end ?? 0;
}
function segmentAtOutput(edit, at) {
  if (!edit) return void 0;
  for (const { segment, index, start, end } of sourceInstances(edit)) {
    if (at >= start && at < end) return { index, segment };
  }
  return void 0;
}
function validateSourceEdit(value, sourceDuration = 1800) {
  const edit = sourceEditSchema.parse(value);
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0 || edit.segments.some((segment) => segment.srcEnd > sourceDuration + 1e-3)) {
    throw new Error("A source segment extends beyond the original video.");
  }
  return edit;
}
function srcToOut(time, edit) {
  if (!edit) return time;
  for (const { segment, index, start } of sourceInstances(edit)) {
    if (time >= segment.srcStart && (time < segment.srcEnd || index === edit.segments.length - 1 && time === segment.srcEnd)) {
      return start + (time - segment.srcStart) / (segment.speed ?? 1);
    }
  }
  return null;
}
function srcToOutputs(time, edit) {
  return sourceInstances(edit).flatMap(({ segment, start }) => time >= segment.srcStart && time < segment.srcEnd ? [start + (time - segment.srcStart) / (segment.speed ?? 1)] : []);
}
function outToSrc(time, edit, edge = "start") {
  if (!edit) return time;
  if (!Number.isFinite(time) || time < 0) return null;
  const instances = sourceInstances(edit);
  const ordered = edge === "end" ? [...instances].reverse() : instances;
  for (const { segment, start, end, index } of ordered) {
    if (time >= start && (time < end || time === end && (edge === "end" || index === edit.segments.length - 1))) {
      if (edge === "end" && time === start && index > 0 && instances[index - 1].end === start) continue;
      return segment.srcStart + (time - start) * (segment.speed ?? 1);
    }
  }
  return null;
}
function remapCaptionWords(words, edit) {
  if (!edit) return words;
  if (edit.version === 2) {
    const projected = [];
    const last = /* @__PURE__ */ new Map();
    sourceInstances(edit).forEach(({ segment, start: output, index }) => words.forEach((word, sourceIndex) => {
      const from = Math.max(word.start, segment.srcStart), to = Math.min(word.end, segment.srcEnd);
      if (to <= from) return;
      const start = output + (from - segment.srcStart) / (segment.speed ?? 1);
      const end = output + (to - segment.srcStart) / (segment.speed ?? 1);
      const previous = last.get(sourceIndex);
      if (previous && previous.index === index - 1 && previous.segment.srcEnd === segment.srcStart && (previous.segment.speed ?? 1) === (segment.speed ?? 1) && Math.abs(previous.word.end - start) < 1e-8) {
        previous.word.end = end;
        last.set(sourceIndex, { ...previous, segment, index });
      } else {
        const copy = {
          ...word,
          sourceIndex: word.sourceIndex ?? sourceIndex,
          sourceInstanceId: segment.instanceId,
          start,
          end
        };
        projected.push(copy);
        last.set(sourceIndex, { word: copy, segment, index });
      }
    }));
    return projected.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  const result = [];
  for (const word of words) {
    let output = 0, start = Infinity, end = -Infinity;
    for (const segment of edit.segments) {
      const speed = segment.speed ?? 1;
      if (word.end > segment.srcStart && word.start < segment.srcEnd) {
        start = Math.min(start, output + (Math.max(word.start, segment.srcStart) - segment.srcStart) / speed);
        end = Math.max(end, output + (Math.min(word.end, segment.srcEnd) - segment.srcStart) / speed);
      }
      output += (segment.srcEnd - segment.srcStart) / speed;
    }
    if (Number.isFinite(start) && end > start) result.push({ ...word, start, end });
  }
  return result;
}
function moveSourceInstances(edit, indices, delta, duration = 1800) {
  const next = asSourceInstances(edit);
  if (!indices.length || !Number.isFinite(delta) || indices.some((index) => !next.segments[index])) throw new Error("Select existing source shots.");
  const ids = new Set(indices.map((index) => next.segments[index]?.instanceId));
  const placed = next.segments.filter((segment) => ids.has(segment.instanceId)).map((segment) => ({ ...segment, outputStart: segment.outputStart + delta }));
  for (const segment of next.segments.filter((segment2) => !ids.has(segment2.instanceId))) {
    let start = segment.outputStart;
    for (const occupied of [...placed].sort((a, b) => a.outputStart - b.outputStart)) {
      if (start < occupied.outputStart + segmentDuration(occupied) - 1e-8 && start + segmentDuration(segment) > occupied.outputStart + 1e-8)
        start = occupied.outputStart + segmentDuration(occupied);
    }
    placed.push({ ...segment, outputStart: start });
  }
  next.segments = placed.sort((a, b) => a.outputStart - b.outputStart);
  return validateSourceEdit(next, duration);
}
var sourceItemId = (segment, index) => `source-segment-${segment.instanceId ?? index}`;
function asSourceInstances(edit) {
  if (edit.version === 2) return structuredClone(edit);
  return { version: 2, segments: sourceInstances(edit).map(({ segment, index, start }) => ({ ...segment, instanceId: String(index), outputStart: start })) };
}
function sourceInstances(edit) {
  let cursor = 0;
  return edit.segments.map((segment, index) => {
    const start = edit.version === 2 ? segment.outputStart : cursor;
    const end = start + segmentDuration(segment);
    cursor = end;
    return { segment, index, start, end };
  });
}
function sourceItemIndex(id, edit) {
  const suffix = id.replace("source-segment-", "");
  return edit.version === 2 ? edit.segments.findIndex((segment) => segment.instanceId === suffix) : Number(suffix);
}
export {
  applySegmentPlacementToAll,
  asSourceInstances,
  moveSourceInstances,
  outToSrc,
  outputDuration,
  remapCaptionWords,
  segmentAtOutput,
  segmentDuration,
  sourceEditSchema,
  sourceInstances,
  sourceItemId,
  sourceItemIndex,
  srcToOut,
  srcToOutputs,
  validateSourceEdit
};
