"""Render the VULTURE bank with Chatterbox Turbo on a local CUDA GPU."""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from chatterbox.tts_turbo import ChatterboxTurboTTS


def perform(text: str, category: str, index: int) -> str:
    """Add restrained, deterministic delivery cues supported by Turbo.

    Most calls stay plain: the model should sound like a broadcaster, not a soundboard.
    The sparse cues create memorable alternates without turning every repeated event into
    the same vocal gimmick.
    """
    if category in {"win", "playerKill", "playerHeadshot"} and index % 9 == 4:
        return f"{text} [chuckle]"
    if category in {"lose", "allyKill", "playerLow"} and index % 8 == 3:
        return f"[sigh] {text}"
    if category in {"matchStart", "bossIntro"} and index % 7 == 2:
        return f"[breath] {text}"
    if category in {"lastEnemy", "bloodrules"} and index % 7 == 5:
        return f"[whisper] {text}"
    return text


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--no-manifest", action="store_true")
    parser.add_argument("--seed", type=int, default=3407)
    parser.add_argument("--temperature", type=float, default=0.76)
    args = parser.parse_args()

    if not torch.cuda.is_available():
        raise RuntimeError("Chatterbox voice rendering requires CUDA for this asset build")

    lines = json.loads(args.input.read_text(encoding="utf-8"))
    pending: list[tuple[dict, Path]] = []
    for line in lines:
        destination = args.output / line["category"] / f"{int(line['index']) + 1:02d}.opus"
        if args.force or not destination.exists():
            pending.append((line, destination))
    if not pending:
        return

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)

    model = ChatterboxTurboTTS.from_pretrained(device="cuda")
    # NumPy 2.x can promote the resampled reference waveform to float64 while the
    # model's mel basis correctly stays float32. Chatterbox 0.1.7 does not normalize
    # the waveform yet, so keep the offline compatibility shim local to this tool.
    prepare_audio = model.s3gen.tokenizer._prepare_audio
    model.s3gen.tokenizer._prepare_audio = lambda wavs: [wav.float() for wav in prepare_audio(wavs)]
    embed_mels = model.ve.embeds_from_mels
    def float32_embed_mels(mels, *embed_args, **embed_kwargs):
        if isinstance(mels, list):
            mels = [np.asarray(mel, dtype=np.float32) for mel in mels]
        elif torch.is_tensor(mels):
            mels = mels.float()
        return embed_mels(mels, *embed_args, **embed_kwargs)
    model.ve.embeds_from_mels = float32_embed_mels
    model.prepare_conditionals(str(args.reference), exaggeration=0.0)

    with tempfile.TemporaryDirectory(prefix="vulture-chatterbox-") as temporary:
        wav_path = Path(temporary) / "line.wav"
        for done, (line, destination) in enumerate(pending, 1):
            text = perform(line["voiceText"], line["category"], int(line["index"]))
            # A stable per-line seed makes the checked-in bank reproducible while still
            # allowing the model's delivery to vary from line to line.
            seed = args.seed + int(line["index"]) + sum(map(ord, line["category"]))
            torch.manual_seed(seed)
            torch.cuda.manual_seed_all(seed)
            samples = model.generate(
                text,
                temperature=args.temperature,
                top_p=0.92,
                top_k=850,
                repetition_penalty=1.22,
            )
            destination.parent.mkdir(parents=True, exist_ok=True)
            sf.write(wav_path, samples.squeeze().cpu().numpy(), model.sr)
            subprocess.run(
                [
                    "ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
                    # Only trim the head. End-trimming mistakes an intentional pause
                    # after a sigh/chuckle for EOF and can discard the spoken line.
                    "-af", "silenceremove=start_periods=1:start_silence=0.04:start_threshold=-48dB,loudnorm=I=-19:TP=-2:LRA=7",
                    "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "48k", "-vbr", "on",
                    str(destination),
                ],
                check=True,
            )
            print(f"[{done:03d}/{len(pending):03d}] {line['category']}/{destination.name} {text}", flush=True)


if __name__ == "__main__":
    main()
