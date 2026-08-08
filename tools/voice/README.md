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

The checked-in bank uses Chatterbox Turbo 350M, cloned from the stable VULTURE
reference in `vulture-ref.wav`. It adds a small, deterministic set of performance
cues (breaths, dry chuckles, sighs, and whispers) to selected alternates, then
normalizes every clip to the same broadcast loudness. Generate it from an isolated
`chatterbox-tts` environment with CUDA-enabled PyTorch and:

```sh
npm run voice:generate -- --engine chatterbox --force
```

Chatterbox is MIT licensed. The previous Kokoro renderer remains available as a
quick CPU fallback, and the slower Qwen renderer remains available for experiments.
No inference runtime ships to players.

Procedural fighter names stay in the on-screen subtitle. Their clips use generic
phrases such as “the target” and “the hired gun,” keeping the bank finite and the
spoken grammar natural. After editing that substitution logic, use
`--refresh-dynamic` to rebuild only affected clips.
