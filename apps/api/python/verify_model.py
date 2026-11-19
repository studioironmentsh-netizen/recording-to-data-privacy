# -*- coding: utf-8 -*-
"""Full integrity check of the local STT model against MODEL_MANIFEST.json (size + SHA-256 + pinned revision).
Usage: python verify_model.py <absolute model dir>      Exit 0 = all files match."""
import hashlib
import json
import os
import sys

EXPECTED_REVISION = "72ad623a37947395efcc3933132353790e5a12f5"


def main() -> int:
    d = sys.argv[1]
    m = json.load(open(os.path.join(d, "MODEL_MANIFEST.json"), encoding="utf-8"))
    ok = m.get("revision") == EXPECTED_REVISION
    print(f"revision {'OK' if ok else 'MISMATCH'}")
    for name, meta in m["files"].items():
        p = os.path.join(d, name)
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 22), b""):
                h.update(chunk)
        good = os.path.getsize(p) == meta["bytes"] and h.hexdigest() == meta["sha256"]
        ok &= good
        print(f"{name}: {'OK' if good else 'MISMATCH'}")
    print("MODEL_VERIFIED" if ok else "MODEL_VERIFICATION_FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
