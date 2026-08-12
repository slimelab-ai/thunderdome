# VULTURE voice bank

VULTURE uses pre-rendered Opus clips so gameplay never depends on a platform's Web
Speech implementation. The model runs only while producing assets; no model,
inference runtime, or browser speech API is shipped to players.

Install `requirements.txt` in a Python environment, ensure `ffmpeg` is available,
then run:

```sh
npm run voice:generate
```

Pass `--jobs` to render several lines in parallel only when the machine has enough
VRAM for one complete model per worker.

The generator downloads Kokoro 82M v1.0 and its voice embeddings into the ignored
`.cache/kokoro` directory. Override Python with `VOICE_PYTHON`, or pass existing
model files with `--model` and `--voices`. Existing clips are preserved unless
`--force` is supplied.

The checked-in bank uses the official Qwen3-TTS 12Hz 1.7B CustomVoice model with
the Ryan speaker and category-specific direction prompts. It has substantially
better pronunciation and delivery control than the previous 350M Chatterbox bank.
Generate it from an isolated `qwen-tts` environment with CUDA-enabled PyTorch and:

```sh
npm run voice:generate -- --engine qwen --force
```

Qwen3-TTS is Apache 2.0 licensed. The previous Chatterbox renderer and reference
voice remain available for comparisons, and Kokoro remains a quick CPU fallback.
No inference runtime ships to players.

Procedural fighter names stay in the on-screen subtitle. Their clips use generic
phrases such as “the target” and “the hired gun,” keeping the bank finite and the
spoken grammar natural. After editing that substitution logic, use
`--refresh-dynamic` to rebuild only affected clips.

All-caps subtitle emphasis is also normalized before synthesis (`KILLING TIME` is
spoken as `Killing Time`). This keeps visual emphasis in the HUD without causing
the voice model to shout, spell, or distort emphasized words.

After changing that normalization, rebuild only lines containing all-caps emphasis:

```sh
npm run voice:generate -- --engine qwen --refresh-emphasis
```

Use `--only event_molotov,matchStart/01 --output .cache/voice-samples` to render a
small comparison bank without touching the shipped clips.
