"""Render VULTURE with Qwen3-TTS CustomVoice on a development GPU."""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


MODEL = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
BASE_DIRECTION = (
    "A charismatic American male underground sports announcer with a clear midrange voice and strong rhythmic drive. "
    "Crisp broadcast diction, natural conversational phrasing, controlled theatrical energy, and confident dark humor. "
    "Use clean vocal tone with no gravel, growling, vocal fry, or monster voice. Do not rush the sentence or over-stress random words."
)


def spoken_text(text: str) -> str:
    result = text.replace("{victim}", "the target").replace("{killer}", "the hired gun")
    result = result.replace("Hired muscle the hired gun", "The hired gun")
    result = result.replace("the target, meet floor", "the target meets the floor")
    result = result.replace(
        "the target just became the most valuable target",
        "That fighter just became the most valuable target",
    )
    return result[0].upper() + result[1:] if result else result


def direction(category: str) -> str:
    if category in {"matchStart", "firstBlood", "win", "champWin", "bossIntro"}:
        return BASE_DIRECTION + " Build cleanly toward the final phrase, like a live arena call, without shouting the entire line."
    if category in {"playerLow", "playerHurt", "playerArmHit", "playerLegHit", "enemyKillsAlly", "lose"}:
        return BASE_DIRECTION + " Deliver this as urgent live play-by-play: concerned momentum, restrained pace, and a sharp final beat."
    if category.startswith("event_") or category in {"bounty", "bloodrules", "nade", "bored"}:
        return BASE_DIRECTION + " Make the rule change immediately understandable, with mischievous excitement and one deliberate pause."
    return BASE_DIRECTION + " Deliver it as quick reactive play-by-play with amused confidence and a clean, decisive ending."


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--voice", default="Ryan")
    parser.add_argument("--speed", type=float, default=1.0)  # manifest compatibility; Qwen follows the direction
    parser.add_argument("--batch-size", type=int, default=6)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--refresh-dynamic", action="store_true")
    parser.add_argument("--no-manifest", action="store_true")
    args = parser.parse_args()

    lines = json.loads(args.input.read_text(encoding="utf-8"))
    pending = []
    for line in lines:
        destination = args.output / line["category"] / f"{int(line['index']) + 1:02d}.opus"
        if args.force or (args.refresh_dynamic and "{" in line["text"]) or not destination.exists():
            pending.append((line, destination))

    if pending:
        model = Qwen3TTSModel.from_pretrained(
            MODEL,
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
        )
        with tempfile.TemporaryDirectory(prefix="vulture-qwen-") as temporary:
            wav_path = Path(temporary) / "line.wav"
            batch_size = max(1, min(10, args.batch_size))
            for start in range(0, len(pending), batch_size):
                batch = pending[start:start + batch_size]
                texts = [spoken_text(line["text"]) for line, _ in batch]
                torch.manual_seed(8128 + start)
                wavs, sample_rate = model.generate_custom_voice(
                    text=texts,
                    language=["English"] * len(batch),
                    speaker=[args.voice] * len(batch),
                    instruct=[direction(line["category"]) for line, _ in batch],
                    temperature=0.75,
                    top_p=0.9,
                    repetition_penalty=1.1,
                    subtalker_temperature=0.75,
                    # At 12.5 acoustic frames/s this is room for roughly eight
                    # seconds—far beyond any authored call. The library default is
                    # 2048; one missed EOS in a batch otherwise burns minutes making
                    # silence while every other completed line waits behind it.
                    max_new_tokens=96,
                )
                for offset, ((line, destination), samples) in enumerate(zip(batch, wavs), 1):
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    sf.write(wav_path, samples, sample_rate)
                    subprocess.run([
                        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                        "-i", str(wav_path), "-af",
                        "highpass=f=65,lowpass=f=11500,acompressor=threshold=0.16:ratio=2:attack=8:release=90:makeup=1.2,loudnorm=I=-16:TP=-1.5:LRA=8",
                        "-c:a", "libopus", "-b:a", "48k", "-vbr", "on", str(destination),
                    ], check=True)
                    done = start + offset
                    print(f"[{done:03d}/{len(pending):03d}] {line['category']}/{destination.name} {texts[offset - 1]}", flush=True)


if __name__ == "__main__":
    main()
