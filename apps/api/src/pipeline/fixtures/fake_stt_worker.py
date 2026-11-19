# -*- coding: utf-8 -*-
"""Protocol-compatible fake of stt_worker.py for lifecycle tests (no model, no network). Behaviour is chosen by the audio_path name:
  *crash* -> process exits abruptly | *hang* -> never answers | *bad* -> AUDIO_INVALID | *slow* -> answers after 1.5 s | else -> text 'שלום עולם'.
FAKE_STARTUP=fail -> emits fatal; FAKE_STARTUP=slow -> 1 s startup."""
import json, os, sys, time

def emit(o):
    sys.stdout.buffer.write((json.dumps(o, ensure_ascii=False) + "\n").encode("utf-8")); sys.stdout.buffer.flush()

if os.environ.get("FAKE_STARTUP") == "fail":
    emit({"event": "fatal", "code": "MODEL_LOAD_FAILED"}); sys.exit(3)
if os.environ.get("FAKE_STARTUP") == "slow":
    time.sleep(1)
emit({"event": "ready", "model_load_s": 0.01, "model_revision": "fake", "versions": {}})
for line in sys.stdin.buffer:
    req = json.loads(line.decode("utf-8"))
    if req.get("op") == "shutdown":
        break
    p = req["audio_path"]
    if "crash" in p:
        os._exit(1)
    if "hang" in p:
        time.sleep(3600)
    if "bad" in p:
        emit({"id": req["id"], "ok": False, "code": "AUDIO_INVALID"}); continue
    if "slow" in p:
        time.sleep(1.5)
    emit({"id": req["id"], "ok": True, "text": "שלום עולם", "audio_duration_s": 1.0, "decode_s": 0.01, "transcribe_s": 0.02})
