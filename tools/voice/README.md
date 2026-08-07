# VULTURE voice bank

VULTURE uses pre-rendered Opus clips so gameplay never depends on a platform's Web
Speech implementation. The model runs only while producing assets; no model,
inference runtime, or browser speech API is shipped to players.

Install `requirements.txt` in a Python environment, ensure `ffmpeg` is available,
then run:

```sh
npm run voice:generate
```

Pass `--jobs 4` to render several lines in parallel on a machine with enough RAM;
each worker loads roughly 600 MB while it runs.

The generator downloads Kokoro 82M v1.0 and its voice embeddings into the ignored
`.cache/kokoro` directory. Override Python with `VOICE_PYTHON`, or pass existing
model files with `--model` and `--voices`. Existing clips are preserved unless
`--force` is supplied.

The checked-in bank uses `am_michael` at speed 1.04 with light EQ, compression,
and loudness normalization. Kokoro's model weights are Apache-2.0 licensed; the
`kokoro-onnx` runtime used only by this development tool is MIT licensed.

Procedural fighter names stay in the on-screen subtitle. Their clips use generic
phrases such as “the target” and “the hired gun,” keeping the bank finite and the
spoken grammar natural. After editing that substitution logic, use
`--refresh-dynamic` to rebuild only affected clips.
