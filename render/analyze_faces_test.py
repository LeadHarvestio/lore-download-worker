"""Cadence/resource regressions; no model download or source media required."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import cv2
import numpy as np

script = Path(__file__).with_name("analyze-faces-candidate.py")
if not script.exists():
    script = Path(__file__).with_name("analyze-faces.py")
spec = importlib.util.spec_from_file_location("candidate_analyzer", script)
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)


class Capture:
    def __init__(self, fps=30, count=30):
        self.fps, self.count, self.index = fps, count, 0

    def get(self, key):
        return {cv2.CAP_PROP_FPS: self.fps, cv2.CAP_PROP_FRAME_COUNT: self.count,
                cv2.CAP_PROP_POS_MSEC: (self.index - 1) * 1000 / self.fps}.get(key, 0)

    def isOpened(self):
        return True

    def read(self):
        self.index += 1
        return (self.index <= self.count, np.full((100, 100, 3), 128, np.uint8))

    def release(self):
        pass


class Detector:
    def setInputSize(self, size):
        pass

    def detect(self, frame):
        return None, np.array([[20, 20, 40, 40, 28, 30, 48, 30, 38, 40, 30, 50, 46, 50, .95]], np.float32)


class Recognizer:
    def __init__(self):
        self.evaluations = 0

    def alignCrop(self, frame, face):
        return frame

    def feature(self, crop):
        self.evaluations += 1
        return np.array([[1., 0.]], np.float32)


class AnalyzerTests(unittest.TestCase):
    def run_analysis(self, capture):
        recognizer = Recognizer()
        with patch.object(analyzer.cv2, "VideoCapture", return_value=capture), \
             patch.object(analyzer.cv2, "FaceDetectorYN", SimpleNamespace(create=lambda *args: Detector())), \
             patch.object(analyzer.cv2, "FaceRecognizerSF", SimpleNamespace(create=lambda *args: recognizer)):
            result = analyzer.analyze("fixture.mp4", "fixture.onnx")
        return result, recognizer

    def test_dense_clock_stays_10fps_while_appearance_is_2hz(self):
        result, recognizer = self.run_analysis(Capture())
        self.assertEqual(result["evidence"]["frames"], 10)
        self.assertEqual(result["sampleFps"], 10)
        self.assertEqual(result["evidence"]["maxSampleGapSeconds"], .1)
        self.assertEqual(recognizer.evaluations, 2)
        self.assertEqual(result["appearanceEvaluations"], 2)
        self.assertEqual(result["appearanceKeyframeFps"], 2)
        self.assertFalse(result["identityVerified"])

    def test_explicit_limits_do_not_silently_reduce_evidence_cadence(self):
        with self.assertRaisesRegex(ValueError, "180 seconds"):
            self.run_analysis(Capture(count=30 * 181))
        with self.assertRaisesRegex(ValueError, "10 fps"):
            self.run_analysis(Capture(fps=5))


if __name__ == "__main__":
    unittest.main()
