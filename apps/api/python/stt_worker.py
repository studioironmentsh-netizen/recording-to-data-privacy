# -*- coding: utf-8 -*-
"""Long-running local Hebrew STT worker (JSON lines over stdin/stdout). ADAPTED from the research script
local_stt/run_faster_whisper.py: same model, same decoding configuration, but the model is loaded ONCE per worker lifecycle.

Protocol (one JSON object per line, UTF-8):
  worker -> {"event":"ready","model_load_s":float,"model_revision":str,"versions":{...}}      (after the model is loaded)
  worker -> {"event":"fatal","code":str}                                                   (startup failure; process exits 3)
  client -> {"id":str,"op":"transcribe","audio_path":str}
  worker -> {"id":str,"ok":true,"text":str,"audio_duration_s":float,"transcribe_s":float,"decode_s":float}
  worker -> {"id":str,"ok":false,"code":"AUDIO_INVALID"|"AUDIO_TOO_LONG"|"STT_FAILED"|"BAD_REQUEST"}
  client -> {"id":str,"op":"shutdown"}
Privacy: the transcript only travels on stdout to the parent process. Nothing is written to stderr/log except codes and timings.
No network at transcription time (HF_HUB_OFFLINE=1)."""
import json
import os
import platform
import sys
import time

sys.dont_write_bytecode = True
os.environ["HF_HUB_OFFLINE"] = "1"

# Baseline decoding configuration from the verified experiment. Do not change silently.
DECODING = {"language": "he", "beam_size": 5, "vad_filter": False, "condition_on_previous_text": False, "initial_prompt": None}
COMPUTE_TYPE = "int8"
DEVICE = "cpu"
EXPECTED_REVISION = "72ad623a37947395efcc3933132353790e5a12f5"


def emit(obj) -> None:
    sys.stdout.buffer.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def fatal(code: str) -> None:
    emit({"event": "fatal", "code": code})
    sys.exit(3)


def check_model_dir(model_dir: str) -> str:
    """Cheap startup integrity check against MODEL_MANIFEST.json (sizes + pinned revision). Full SHA-256: verify_model.py."""
    mf = os.path.join(model_dir, "MODEL_MANIFEST.json")
    if not os.path.isfile(mf):
        fatal("MODEL_MANIFEST_MISSING")
    manifest = json.load(open(mf, encoding="utf-8"))
    if manifest.get("revision") != EXPECTED_REVISION:
        fatal("MODEL_REVISION_MISMATCH")
    for name, meta in manifest["files"].items():
        p = os.path.join(model_dir, name)
        if not os.path.isfile(p) or os.path.getsize(p) != meta["bytes"]:
            fatal("MODEL_FILE_MISSING_OR_SIZE_MISMATCH")
    return manifest["revision"]


def main() -> int:
    model_dir = os.environ.get("STT_MODEL_DIR", "")
    if not model_dir or not os.path.isabs(model_dir):
        fatal("STT_MODEL_DIR_NOT_ABSOLUTE")
    max_audio_s = float(os.environ.get("STT_MAX_AUDIO_SECONDS", "300"))
    threads = int(os.environ.get("STT_CPU_THREADS", str(os.cpu_count() or 2)))
    revision = check_model_dir(model_dir)
    try:
        import ctranslate2
        import faster_whisper
        from faster_whisper import WhisperModel
        from faster_whisper.audio import decode_audio
    except ImportError:
        fatal("STT_DEPENDENCIES_NOT_INSTALLED")
    t0 = time.perf_counter()
    try:
        model = WhisperModel(model_dir, device=DEVICE, compute_type=COMPUTE_TYPE, cpu_threads=threads)
    except Exception:
        fatal("MODEL_LOAD_FAILED")
    emit({"event": "ready", "model_load_s": round(time.perf_counter() - t0, 3), "model_revision": revision,
          "versions": {"faster_whisper": faster_whisper.__version__, "ctranslate2": ctranslate2.__version__, "python": platform.python_version()},
          "config": {**DECODING, "compute_type": COMPUTE_TYPE, "device": DEVICE, "cpu_threads": threads}})

    for line in sys.stdin.buffer:
        try:
            req = json.loads(line.decode("utf-8"))
            rid = str(req["id"])
        except Exception:
            emit({"id": None, "ok": False, "code": "BAD_REQUEST"})
            continue
        op = req.get("op")
        if op == "shutdown":
            return 0
        if op != "transcribe" or not isinstance(req.get("audio_path"), str):
            emit({"id": rid, "ok": False, "code": "BAD_REQUEST"})
            continue
        try:
            t1 = time.perf_counter()
            try:
                audio = decode_audio(req["audio_path"], sampling_rate=16000)  # PyAV decodes ogg/opus, m4a, wav, ... (no ffmpeg binary needed)
            except Exception:
                emit({"id": rid, "ok": False, "code": "AUDIO_INVALID"})
                continue
            duration = len(audio) / 16000.0
            if duration <= 0.2:
                emit({"id": rid, "ok": False, "code": "AUDIO_INVALID"})
                continue
            if duration > max_audio_s:
                emit({"id": rid, "ok": False, "code": "AUDIO_TOO_LONG"})
                continue
            t2 = time.perf_counter()
            segments, _info = model.transcribe(audio, **DECODING)
            text = " ".join(s.text.strip() for s in segments).strip()  # generator: decoding happens here
            t3 = time.perf_counter()
            emit({"id": rid, "ok": True, "text": text, "audio_duration_s": round(duration, 3),
                  "decode_s": round(t2 - t1, 3), "transcribe_s": round(t3 - t2, 3)})
        except Exception:
            emit({"id": rid, "ok": False, "code": "STT_FAILED"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
