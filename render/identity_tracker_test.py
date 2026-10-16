import unittest
import cv2
import numpy as np
from identity_tracker import IdentityTracker, one_to_one, compact_track


def point(t, x=.2, y=.2):
    return dict(t=t, x=x, y=y, w=.15, h=.15, confidence=.95)


def frame(positions):
    image = np.zeros((240, 400, 3), np.uint8)
    for x, color in positions:
        cv2.rectangle(image, (int(x * 400), 48), (int((x + .15) * 400), 145), color, -1)
    return image


class IdentityTests(unittest.TestCase):
    def test_global_assignment_is_not_greedy(self):
        self.assertEqual(set(one_to_one([[.1, .2], [.12, float("inf")]])), {(0, 1), (1, 0)})
        self.assertEqual(one_to_one([[float("inf")]]), [])

    def test_hidden_1_5_seconds_preserves_id_without_invented_points(self):
        tracker = IdentityTracker()
        image = frame([(.2, (20, 190, 240))])
        before = tracker.update(0, [point(0)], image)[0]
        for i in range(1, 16):
            self.assertEqual(tracker.update(i / 10, [], image), [])
        after = tracker.update(1.6, [point(1.6)], image)[0]
        self.assertEqual(before["faceId"], after["faceId"])

    def test_expired_track_and_scene_cut_never_reuse_identity(self):
        tracker = IdentityTracker()
        image = frame([(.2, (20, 190, 240))])
        first = tracker.update(0, [point(0)], image)[0]
        second = tracker.update(1.8, [point(1.8)], image)[0]
        third = tracker.update(1.9, [point(1.9)], image, force_scene_cut=True)[0]
        self.assertNotEqual(first["faceId"], second["faceId"])
        self.assertNotEqual(second["faceId"], third["faceId"])

    def test_same_location_different_appearance_does_not_steal_id(self):
        tracker = IdentityTracker()
        first = tracker.update(0, [point(0)], frame([(.2, (0, 255, 0))]), embeddings=[np.array([1., 0.])])[0]
        second = tracker.update(.1, [point(.1)], frame([(.2, (0, 0, 255))]), embeddings=[np.array([0., 1.])])[0]
        self.assertNotEqual(first["faceId"], second["faceId"])

    def test_one_to_one_and_crossing_preserve_distinct_known_appearances(self):
        tracker = IdentityTracker()
        embeddings = [np.array([1., 0.]), np.array([0., 1.])]
        previous = None
        for i in range(11):
            left, right, t = .2 + i * .035, .6 - i * .035, i / 10
            points = tracker.update(t, [point(t, left), point(t, right)],
                                    frame([(left, (0, 255, 0)), (right, (0, 0, 255))]),
                                    embeddings=embeddings)
            ids = [p["faceId"] for p in points]
            self.assertEqual(len(set(ids)), 2)
            if previous is not None:
                self.assertEqual(ids, previous)
            previous = ids

    def test_ambiguous_reacquisition_abstains(self):
        tracker = IdentityTracker()
        image = np.zeros((240, 400, 3), np.uint8)
        before = tracker.update(0, [point(0, .2), point(0, .4)], image)
        after = tracker.update(.1, [point(.1, .3)], image)
        self.assertNotIn(after[0]["faceId"], [p["faceId"] for p in before])

    def test_state_is_bounded_and_compaction_keeps_gaps(self):
        tracker = IdentityTracker()
        for i in range(30):
            tracker.update(i / 100, [point(i / 100, .2)], np.zeros((240, 400, 3), np.uint8))
        self.assertLessEqual(len(tracker.active), 24)
        points = [point(i / 10) for i in range(1500) if not 500 <= i <= 515]
        compact = compact_track(points)
        self.assertLessEqual(len(compact), 600)
        times = [p["t"] for p in compact]
        self.assertIn(49.9, times)
        self.assertIn(51.6, times)
        self.assertEqual(times[0], 0)
        self.assertEqual(times[-1], 149.9)
        self.assertEqual(times, sorted(set(times)))


if __name__ == "__main__":
    unittest.main()
