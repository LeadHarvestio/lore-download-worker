"""Local-only YuNet inference. No face recognition, identity lookup or uploads."""
import json
import os
import sys
import time
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "1")
import cv2

cv2.setNumThreads(1)
started = time.monotonic()
model = os.environ.get("FACE_MODEL_PATH", "/app/render/yunet.onnx")
detector = cv2.FaceDetectorYN.create(model, "", (320, 320), .65, .3, 2000)
if sys.argv[1] == "--check":
    print('{"ready":true}')
    sys.exit(0)
capture = cv2.VideoCapture(sys.argv[1])
fps = capture.get(cv2.CAP_PROP_FPS) or 30
count = capture.get(cv2.CAP_PROP_FRAME_COUNT)
duration = count / fps
if not capture.isOpened() or not 0 < duration <= 1800:
    raise ValueError("Cannot analyze this source video (maximum 30 minutes).")
sample_fps = min(10, 599 / duration)
next_t = 0
frame_index = 0
tracks = {}
last = {}
thumbnails = {}
face_number = 0
def overlap(a, b):
    w = max(0, min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"]))
    h = max(0, min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"]))
    inter = w * h
    return inter / max(.000001, a["w"] * a["h"] + b["w"] * b["h"] - inter)
while True:
    ok, frame = capture.read()
    if not ok:
        break
    t = frame_index / fps
    frame_index += 1
    if t < next_t:
        continue
    next_t += 1 / sample_fps
    if time.monotonic() - started > 55:
        raise TimeoutError("Face analysis exceeded its 55-second active budget.")
    h, w = frame.shape[:2]
    scale = min(1, 480 / max(w, h))
    small = cv2.resize(frame, (max(32, round(w * scale)), max(32, round(h * scale))))
    sh, sw = small.shape[:2]
    detector.setInputSize((sw, sh))
    _, faces = detector.detect(small)
    used = set()
    for face in sorted(faces if faces is not None else [], key=lambda f: f[2] * f[3], reverse=True)[:8]:
        x, y, fw, fh = face[:4]
        point = {"t": round(t, 4), "x": min(1, max(0, float(x / sw))), "y": min(1, max(0, float(y / sh))),
                 "w": min(1, float(fw / sw)), "h": min(1, float(fh / sh)), "confidence": float(face[-1])}
        point["w"] = min(point["w"], 1 - point["x"])
        point["h"] = min(point["h"], 1 - point["y"])
        if point["w"] <= 0 or point["h"] <= 0:
            continue
        matches = [(overlap(point, p), identity) for identity, p in last.items()
                   if identity not in used and t - p["t"] <= 1]
        score, identity = max(matches, default=(0, ""))
        if score < .05:
            face_number += 1
            identity = "face-" + str(face_number)
        point["faceId"] = identity
        used.add(identity)
        tracks.setdefault(identity, []).append(point)
        last[identity] = point
        if identity not in thumbnails:
            import base64
            crop = small[max(0, int(y)):min(sh, int(y + fh)), max(0, int(x)):min(sw, int(x + fw))]
            if crop.size:
                ok, encoded = cv2.imencode(".jpg", cv2.resize(crop, (96, 96)), [cv2.IMWRITE_JPEG_QUALITY, 75])
                if ok:
                    thumbnails[identity] = base64.b64encode(encoded).decode("ascii")
capture.release()
valid = sorted((points for points in tracks.values() if len(points) >= 3),
               key=lambda p: sum(q["w"] * q["h"] for q in p), reverse=True)[:12]
identities = {p[0]["faceId"] for p in valid}
print(json.dumps({"tracks": valid, "thumbnails": [{"faceId": key, "jpegBase64": value}
                  for key, value in thumbnails.items() if key in identities], "duration": duration,
                  "analysisSeconds": round(time.monotonic() - started, 3), "detector": "YuNet-2023mar",
                  "sampleFps": sample_fps}))
