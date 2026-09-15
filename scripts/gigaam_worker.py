import argparse
import json
import os
import sys
import tempfile
import traceback
import wave

from transcription_runtime import probe_runtime


for stream in (sys.stdin, sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


def write_json(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def load_gigaam_model(args, device):
    import gigaam

    return gigaam.load_model(
        args.model,
        fp16_encoder=args.fp16_encoder,
        use_flash=False,
        device=device,
        download_root=args.download_root or None,
    )


def transcribe_audio(model, audio_path, chunk_seconds, offset_seconds):
    info = wav_info(audio_path)
    if info["durationSeconds"] <= chunk_seconds + 0.05:
        text = normalize_text(model.transcribe(audio_path))
        return {
            "text": text,
            "segments": make_segments(text, offset_seconds, offset_seconds + info["durationSeconds"]),
            "durationSeconds": info["durationSeconds"],
        }

    segments = []
    with wave.open(audio_path, "rb") as source:
        frames_per_chunk = max(1, int(source.getframerate() * chunk_seconds))
        chunk_index = 0

        while True:
            frames = source.readframes(frames_per_chunk)
            if not frames:
                break

            start = offset_seconds + (chunk_index * chunk_seconds)
            frame_count = len(frames) // max(1, source.getsampwidth() * source.getnchannels())
            duration = frame_count / source.getframerate()
            end = start + duration
            chunk_path = write_temp_wav(source, frames)

            try:
                text = normalize_text(model.transcribe(chunk_path))
            finally:
                safe_unlink(chunk_path)

            if text:
                segments.extend(make_segments(text, start, end))
            chunk_index += 1

    return {
        "text": " ".join(segment["text"] for segment in segments).strip(),
        "segments": segments,
        "durationSeconds": info["durationSeconds"],
    }


def wav_info(audio_path):
    with wave.open(audio_path, "rb") as wav:
        frame_count = wav.getnframes()
        frame_rate = wav.getframerate()
        duration = frame_count / frame_rate if frame_rate else 0
        return {
            "durationSeconds": duration,
            "sampleRate": frame_rate,
            "channels": wav.getnchannels(),
            "sampleWidth": wav.getsampwidth(),
        }


def write_temp_wav(source, frames):
    fd, chunk_path = tempfile.mkstemp(prefix="gigaam-chunk-", suffix=".wav")
    os.close(fd)

    with wave.open(chunk_path, "wb") as chunk:
        chunk.setnchannels(source.getnchannels())
        chunk.setsampwidth(source.getsampwidth())
        chunk.setframerate(source.getframerate())
        chunk.writeframes(frames)

    return chunk_path


def normalize_text(result):
    text = getattr(result, "text", str(result))
    return " ".join(str(text or "").split())


def make_segments(text, start, end):
    if not text:
        return []
    return [
        {
            "start": round(float(start), 2),
            "end": round(float(end), 2),
            "text": text,
        }
    ]


def safe_unlink(file_path):
    try:
        os.unlink(file_path)
    except OSError:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=os.environ.get("GIGAAM_MODEL", "v3_e2e_rnnt"))
    parser.add_argument("--device", default=os.environ.get("GIGAAM_DEVICE", "auto"))
    parser.add_argument("--download-root", default=os.environ.get("GIGAAM_DOWNLOAD_ROOT", ""))
    parser.add_argument("--check-runtime", action="store_true")
    parser.add_argument("--no-fp16-encoder", dest="fp16_encoder", action="store_false")
    parser.set_defaults(fp16_encoder=True)
    args = parser.parse_args()

    runtime = probe_runtime(args.device)
    if args.check_runtime:
        write_json(runtime)
        return 0

    try:
        if not runtime["available"]:
            raise RuntimeError(runtime.get("error") or "Transcription runtime is unavailable.")
        model = load_gigaam_model(args, runtime["selectedDevice"])
        runtime["actualDevice"] = str(next(model.parameters()).device)
        write_json({"type": "ready", "ok": True, "model": args.model,
                    "device": runtime["actualDevice"], "runtime": runtime})
    except Exception:
        write_json({"type": "ready", "ok": False, "runtime": runtime,
                    "error": traceback.format_exc(limit=8)})
        return 1

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            request_id = request["id"]
            result = transcribe_audio(
                model,
                request["audioPath"],
                float(request.get("chunkSeconds") or 20),
                float(request.get("offsetSeconds") or 0),
            )
            write_json({"id": request_id, "ok": True, **result})
        except Exception:
            write_json({
                "id": request.get("id") if "request" in locals() else None,
                "ok": False,
                "error": traceback.format_exc(limit=8),
            })

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
