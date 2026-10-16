"""Light-ASD CPU inference over observed within-video face tracks.

No synthetic faces through occlusions. Crop/normalization/MFCC follow the
upstream pretrained model. Frame/audio clocks remain canonical source clocks.
"""
import os
import time
import subprocess
import cv2
import numpy as np
import onnxruntime as ort
from python_speech_features import mfcc


def analyze_speakers(source, evidence, duration, model, shift_seconds=0, freeze_video=False):
    started = time.monotonic()
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", source, "-vn", "-t", str(duration),
                          "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"],
                         capture_output=True, timeout=20)
    if pcm.returncode:
        if b"does not contain any stream" in pcm.stderr:
            return {"version": "light-asd-talkset-v1", "sampleFps": 10, "duration": duration, "audio": [], "observations": []}
        raise ValueError("Speaker audio decoding failed; no partial matching result was accepted.")
    samples = np.frombuffer(pcm.stdout, dtype="<i2")
    if shift_seconds:
        samples = np.roll(samples, int(shift_seconds * 16000))
    features = mfcc(samples, 16000, numcep=13, winlen=.025, winstep=.010).astype(np.float32)
    envelope = [round(float(np.sqrt(np.mean((samples[i:i + 1600].astype(np.float32) / 32768) ** 2))), 6)
                for i in range(0, len(samples), 1600)]
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(model, sess_options=options, providers=["CPUExecutionProvider"])
    groups, scores, frozen = {}, {}, {}

    def flush(group, final=False):
        if len(group) < 15:
            return
        if time.monotonic() - started > 180:
            raise TimeoutError("Speaker analysis exceeded its 180-second budget. No partial speaker result was accepted.")
        start = int(round(group[0][0] * 100))
        count = min(int(round((group[-1][0] - group[0][0]) * 25)) + 1,
                    max(0, (len(features) - start) // 4))
        if count < 15:
            return
        # Exactly four MFCC frames per video frame (100 Hz / 25 Hz).
        a = np.ascontiguousarray(features[start:start + count * 4][None])
        # Regularize CFR/VFR decode samples to the model's exact 25 Hz clock.
        # This never crosses a face-loss or scene boundary (groups are flushed).
        times = np.array([entry[0] for entry in group])
        regular = group[0][0] + np.arange(count) / 25
        indices = np.clip(np.searchsorted(times, regular), 0, len(group) - 1)
        before = np.maximum(0, indices - 1)
        indices = np.where(np.abs(times[before] - regular) < np.abs(times[indices] - regular), before, indices)
        selected = [group[int(i)] for i in indices]
        v = np.stack([entry[1] for entry in selected]).astype(np.float32)[None]
        probabilities = session.run(["speaking"], {"audio": a, "video": v})[0]
        for t, entry, probability in zip(regular, selected, probabilities):
            key = (round(t * 10), entry[2]["faceId"], entry[3])
            scores.setdefault(key, []).append(float(probability))

    capture = cv2.VideoCapture(source)
    fps = capture.get(cv2.CAP_PROP_FPS)
    index, next_t, position, last_t = 0, 0., 0, -1.
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            stamp = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000
            t = stamp if stamp > last_t else index / fps
            index += 1
            last_t = t
            if t + 1e-6 < next_t:
                continue
            # Select at 25 Hz, preserving actual decoder timestamps.
            next_t = (int((t + 1e-6) * 25) + 1) / 25
            while position + 1 < len(evidence) and evidence[position + 1]["t"] <= t:
                position += 1
            observed = evidence[position]
            live = set()
            if abs(t - observed["t"]) <= .12:
                h, w = frame.shape[:2]
                for point in observed["faces"]:
                    if point["confidence"] < .7:
                        continue
                    key = (point["faceId"], observed["scene"])
                    live.add(key)
                    cx, cy = (point["x"] + point["w"] / 2) * w, (point["y"] + point["h"] / 2) * h
                    size = max(point["w"] * w, point["h"] * h) / 2
                    if size < 8:
                        continue
                    # Upstream cropScale=.4: padded, then 224 resize + central112.
                    padding = int(size * 1.8) + 2
                    padded = cv2.copyMakeBorder(frame, padding, padding, padding, padding, cv2.BORDER_CONSTANT, value=(110, 110, 110))
                    x, y = cx + padding, cy + padding
                    crop = padded[int(y - size):int(y + size * 1.8), int(x - size * 1.4):int(x + size * 1.4)]
                    if not crop.size:
                        continue
                    gray = cv2.cvtColor(cv2.resize(crop, (224, 224)), cv2.COLOR_BGR2GRAY)[56:168, 56:168]
                    if freeze_video:
                        gray = frozen.setdefault(key, gray.copy())
                    group = groups.setdefault(key, [])
                    # Model inputs use a regular 25 Hz clock. Repeat the nearest
                    # *observed* image only for decoder/VFR sampling, never loss.
                    group.append((round(t, 4), gray, point, observed["scene"]))
                    if group[-1][0] - group[0][0] >= 2.96:
                        flush(group)
                        cutoff = group[-1][0] - .96
                        group[:] = [entry for entry in group if entry[0] >= cutoff]
            for key in list(groups):
                if key not in live:
                    flush(groups.pop(key), True)
            if time.monotonic() - started > 180:
                raise TimeoutError("Speaker analysis exceeded its 180-second budget. No partial speaker result was accepted.")
        for group in groups.values():
            flush(group, True)
    finally:
        capture.release()
    rows = []
    for observed in evidence:
        for point in observed["faces"]:
            probabilities = scores.get((round(observed["t"] * 10), point["faceId"], observed["scene"]))
            if probabilities:
                rows.append([observed["t"], point["faceId"], *[round(point[k], 6) for k in ("x", "y", "w", "h")],
                             round(float(np.mean(probabilities)), 5), round(point["confidence"], 5), observed["scene"]])
    return {"version": "light-asd-talkset-v1", "sampleFps": 10, "duration": duration,
            "audio": envelope, "observations": rows, "analysisSeconds": round(time.monotonic() - started, 3)}
