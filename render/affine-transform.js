import { z } from "zod";

export const affineTransformSchema = z.object({
  version: z.literal(1),
  rotationDeg: z.number().finite().min(-180).max(180).optional(),
  scaleX: z.number().finite().min(.1).max(3).optional(),
  scaleY: z.number().finite().min(.1).max(3).optional(),
}).strict();
export function affineValues(value) {
  return { version: 1, rotationDeg: value?.rotationDeg ?? 0, scaleX: value?.scaleX ?? 1, scaleY: value?.scaleY ?? 1 };
}
export function validateAffineUsage(style = {}, edit = style.sourceEdit) {
  if (style.source?.affine !== undefined) affineTransformSchema.parse(style.source.affine);
  for (const segment of edit?.segments || []) {
    if (segment.transform?.affine !== undefined) affineTransformSchema.parse(segment.transform.affine);
  }
  const sourceAffine = style.source?.affine || edit?.segments.some(s => s.transform?.affine);
  if (sourceAffine && (style.source?.tracking?.enabled || style.sourcePanes)) {
    throw new Error("Rotation and axis sizing require a single manually positioned source.");
  }
  for (const layer of style.layers || []) {
    if (layer.affine === undefined) continue;
    affineTransformSchema.parse(layer.affine);
    if (layer.mode !== "overlay" || layer.id === "c5100000-8dc7-4a19-9f71-000000000000") {
      throw new Error("Only ordinary context overlays support affine transforms.");
    }
  }
}
const even = value => Math.max(2, Math.round(value / 2) * 2);
/** Straight-alpha transparent rotation, expanded to an even bounding box. */
export function affineFilter(affine) {
  if (!affine) return "";
  const { rotationDeg, scaleX, scaleY } = affineValues(affine);
  const angle = rotationDeg * Math.PI / 180;
  return `,scale=w='max(2,round(iw*${scaleX}/2)*2)':h='max(2,round(ih*${scaleY}/2)*2)',format=rgba,rotate=${angle}:ow='ceil((abs(iw*cos(${angle}))+abs(ih*sin(${angle})))/2)*2':oh='ceil((abs(iw*sin(${angle}))+abs(ih*cos(${angle})))/2)*2':c=none`;
}
export function affineSize(width, height, affine) {
  const v = affineValues(affine);
  return { width: even(width * v.scaleX), height: even(height * v.scaleY) };
}
