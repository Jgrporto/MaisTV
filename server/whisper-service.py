import argparse
import base64
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5054
DEFAULT_MODEL = "tiny"
DEFAULT_LANGUAGE = "pt"
MAX_BODY_BYTES = int(os.environ.get("WHISPER_SERVICE_MAX_BODY_BYTES", str(32 * 1024 * 1024)))

_model = None
_model_name = ""
_model_lock = threading.Lock()


def _json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _extension_for_mime(mime_type):
    normalized = (mime_type or "").lower()
    if "mpeg" in normalized or "mp3" in normalized:
        return ".mp3"
    if "wav" in normalized:
        return ".wav"
    if "mp4" in normalized or "aac" in normalized:
        return ".m4a"
    if "webm" in normalized:
        return ".webm"
    if "amr" in normalized:
        return ".amr"
    return ".ogg"


def _load_model(model_name):
    global _model, _model_name
    normalized_model = (model_name or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    with _model_lock:
        if _model is not None and _model_name == normalized_model:
            return _model
        import whisper

        _model = whisper.load_model(normalized_model)
        _model_name = normalized_model
        return _model


class WhisperHandler(BaseHTTPRequestHandler):
    server_version = "MaisTVWhisper/1.0"

    def log_message(self, fmt, *args):
        print("[whisper-service] " + fmt % args, flush=True)

    def do_GET(self):
        if self.path == "/health":
            _json_response(
                self,
                200,
                {
                    "ok": True,
                    "model": _model_name or None,
                    "configured_model": os.environ.get("WHISPER_MODEL", DEFAULT_MODEL),
                },
            )
            return
        _json_response(self, 404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            _json_response(self, 404, {"error": "not found"})
            return

        content_length = int(self.headers.get("Content-Length") or "0")
        if content_length <= 0:
            _json_response(self, 400, {"error": "empty body"})
            return
        if content_length > MAX_BODY_BYTES:
            _json_response(self, 413, {"error": "audio payload too large"})
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            audio_base64 = str(payload.get("audioBase64") or "").strip()
            if not audio_base64:
                _json_response(self, 400, {"error": "audioBase64 is required"})
                return

            model_name = str(payload.get("model") or os.environ.get("WHISPER_MODEL") or DEFAULT_MODEL).strip()
            language = str(payload.get("language") or os.environ.get("WHISPER_LANGUAGE") or DEFAULT_LANGUAGE).strip()
            mime_type = str(payload.get("mimeType") or "audio/ogg").strip()
            audio_bytes = base64.b64decode(audio_base64, validate=True)
            if not audio_bytes:
                _json_response(self, 400, {"error": "audio payload is empty"})
                return

            model = _load_model(model_name)
            suffix = _extension_for_mime(mime_type)
            temp_path = None
            try:
                with tempfile.NamedTemporaryFile(prefix="maistv-whisper-", suffix=suffix, delete=False) as temp_file:
                    temp_file.write(audio_bytes)
                    temp_path = temp_file.name

                result = model.transcribe(temp_path, language=language, fp16=False)
                _json_response(
                    self,
                    200,
                    {
                        "text": (result.get("text") or "").strip(),
                        "language": result.get("language") or language,
                        "duration": result.get("duration"),
                        "model": model_name,
                    },
                )
            finally:
                if temp_path:
                    try:
                        os.unlink(temp_path)
                    except OSError:
                        pass
        except Exception as exc:
            _json_response(self, 500, {"error": str(exc)})


def main():
    parser = argparse.ArgumentParser(description="MaisTV Whisper transcription service.")
    parser.add_argument("--host", default=os.environ.get("WHISPER_SERVICE_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.environ.get("WHISPER_SERVICE_PORT", DEFAULT_PORT)))
    parser.add_argument("--warm", action="store_true", default=os.environ.get("WHISPER_SERVICE_WARM", "true").lower() in {"1", "true", "yes"})
    args = parser.parse_args()

    if args.warm:
      _load_model(os.environ.get("WHISPER_MODEL", DEFAULT_MODEL))

    server = ThreadingHTTPServer((args.host, args.port), WhisperHandler)
    print(f"[whisper-service] listening on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
