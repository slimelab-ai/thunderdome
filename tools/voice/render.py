"""Render VULTURE's checked-in Opus voice bank with Kokoro ONNX."""

import argparse
import json
import subprocess
import tempfile
import urllib.request
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro


MODEL_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx"
VOICES_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"


def ensure_download(path: Path, url: str) -> Path:
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {url} -> {path}")
    urllib.request.urlretrieve(url, path)
    return path


def spoken_text(text: str) -> str:
    # Names remain personalized in the subtitle. The audio uses durable generic
    # wording so one clip can serve every procedurally named combatant.
    result = text.replace("{victim}", "the target").replace("{killer}", "the hired gun")
    result = result.replace("Hired muscle the hired gun", "The hired gun")
    result = result.replace("the target, meet floor", "the target meets the floor")
    result = result.replace(
        "the target just became the most valuable target",
        "That fighter just became the most valuable target",
    )
    return result[0].upper() + result[1:] if result else result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--voices", type=Path)
    parser.add_argument("--voice", default="am_michael")
    parser.add_argument("--speed", default=1.04, type=float)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--refresh-dynamic", action="store_true")
    parser.add_argument("--no-manifest", action="store_true")
    args = parser.parse_args()

    cache = Path(__file__).resolve().parents[2] / ".cache" / "kokoro"
    model = ensure_download(args.model or cache / "kokoro-v1.0.onnx", MODEL_URL)
    voices = ensure_download(args.voices or cache / "voices-v1.0.bin", VOICES_URL)
    engine = Kokoro(str(model), str(voices))
    lines = json.loads(args.input.read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)

    rendered = []
    with tempfile.TemporaryDirectory(prefix="vulture-wav-") as temporary:
        wav = Path(temporary) / "line.wav"
        for position, line in enumerate(lines, 1):
            category = line["category"]
            index = int(line["index"])
            destination = args.output / category / f"{index + 1:02d}.opus"
            destination.parent.mkdir(parents=True, exist_ok=True)
            voice_text = spoken_text(line["text"])
            if args.force or (args.refresh_dynamic and "{" in line["text"]) or not destination.exists():
                samples, sample_rate = engine.create(
                    voice_text, voice=args.voice, speed=args.speed, lang="en-us"
                )
                sf.write(wav, samples, sample_rate)
                subprocess.run([
                    "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                    "-i", str(wav), "-af",
                    "highpass=f=70,lowpass=f=10500,acompressor=threshold=0.12:ratio=2.5:attack=10:release=100:makeup=1.35,loudnorm=I=-16:TP=-1.5:LRA=7",
                    "-c:a", "libopus", "-b:a", "48k", "-vbr", "on",
                    str(destination),
                ], check=True)
            rendered.append({
                "category": category,
                "index": index,
                "file": f"{category}/{index + 1:02d}.opus",
                "subtitle": line["text"],
                "voiceText": voice_text,
            })
            print(f"[{position:03d}/{len(lines):03d}] {destination.name} {voice_text}")

    if not args.no_manifest:
        manifest = {
            "format": 1,
            "engine": "Kokoro-82M-v1.0-ONNX",
            "voice": args.voice,
            "speed": args.speed,
            "codec": "Opus 48 kbps mono",
            "lines": rendered,
        }
        (args.output / "manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )


if __name__ == "__main__":
    main()
