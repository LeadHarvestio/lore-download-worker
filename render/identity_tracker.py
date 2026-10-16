"""Bounded, within-video association. No names, external lookup or cross-video search.

Appearance uses ephemeral color/texture and optional local SFace embeddings.
Uncertain reacquisition is deliberately left unmatched rather than guessed.
"""
import math
from functools import lru_cache

import cv2
import numpy as np

VERSION = "local-motion-keyframe-v3"
MAX_LOSS = 1.6  # 1.5-second hidden interval plus a sampling boundary
MAX_CANDIDATES = 24


def appearance(frame, box):
    h, w = frame.shape[:2]
    x, y, bw, bh = box

    def crop(left, top, right, bottom):
        return frame[max(0, int(top * h)):min(h, int(bottom * h)),
                     max(0, int(left * w)):min(w, int(right * w))]

    def histogram(image):
        if image.size < 12:
            return None
        hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        # Include value: black/white clothing has little useful hue.
        hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 4, 4],
                           [0, 180, 0, 256, 0, 256]).flatten()
        hist /= max(1, hist.sum())
        return np.sqrt(hist)

    face = crop(x, y, x + bw, y + bh)
    shirt = crop(x - bw * .3, y + bh, x + bw * 1.3, y + bh * 2.7)
    texture = None
    if face.size >= 12:
        gray = cv2.resize(cv2.cvtColor(face, cv2.COLOR_BGR2GRAY), (12, 12)).astype(float)
        gray -= gray.mean()
        norm = np.linalg.norm(gray)
        if norm > 10:
            texture = gray.flatten() / norm
    return histogram(face), histogram(shirt), texture


def appearance_distance(a, b):
    distances, weights = [], []
    for i, weight in enumerate((.45, .4, .15)):
        if a[i] is not None and b[i] is not None:
            distances.append(max(0, 1 - float(np.dot(a[i], b[i]))))
            weights.append(weight)
    if not weights:
        return 1.
    return sum(d * w for d, w in zip(distances, weights)) / sum(weights)


def one_to_one(costs, unmatched=.95):
    """Exact rectangular assignment, bounded to <=8 detections and 24 tracks.

    Each detection can be unmatched; a track may never consume two detections.
    Dynamic programming is O(tracks * detections * 2**detections), not factorial.
    """
    if not costs:
        return []
    n = len(costs[0])

    @lru_cache(None)
    def solve(track, mask):
        if track == len(costs):
            return unmatched * (n - mask.bit_count()), ()
        best_cost, best_pairs = solve(track + 1, mask)
        for detection in range(n):
            cost = costs[track][detection]
            if mask & (1 << detection) or not math.isfinite(cost) or cost >= unmatched:
                continue
            rest, pairs = solve(track + 1, mask | (1 << detection))
            if cost + rest < best_cost:
                best_cost, best_pairs = cost + rest, ((track, detection),) + pairs
        return best_cost, best_pairs
    return list(solve(0, 0)[1])


class IdentityTracker:
    def __init__(self):
        self.active = {}
        self.serial = 0
        self.scene = 0
        self.ambiguous = 0
        self.previous_gray = None
        self.previous_hist = None

    def camera_motion(self, frame):
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        hist = cv2.calcHist([gray], [0], None, [32], [0, 256])
        hist /= max(1, hist.sum())
        shift = np.zeros(2)
        cut = False
        previous = self.previous_gray
        if previous is not None:
            delta = np.mean(cv2.absdiff(gray, previous)) / 255.
            cut = delta > .28 and cv2.compareHist(hist, self.previous_hist, cv2.HISTCMP_BHATTACHARYYA) > .55
            features = cv2.goodFeaturesToTrack(previous, 80, .02, 8)
            if not cut and features is not None and len(features) >= 8:
                moved, status, _ = cv2.calcOpticalFlowPyrLK(previous, gray, features, None)
                if moved is not None:
                    good = status.reshape(-1).astype(bool)
                    if good.sum() >= 8:
                        affine, inliers = cv2.estimateAffinePartial2D(
                            features[good], moved[good], method=cv2.RANSAC, ransacReprojThreshold=3)
                        if affine is not None and inliers.sum() >= 8:
                            # A single global translation is deliberately conservative.
                            shift = affine[:, 2] / np.array([gray.shape[1], gray.shape[0]])
                            shift = np.clip(shift, -.25, .25)
        self.previous_gray, self.previous_hist = gray, hist
        return shift, cut

    def update(self, t, detections, frame, force_scene_cut=False, embeddings=None):
        # Track local image features as well as global camera translation.
        # Rotation/perspective can move two faces in very different directions.
        local_motion = {}
        if self.previous_gray is not None and self.active:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            h, w = gray.shape
            features, owners = [], []
            for key, state in self.active.items():
                if t - state["t"] > .31:
                    continue
                center = state["center"] + state["camera"]
                size = state["size"]
                mask = np.zeros_like(gray)
                x0, y0 = np.clip((center - size * .65) * [w, h], 0, [w, h]).astype(int)
                x1, y1 = np.clip((center + size * .65) * [w, h], 0, [w, h]).astype(int)
                mask[y0:y1, x0:x1] = 255
                points = cv2.goodFeaturesToTrack(self.previous_gray, 12, .01, 2, mask=mask)
                if points is not None:
                    features.extend(points)
                    owners.extend([key] * len(points))
            if features:
                old = np.array(features, dtype=np.float32)
                moved, status, _ = cv2.calcOpticalFlowPyrLK(
                    self.previous_gray, gray, old, None, winSize=(25, 25), maxLevel=3)
                if moved is not None:
                    back, back_status, _ = cv2.calcOpticalFlowPyrLK(gray, self.previous_gray, moved, None)
                    errors = np.linalg.norm((back - old).reshape(-1, 2), axis=1)
                    for key in self.active:
                        valid = np.array([owner == key for owner in owners]) & status.reshape(-1).astype(bool)
                        valid &= back_status.reshape(-1).astype(bool) & (errors < 1.5)
                        if valid.sum() >= 3:
                            local_motion[key] = np.median((moved - old).reshape(-1, 2)[valid], axis=0) / [w, h]
        shift, cut = self.camera_motion(frame)
        if cut or force_scene_cut:
            self.active.clear()
            self.scene += 1
        self.active = {key: value for key, value in self.active.items() if t - value["t"] <= MAX_LOSS + 1e-6}
        # Move even hidden tracks with the camera, but never emit invented boxes.
        for key, state in self.active.items():
            state["camera"] += local_motion.get(key, shift)
        keys = sorted(self.active, key=lambda k: self.active[k]["t"], reverse=True)[:MAX_CANDIDATES]
        features = [appearance(frame, [d[k] for k in ("x", "y", "w", "h")]) for d in detections]
        embeddings = embeddings or [None] * len(detections)
        costs = []
        for key in keys:
            state = self.active[key]
            age = t - state["t"]
            predicted = state["center"] + state["camera"]
            if key not in local_motion:
                predicted += state["velocity"] * min(age, .5)
            row = []
            for detection, feature, embedding in zip(detections, features, embeddings):
                size = np.array([detection["w"], detection["h"]])
                center = np.array([detection["x"], detection["y"]]) + size / 2
                distance = np.linalg.norm((center - predicted) / np.maximum(size, state["size"]))
                scale = float(np.max(np.abs(np.log(size / state["size"]))))
                # Short-term optical correspondence is more reliable than a
                # single first-frame appearance under blur, profile or clipping.
                # Anchors constrain reacquisition, not every visible-frame match.
                recent_looks = appearance_distance(state["appearance"], feature)
                continuous = age <= .21 and distance < 1.1 and key in local_motion
                looks = recent_looks if continuous else max(recent_looks,
                    .65 * appearance_distance(state["anchor"], feature))
                similarity = None
                if embedding is not None and state.get("embeddings"):
                    similarity = max(float(np.dot(e, embedding)) for e in state["embeddings"])
                limit = (2.5 if similarity is not None and similarity > .65 else 1.2) + min(age, 1.5) * .5
                # Poor SFace similarities on tiny/turning faces must not break a
                # strong optical track. Require conflicting visual evidence too.
                invalid_appearance = looks > (.65 if continuous else .38)
                if similarity is not None and similarity < .2 and looks > .25:
                    invalid_appearance = True
                if distance > limit or scale > .85 or invalid_appearance:
                    row.append(math.inf)
                else:
                    identity_cost = .45 * looks
                    if similarity is not None and not continuous:
                        identity_cost = .35 * (1 - similarity) + .3 * looks
                    # Retained lost tracks must not tie the freshly observed
                    # track and trigger a permanent ambiguity/birth feedback loop.
                    row.append(.5 * distance / limit + .1 * scale + identity_cost +
                               .15 * min(age, 1.5))
            costs.append(row)
        # Reject ambiguous rows/columns BEFORE assignment. A global optimizer alone
        # can otherwise force a plausible-looking wrong identity.
        rejected = set()
        for i, row in enumerate(costs):
            finite = sorted((value, j) for j, value in enumerate(row) if value < .95)
            if len(finite) > 1 and finite[1][0] - finite[0][0] < .07:
                rejected.add((i, finite[0][1]))
                rejected.add((i, finite[1][1]))
        for j in range(len(detections)):
            finite = sorted((costs[i][j], i) for i in range(len(keys)) if costs[i][j] < .95)
            if len(finite) > 1 and finite[1][0] - finite[0][0] < .07:
                rejected.add((finite[0][1], j))
                rejected.add((finite[1][1], j))
        self.ambiguous += len(rejected)
        for i, j in rejected:
            costs[i][j] = math.inf
        assigned = {j: keys[i] for i, j in one_to_one(costs)}
        output = []
        for j, (point, feature, embedding) in enumerate(zip(detections, features, embeddings)):
            key = assigned.get(j)
            center = np.array([point["x"] + point["w"] / 2, point["y"] + point["h"] / 2])
            size = np.array([point["w"], point["h"]])
            if key is None:
                self.serial += 1
                key = "face-v2-" + str(self.serial)
                state = {"velocity": np.zeros(2), "anchor": feature, "embeddings": []}
            else:
                state = self.active[key]
                dt = max(.01, t - state["t"])
                velocity = (center - state["center"] - state["camera"]) / dt
                state["velocity"] = np.clip(.6 * state["velocity"] + .4 * velocity, -.5, .5)
            state.update(t=t, center=center, size=size, camera=np.zeros(2), appearance=feature)
            # Short, in-memory gallery only. Never serialize embeddings, associate
            # names, search other videos, or update a template from an uncertain match.
            if embedding is not None:
                if not state["embeddings"]:
                    state["embeddings"].append(embedding)
                elif max(float(np.dot(e, embedding)) for e in state["embeddings"]) > .65:
                    state["embeddings"] = [state["embeddings"][0], embedding]
            self.active[key] = state
            output.append({**point, "faceId": key})
        # Bounded retained state even during a noisy detector burst.
        if len(self.active) > MAX_CANDIDATES:
            keep = sorted(self.active, key=lambda k: self.active[k]["t"], reverse=True)[:MAX_CANDIDATES]
            self.active = {k: self.active[k] for k in keep}
        return output


def compact_track(points, maximum=600):
    """Keep endpoints and both sides of every observation gap.

    Never downsample through a hidden interval and fabricate uninterrupted motion.
    If boundaries alone exceed the path budget, fail explicitly.
    """
    if len(points) <= maximum:
        return points
    required = {0, len(points) - 1}
    for i in range(1, len(points)):
        if points[i]["t"] - points[i - 1]["t"] > .21:
            required.update((i - 1, i))
    if len(required) > maximum:
        raise ValueError("Too many face observation gaps for the compact camera path.")
    # Fill evenly, then add missing indices to exactly use the available budget.
    for index in np.linspace(0, len(points) - 1, maximum - len(required), dtype=int):
        required.add(int(index))
    if len(required) < maximum:
        for index in np.linspace(0, len(points) - 1, maximum * 2, dtype=int):
            required.add(int(index))
            if len(required) == maximum:
                break
    return [points[i] for i in sorted(required)]
