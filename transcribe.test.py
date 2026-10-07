import os
import runpy
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class TranscriptionConfigTest(unittest.TestCase):
    def check_model(self, env, expected_model, expected_language):
        calls = {}

        class FakeModel:
            def __init__(self, model, **kwargs):
                calls["model"] = model

            def transcribe(self, path, **kwargs):
                calls["options"] = kwargs
                return [], None

        module = types.ModuleType("faster_whisper")
        module.WhisperModel = FakeModel
        with patch.dict(sys.modules, {"faster_whisper": module}), patch.dict(os.environ, env, clear=True), patch.object(sys, "argv", ["transcribe.py", "synthetic.mp4"]):
            runpy.run_path(str(Path(__file__).with_name("transcribe.py")), run_name="__main__")
        self.assertEqual(calls["model"], expected_model)
        self.assertEqual(calls["options"]["language"], expected_language)
        self.assertFalse(calls["options"]["vad_filter"])
        self.assertTrue(calls["options"]["word_timestamps"])
        self.assertEqual(calls["options"]["beam_size"], 5)

    def test_default_english_accuracy_profile(self):
        self.check_model({}, "small.en", "en")

    def test_explicit_multilingual_model_is_respected(self):
        self.check_model({"WHISPER_MODEL": "small"}, "small", None)


if __name__ == "__main__":
    unittest.main()
