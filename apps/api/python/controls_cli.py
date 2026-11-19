# -*- coding: utf-8 -*-
"""Runs the research evidence controls + form presenter on ONE extraction document.
stdin : {"doc": <STAGEB-EXTRACTION doc>, "transcript": str, "ba03_approved": bool}
stdout: {"displayed": ..., "presentation": ..., "controls": ...}  (no transcript/quote/value is ever written to stderr)
Pure function, no network, no files. Reuses controls/ unchanged except the ENG-49 K2 patch (see controls/PROVENANCE.md)."""
import json
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "controls"))
import form_presenter as FP  # noqa: E402


def main() -> int:
    req = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    res = FP.present(req["doc"], req["transcript"], ba03_approved=bool(req.get("ba03_approved", True)))
    sys.stdout.buffer.write(json.dumps(res, ensure_ascii=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
