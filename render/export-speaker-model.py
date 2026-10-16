"""Build-time only: pinned MIT Light-ASD -> a CPU ONNX model.

Torch is not a serving dependency. Verify upstream files before importing any
code; load state tensors with weights_only=True, never arbitrary pickle objects.
"""
import argparse
import hashlib
import os
import sys
import tempfile
import urllib.request

PIN = "ed38c232de5efe0261dbd68627c0ade7cdfe14eb"
FILES = {
    "model/Classifier.py": "21fdebc3c08ee3a386111719035f06461b29548b9b900eff3e17e4083f4377f8",
    "model/Encoder.py": "c4a85b8aa5eaab428f79836c5d9511a01ac45bfeb6dccc75e06c1e9eff25520c",
    "model/Model.py": "6094bfaab7d5a701e1580ee6ec89c7cfea2baacf62b3ceafff5558f31dd3fc8d",
    "weight/finetuning_TalkSet.model": "efc375833887eefa9d209dc92810e18519b04c3c73ea35a549f2a7f40b7d94d5",
}


def export(output):
    import torch
    torch.set_num_threads(1)
    with tempfile.TemporaryDirectory(prefix="speaker-export-") as root:
        for relative, digest in FILES.items():
            data = urllib.request.urlopen(
                f"https://raw.githubusercontent.com/Junhua-Liao/Light-ASD/{PIN}/{relative}", timeout=60).read()
            if hashlib.sha256(data).hexdigest() != digest:
                raise ValueError("Speaker-model upstream checksum mismatch: " + relative)
            destination = os.path.join(root, relative)
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            with open(destination, "wb") as file:
                file.write(data)
        sys.path.insert(0, root)
        from model.Model import ASD_Model

        class Speaker(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.model = ASD_Model()
                self.classifier = torch.nn.Linear(128, 2)
                state = torch.load(os.path.join(root, "weight/finetuning_TalkSet.model"),
                                   map_location="cpu", weights_only=True)
                self.model.load_state_dict({k[6:]: v for k, v in state.items() if k.startswith("model.")}, strict=True)
                self.classifier.load_state_dict({k[10:]: v for k, v in state.items() if k.startswith("lossAV.FC.")}, strict=True)
                # Upstream uses MaxPool3d on a 4-D unbatched tensor, pooling only
                # its last axis. Express the identical operation as 2-D pooling:
                # legacy ONNX otherwise emits invalid 3-element dilations.
                for name in ("pool1", "pool2"):
                    old = getattr(self.model.audioEncoder, name)
                    pool = torch.nn.MaxPool2d((1, 3), (1, 2), (0, 1))
                    probe = torch.randn(1, 32, 13, 32)
                    assert torch.equal(old(probe), pool(probe))
                    setattr(self.model.audioEncoder, name, pool)

            def forward(self, audio, video):
                a = self.model.forward_audio_frontend(audio)
                v = self.model.forward_visual_frontend(video)
                return torch.softmax(self.classifier(self.model.forward_audio_visual_backend(a, v)), dim=1)[:, 1]

        model = Speaker().eval()
        torch.onnx.export(model, (torch.zeros(1, 100, 13), torch.zeros(1, 25, 112, 112)), output,
                          input_names=["audio", "video"], output_names=["speaking"],
                          dynamic_axes={"audio": {1: "audio_frames"}, "video": {1: "video_frames"},
                                        "speaking": {0: "video_frames"}}, opset_version=17, dynamo=False)
        import numpy as np
        import onnxruntime as ort
        session = ort.InferenceSession(output, providers=["CPUExecutionProvider"])
        with torch.inference_mode():
            for count in (15, 25, 50, 75):
                a, v = torch.randn(1, count * 4, 13), torch.rand(1, count, 112, 112) * 255
                expected = model(a, v).numpy()
                actual = session.run(["speaking"], {"audio": a.numpy(), "video": v.numpy()})[0]
                np.testing.assert_allclose(actual, expected, rtol=2e-4, atol=2e-5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output")
    export(parser.parse_args().output)
