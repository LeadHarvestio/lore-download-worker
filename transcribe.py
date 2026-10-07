import json
import os
import sys

from faster_whisper import WhisperModel


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: transcribe.py <video-file>")

    model_name = os.environ.get("WHISPER_MODEL", "small.en")
    cpu_threads = max(1, int(os.environ.get("WHISPER_CPU_THREADS", "4")))
    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        cpu_threads=cpu_threads,
    )
    segments, _info = model.transcribe(
        sys.argv[1],
        word_timestamps=True,
        # Overlapping streamer voices/game audio are often discarded by VAD.
        vad_filter=False,
        language="en" if model_name.endswith(".en") else None,
        beam_size=5,
        condition_on_previous_text=False,
    )

    words = []
    for segment in segments:
        for word in segment.words or []:
            text = (word.word or "").strip()
            if text:
                words.append({
                    "start": float(word.start),
                    "end": float(word.end),
                    "text": text,
                })

    print(json.dumps({"words": words}, ensure_ascii=False))


if __name__ == "__main__":
    main()
