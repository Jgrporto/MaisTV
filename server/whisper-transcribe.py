import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(description="Transcribe an audio file with Whisper.")
    parser.add_argument("audio_path")
    parser.add_argument("--model", default="tiny")
    parser.add_argument("--language", default="pt")
    args = parser.parse_args()

    try:
        import whisper
    except Exception as exc:
        print(
            json.dumps({"error": f"Python package openai-whisper is not installed: {exc}"}),
            file=sys.stderr,
        )
        return 2

    model = whisper.load_model(args.model)
    result = model.transcribe(args.audio_path, language=args.language, fp16=False)
    print(
        json.dumps(
            {
                "text": (result.get("text") or "").strip(),
                "language": result.get("language") or args.language,
                "duration": result.get("duration"),
            },
            ensure_ascii=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
