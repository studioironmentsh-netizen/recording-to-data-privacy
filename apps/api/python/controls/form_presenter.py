# -*- coding: utf-8 -*-
"""ACTIVE ENFORCEMENT of the evidence controls (SRS 4.7.2 section 4.2.6, EV-R3). Not shadow mode: the DISPLAYED form is built from the controls' classification.
  REJECTED_INFERENCE -> the value is REMOVED from the displayed form (value null; VAT 'UNKNOWN'), the field is marked UNCLEAR + completion_required; the original value stays in the untouched raw/extraction files.
  UNCLEAR            -> stays empty, marked completion_required.      HUMAN_CONFIRM -> value kept and marked confirmation_required.      VERIFIED / MISSING -> unchanged.
Guarantees (tested): the raw output and the extraction document are never modified; nothing is guessed, completed or corrected; the audit record carries field names and control codes only (no transcript / quote / value).
Version: FORM-PRESENTER-1.0.0 (separate from EVIDENCE-CONTROLS-1.0.0 and from the contract). Freeze before the comparison round:  python -I form_presenter.py freeze
"""
import copy
import hashlib
import json
import os
import sys
import time

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import evidence_controls as EC  # noqa: E402

VERSION = "FORM-PRESENTER-1.0.0"
VAT = ("parts_vat_basis", "visit_vat_basis")
FREEZE = os.path.join(HERE, "PRESENTER_FREEZE.json")


def present(doc, transcript, ba03_approved=False):
    """-> {displayed, presentation, controls}. `doc` is never modified."""
    ctl = EC.classify_form(doc, transcript, ba03_approved=ba03_approved)
    disp = copy.deepcopy(doc)
    pres = {}
    for k, v in ctl["fields"].items():
        cls, flags = v["class"], v["flags"]
        entry = {"class": cls, "control_codes": flags, "completion_required": False, "confirmation_required": False, "value_removed": False}
        if cls == "REJECTED_INFERENCE":
            ef, fs = disp["extracted_fields"][k], disp.setdefault("field_states", {}).setdefault(k, {})
            ef["value"] = "UNKNOWN" if k in VAT else None
            ef["evidence_state"] = "UNCLEAR"
            ef["needs_clarification"] = True
            fs["uncertainty_reason"] = "AMBIGUOUS_REFERENCE"
            fs["evidence_quote"] = None
            for extra in ("item_timing", "summary_items", "self_correction_events"):
                fs.pop(extra, None)
            entry.update(completion_required=True, value_removed=True)
        elif cls == "UNCLEAR":
            entry.update(completion_required=True)
        elif cls == "HUMAN_CONFIRM":
            entry.update(confirmation_required=True)
        pres[k] = entry
    return {"displayed": disp, "presentation": pres, "controls": ctl}


def audit_record(res):
    """Content-free audit: field names + codes only (SRS 10.1)."""
    return {"presenter_version": VERSION, "controls_version": EC.CONTROLS_VERSION, "fields": {k: {"class": v["class"], "codes": v["control_codes"], "value_removed": v["value_removed"]} for k, v in res["presentation"].items()}}


def sha_file(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def apply_to_run(run_dir, texts, ba03_approved=False):
    """Reads a finished run (validator-passed forms only), writes controls_applied/<id>.json (+ .aux.json, .presentation.json) and run_manifest_after_controls.json. Original files are hash-checked before/after."""
    man = json.load(open(os.path.join(run_dir, "run_manifest.json"), encoding="utf-8"))
    originals = {}
    for r in man["runs"]:
        if r.get("output"):
            for suffix in ("", ".aux"):
                p = os.path.join(run_dir, r["output"][:-5] + suffix + ".json")
                if os.path.exists(p):
                    originals[p] = sha_file(p)
    out = os.path.join(run_dir, "controls_applied")
    os.makedirs(out, exist_ok=True)
    rows = []
    for r in man["runs"]:
        nr = dict(r)
        if r.get("status") == "OK" and r.get("output"):
            doc = json.load(open(os.path.join(run_dir, r["output"]), encoding="utf-8"))
            res = present(doc, texts[r["recording_id"]], ba03_approved)
            rid = r["recording_id"]
            json.dump(res["displayed"], open(os.path.join(out, rid + ".json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            json.dump(res["presentation"], open(os.path.join(out, rid + ".presentation.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            aux = json.load(open(os.path.join(run_dir, r["output"][:-5] + ".aux.json"), encoding="utf-8"))
            aux["controls_audit"] = audit_record(res)
            json.dump(aux, open(os.path.join(out, rid + ".aux.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
            nr["output"] = os.path.join("controls_applied", rid + ".json")
        rows.append(nr)
    after = dict(man)
    after["runs"] = rows
    after["note"] = "DISPLAYED forms after active evidence controls; raw and extraction files are unchanged"
    json.dump(after, open(os.path.join(run_dir, "run_manifest_after_controls.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    unchanged = all(sha_file(p) == h for p, h in originals.items())
    json.dump({"originals_checked": len(originals), "all_unchanged": unchanged}, open(os.path.join(out, "_integrity.json"), "w"), indent=1)
    if not unchanged:
        raise RuntimeError("original extraction files changed - controls must never modify the raw output")
    return after


def main(argv=None):
    cmd = (argv or sys.argv[1:] or [""])[0]
    if cmd == "freeze":
        f = {"presenter_version": VERSION, "frozen_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "presenter_sha256": sha_file(os.path.abspath(__file__)), "controls_module_sha256": sha_file(os.path.join(HERE, "evidence_controls.py")),
             "tests_sha256": sha_file(os.path.join(HERE, "tests", "test_presenter.py"))}
        json.dump(f, open(FREEZE, "w", encoding="utf-8"), indent=1)
        print("FREEZE written", FREEZE)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
