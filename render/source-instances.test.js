import test from "node:test";
import assert from "node:assert/strict";
import { validateSourceEdit, sourceEditDuration, sourceEditParts } from "./source-edit.js";

const recipe = () => ({ version: 2, segments: [
  { instanceId: "C", srcStart: 4, srcEnd: 6, outputStart: 0 },
  { instanceId: "A", srcStart: 0, srcEnd: 2, speed: 2, outputStart: 2.5 },
  { instanceId: "B", srcStart: 2, srcEnd: 4, outputStart: 3.5 },
  { instanceId: "repeat-C", srcStart: 4, srcEnd: 5, outputStart: 5.5 },
] });

test("v2 accepts reordered and repeated source ranges with an explicit output gap", () => {
  const value = recipe(), snapshot = JSON.stringify(value);
  const edit = validateSourceEdit(value, 6);
  assert.equal(sourceEditDuration(edit), 6.5);
  assert.equal(sourceEditParts(edit).reduce((sum, part) => sum + part.frames, 0), 195);
  assert.equal(JSON.stringify(value), snapshot);
});

test("v2 keeps independent occurrence transforms including affine placement", () => {
  const value = recipe();
  value.segments[0].transform = { xPct: 25, affine: { version: 1, rotationDeg: 12, scaleX: .8, scaleY: 1.2 } };
  value.segments[3].transform = { xPct: 75 };
  const edit = validateSourceEdit(value, 6);
  assert.deepEqual(edit.segments[0].transform, value.segments[0].transform);
  assert.deepEqual(edit.segments[3].transform, value.segments[3].transform);
});

test("v2 still rejects output overlaps, duplicate IDs, missing output positions and invalid source/speed", () => {
  const mutations = [
    edit => { edit.segments[1].outputStart = 1; },
    edit => { edit.segments[1].instanceId = "C"; },
    edit => { delete edit.segments[1].outputStart; },
    edit => { edit.segments[0].srcEnd = 6.1; },
    edit => { edit.segments[0].speed = .24; },
    edit => { edit.segments[0].speed = 4.01; },
  ];
  for (const mutate of mutations) {
    const edit = recipe(); mutate(edit);
    assert.throws(() => validateSourceEdit(edit, 6));
  }
});

test("legacy source edits remain chronological and cannot silently become instances", () => {
  assert.throws(() => validateSourceEdit({ segments: [
    { srcStart: 4, srcEnd: 6 }, { srcStart: 0, srcEnd: 2 },
  ] }, 6));
  assert.throws(() => validateSourceEdit({ segments: [
    { srcStart: 0, srcEnd: 2 }, { srcStart: 1, srcEnd: 3 },
  ] }, 6));
  assert.equal(sourceEditDuration(validateSourceEdit({ segments: [
    { srcStart: 0, srcEnd: 2 }, { srcStart: 4, srcEnd: 6 },
  ] }, 6)), 4);
});
