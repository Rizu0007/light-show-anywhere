"""Speaks lines with Kokoro (an open, offline neural voice) for scripts/make-demo.mjs.

Reads a JSON list of {"text", "out", "speed"} on stdin and writes each line to a WAV file. The
model files are ../.demo-tools/models/kokoro-v1.0.onnx and voices-v1.0.bin; VOICE picks the voice
(default am_puck).
"""

import json
import os
import sys

import soundfile as sf
from kokoro_onnx import Kokoro

models = sys.argv[1]
kokoro = Kokoro(os.path.join(models, "kokoro-v1.0.onnx"), os.path.join(models, "voices-v1.0.bin"))
voice = os.environ.get("VOICE", "am_puck")
for line in json.load(sys.stdin):
    samples, rate = kokoro.create(line["text"], voice=voice, speed=line["speed"], lang="en-us")
    sf.write(line["out"], samples, rate)
    print(f"{len(samples) / rate:.2f}", flush=True)
