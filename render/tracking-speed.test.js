import test from "node:test";
import assert from "node:assert/strict";
import { smoothFaceTrack, faceTrackingSchema, trackedForegroundGeometry } from "./face-tracking-core.js";
test("follow speed time-scales critically damped motion, preserving legacy defaults and both layouts",() => {
  const track = Array.from({length:81},(_,i)=>({t:i/10,x:i<10?.2:.6,y:.3,w:.1,h:.1,confidence:.9,faceId:"face1"}));
  const settings={enabled:true,mode:"selectedFace",zoom:1.3,smoothness:.8,deadZonePct:0,startSeconds:0,endSeconds:8,track};
  const normal=smoothFaceTrack(settings,8),fast=smoothFaceTrack({...settings,followSpeed:2},8);
  assert.deepEqual(smoothFaceTrack({...settings,followSpeed:1},8),normal);
  assert.ok(fast[18].x>normal[18].x);
  for(let i=1;i<fast.length;i++) assert.ok(fast[i].x>=fast[i-1].x-1e-7 && fast[i].x<=.650001);
  for(const layout of ["blurfit","fill"]) {
    const geometry=trackedForegroundGeometry(1920,1080,1080,1920,layout,{},settings,fast[18]);
    assert.ok(Number.isFinite(geometry.foregroundX) && Number.isFinite(geometry.foregroundY));
  }
  for(const followSpeed of [0,3,NaN]) assert.equal(faceTrackingSchema.safeParse({...settings,followSpeed}).success,false);
});
