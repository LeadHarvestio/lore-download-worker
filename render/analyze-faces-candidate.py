"""YuNet + conservative within-video association; dense evidence stays on disk."""
import argparse
import base64
import gzip
import json
import os
import sys
import time
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
import cv2
from identity_tracker import IdentityTracker, VERSION, compact_track

cv2.setNumThreads(1)
MAX_DURATION = 180  # Explicit bounded work; never silently reduce evidence fps.


def analyze(filename, model, evidence_file=None):
    started = time.monotonic()
    detector = cv2.FaceDetectorYN.create(model, "", (320, 320), .65, .3, 2000)
    recognizer = cv2.FaceRecognizerSF.create(os.environ.get("FACE_APPEARANCE_MODEL_PATH", "/app/render/sface.onnx"), "")
    capture = cv2.VideoCapture(filename)
    try:
        fps = capture.get(cv2.CAP_PROP_FPS)
        count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
        duration = count / fps if fps else 0
        if not capture.isOpened() or not 0 < duration <= MAX_DURATION:
            raise ValueError("Dense face analysis supports sources up to 180 seconds. Split longer sources before analysis.")
        if fps < 10:
            raise ValueError("Source frame rate is below the required 10 fps evidence rate.")
        tracker, tracks, thumbnails, evidence = IdentityTracker(), {}, {}, []
        next_t, frame_index, last_t, next_appearance_t = 0., 0, -1., 0.
        appearance_evaluations = 0
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            # Decoder timestamps preserve canonical VFR time; index/fps only if
            # the decoder supplies a missing/non-increasing timestamp.
            timestamp = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000
            t = timestamp if timestamp >= 0 and timestamp > last_t else frame_index / fps
            frame_index += 1
            last_t = t
            if t + 1e-6 < next_t:
                continue
            next_t = (int((t + 1e-6) * 10) + 1) / 10
            if time.monotonic() - started > 55:
                raise TimeoutError("Face analysis exceeded its 55-second active budget. No partial result was accepted.")
            h, w = frame.shape[:2]
            scale = min(1, 480 / max(w, h))
            small = cv2.resize(frame, (max(32, round(w * scale)), max(32, round(h * scale))))
            sh, sw = small.shape[:2]
            detector.setInputSize((sw, sh))
            _, faces = detector.detect(small)
            detections, landmarks, embeddings = [], [], []
            # Face boxes + landmarks remain 10 fps. Expensive appearance inference
            # is keyframe evidence (2 Hz), not a mouth-evidence sampling clock.
            appearance_keyframe = t + 1e-6 >= next_appearance_t
            if appearance_keyframe:
                next_appearance_t = t + .5
            for face in sorted(faces if faces is not None else [], key=lambda f: f[2] * f[3], reverse=True)[:8]:
                x, y, fw, fh = [float(n) for n in face[:4]]
                point = {"t": round(t, 4), "x": min(1, max(0, x / sw)), "y": min(1, max(0, y / sh)),
                         "w": min(1, fw / sw), "h": min(1, fh / sh), "confidence": float(face[-1])}
                point["w"], point["h"] = min(point["w"], 1 - point["x"]), min(point["h"], 1 - point["y"])
                if point["w"] <= 0 or point["h"] <= 0:
                    continue
                detections.append(point)
                landmarks.append([[round(float(face[i]) / sw, 6), round(float(face[i + 1]) / sh, 6)]
                                  for i in range(4, 14, 2)])
                # Detect on a bounded preview, but align from the original pixels:
                # a 15px preview face destroys the distinguishing appearance.
                embedding = None
                if appearance_keyframe or tracker.needs_appearance(t, point):
                    original_face = face.copy()
                    original_face[:14:2] *= w / sw
                    original_face[1:14:2] *= h / sh
                    vector = recognizer.feature(recognizer.alignCrop(frame, original_face)).flatten()
                    norm = float(cv2.norm(vector))
                    embedding = vector / norm if norm > 0 else None
                    appearance_evaluations += 1
                embeddings.append(embedding)
            points = tracker.update(t, detections, small, embeddings=embeddings)
            evidence.append({"t": round(t, 4), "scene": tracker.scene, "faces":
                             [{**p, "landmarks": lm} for p, lm in zip(points, landmarks)]})
            for p in points:
                identity = p["faceId"]
                tracks.setdefault(identity, []).append(p)
                if identity not in thumbnails:
                    x, y, bw, bh = [p[k] for k in ("x", "y", "w", "h")]
                    crop = small[int(y * sh):max(int(y * sh) + 1, int((y + bh) * sh)),
                                 int(x * sw):max(int(x * sw) + 1, int((x + bw) * sw))]
                    if crop.size:
                        ok, encoded = cv2.imencode(".jpg", cv2.resize(crop, (96, 96)), [cv2.IMWRITE_JPEG_QUALITY, 75])
                        if ok:
                            thumbnails[identity] = base64.b64encode(encoded).decode("ascii")
        if frame_index < count * .95:
            raise ValueError("Source decoding ended early; no incomplete face result was accepted.")
        valid = sorted((points for points in tracks.values() if len(points) >= 3),
                       key=lambda p: sum(q["w"] * q["h"] for q in p), reverse=True)[:12]
        compact = [compact_track(points) for points in valid]
        ids = {p[0]["faceId"] for p in compact}
        manifest = {"version": VERSION, "sampleFps": 10, "frames": len(evidence),
                    "maxSampleGapSeconds": round(max((b["t"] - a["t"] for a, b in zip(evidence, evidence[1:])), default=0), 4),
                    "duration": duration}
        if evidence_file:
            temporary = evidence_file + ".tmp"
            with gzip.open(temporary, "wt", encoding="utf8") as out:
                json.dump({"manifest": manifest, "frames": evidence}, out, separators=(",", ":"))
            os.replace(temporary, evidence_file)
        elapsed = time.monotonic() - started
        if elapsed > 55:
            if evidence_file:
                os.remove(evidence_file)
            raise TimeoutError("Face analysis exceeded its 55-second active budget. No partial result was accepted.")
        return {"tracks": compact, "thumbnails": [{"faceId": k, "jpegBase64": v} for k, v in thumbnails.items() if k in ids],
                "duration": duration, "analysisSeconds": round(elapsed, 3),
                "detector": "YuNet-2023mar/" + VERSION, "sampleFps": 10,
                "evidence": manifest, "ambiguousAssociationsRejected": tracker.ambiguous,
                "appearanceEvaluations": appearance_evaluations,
                "appearanceKeyframeFps": 2,
                "appearanceBootstrapSamples": 3,
                "identityVerified": False}
    finally:
        capture.release()


if __name__ == "__main__":
    model = os.environ.get("FACE_MODEL_PATH", "/app/render/yunet.onnx")
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        cv2.FaceDetectorYN.create(model, "", (320, 320), .65, .3, 2000)
        cv2.FaceRecognizerSF.create(os.environ.get("FACE_APPEARANCE_MODEL_PATH", "/app/render/sface.onnx"), "")
        print('{"ready":true}')
    else:
        parser = argparse.ArgumentParser()
        parser.add_argument("source")
        parser.add_argument("--evidence")
        args = parser.parse_args()
        try:
            print(json.dumps(analyze(args.source, model, args.evidence)))
        except Exception as error:
            print(str(error), file=sys.stderr)
            sys.exit(1)
