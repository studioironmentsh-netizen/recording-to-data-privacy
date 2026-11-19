# -*- coding: utf-8 -*-
"""EVIDENCE CONTROLS (version EVIDENCE-CONTROLS-1.0.0-CANDIDATE). A NEW, separate module: it is NOT the contract, NOT the validator (BV-RULES-1.1.0), NOT the frozen scorer.
Deterministic checks that decide whether an extracted value is SUPPORTED by the transcript. They only CLASSIFY: they never edit, repair or guess a value.

Per-field outcome classes:
  VERIFIED             PRESENT and every applicable check passed
  MISSING              not said
  UNCLEAR              said but not safely extractable / not decided
  HUMAN_CONFIRM        needs a human decision (NEEDS_CONFIRMATION by the model, weekday expression, past-modal part when BA-03 is approved)
  REJECTED_INFERENCE   PRESENT but unsupported by the evidence / forbidden inference: the value must NOT be shown as filled (kept only for audit)

Checks (decision ids in brackets; all lexicons are CLOSED and come from decisions D1-D7, nothing was added to fit a model):
  K1 quote is a verbatim substring of the transcript (BV-10 idea)               K2 value is visible in its quote (BV-20 idea; part names tolerant to a leading ה׳, D4)
  K3 `[]` needs an explicit negation about PARTS in the quote (D2)               K4 INCLUDED/EXCLUDED needs a closed-lexicon VAT phrase in the price clause (D3)
  K6 deictic 'now' words are not a date (D1); weekday expression needs confirmation (ENG-33)
  K7 planned/needed replacement is not 'replaced' (D7-R1); past-modal without execution cue: REJECTED by default, HUMAN_CONFIRM once BA-03 is approved (D7-R2)
  K8 VAT state coupling (D5): a VAT cue was said near a price but the VAT state is UNKNOWN -> flagged (state is not edited)
Shadow/measurement use only; changing any lexicon or rule = a NEW version (and a new freeze).
"""
import re
import unicodedata

CONTROLS_VERSION = "EVIDENCE-CONTROLS-1.0.0-CANDIDATE"
FIELDS = ["customer_name", "visit_date_statement", "customer_address", "customer_phone", "customer_external_number", "work_summary", "spare_parts", "parts_price", "parts_vat_basis", "visit_price", "visit_vat_basis", "next_visit"]
PRICE_OF = {"parts_vat_basis": "parts_price", "visit_vat_basis": "visit_price"}
DEICTIC_NOW = ["עכשיו", "כרגע", "הרגע", "זה עתה"]                                      # D1
WEEKDAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"]                       # ENG-33
NEG = re.compile(r"(?<![א-ת])(לא|בלי|ללא|אין)(?![א-ת])")                                  # D2
PARTS_TERM = re.compile(r"(?<![א-ת])(חלק|חלקים|חלפים)(?![א-ת])")                           # D2
EXCLUDED_PHRASES = re.compile(r"(?<![א-ת])(לא כולל מעמ|לפני מעמ)(?![א-ת])")                # D3 closed lexicon
INCLUDED_PHRASE = re.compile(r"(?<![א-ת])(?<!לא )(?<!ללא )כולל מעמ(?![א-ת])")               # D3 closed lexicon
SCOPE_TRAILER = re.compile(r"(?<![א-ת])(כל זה|הכל|הכול)\s+(לא כולל מעמ|כולל מעמ)")          # D3 scope phrase
VAT_CUE = re.compile(r"מעמ|כולל|אחרי מעמ")                                                  # D5 'something was said about VAT/inclusion'
CL = r"[ושמכלבה]{0,2}"                                                                      # clitic prefixes (D6 policy applied to detection of cues too)
PLANNED_MODAL = re.compile(r"(?<![א-ת])(?<!היה )(?<!הייתי )(" + CL + r"צריך|צריכים|צריכה|יש להחליף|" + CL + r"אחליף|" + CL + r"נחליף|" + CL + r"אצטרך|עדיין לא החלפתי)(?![א-ת])")   # D7-R1 (present/future)
PAST_MODAL = re.compile(r"(?<![א-ת])[שו]?(היה צריך|הייתי צריך|היו צריכים)(?![א-ת])")              # D7-R2 (BA-03)
CL_EXEC = r"[ושמכבה]{0,2}"                                                                  # no ל: 'להחליף' is the infinitive, not an execution cue
EXEC_CUE = re.compile(r"(?<![א-ת])" + CL_EXEC + r"(החלפתי|הוחלף|הוחלפה|הוחלפו|החליפו|החלפנו|החליף)(?![א-ת])")   # execution cue: past verb on the part
NOT_DONE = re.compile(r"לא החלפתי|עדיין לא החלפתי|לא הוחלף")


def norm(s):
    s = unicodedata.normalize("NFC", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = re.sub(r"[\"'׳״`“”„]", "", s)
    s = re.sub(r"[.,;:!?()\[\]]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _words_in(value, quote):
    qw = set(norm(quote).split())
    for w in norm(value).split():
        alt = w[1:] if (w.startswith("ה") and len(w) > 2) else "ה" + w
        if w in qw or alt in qw:
            continue
        return False
    return True


def _digits(s):
    return re.sub(r"\D", "", s or "")


def price_window(transcript, quote, amount):
    """Text to the right of the price amount, up to the next number or line end. Plus the trailing text after the last number of the line (scope phrases)."""
    for line in transcript.split("\n"):
        nl = norm(line)
        q = norm(quote or "")
        if q and q in nl:
            base = nl.index(q)
            m = re.search(r"(?<!\d)" + re.escape(str(amount)) + r"(?!\d)", nl[base:])
        else:
            m = re.search(r"(?<!\d)" + re.escape(str(amount)) + r"(?!\d)", nl)
            base = 0
        if not m:
            continue
        start = base + m.end()
        nxt = re.search(r"\d", nl[start:])
        window = nl[start: start + nxt.start()] if nxt else nl[start:]
        nums = list(re.finditer(r"\d+", nl))
        trailer = nl[nums[-1].end():] if nums else ""
        return window, trailer
    return "", ""


def segment_of(transcript, quote):
    """The sentence (or, failing that, the line) of the transcript that contains the evidence quote: modality is judged in context, not only in the quote the model chose."""
    q = norm(quote or "")
    if not q:
        return ""
    for line in transcript.split(chr(10)):
        for seg in re.split(r"[.!?]", line):
            if q in norm(seg):
                return norm(seg)
    for line in transcript.split(chr(10)):
        if q in norm(line):
            return norm(line)
    return q


def lexicon_basis(window, trailer):
    """-> 'INCLUDED' | 'EXCLUDED' | None (closed lexicon, D3). A scope phrase in the trailer applies when the own window has no phrase."""
    if EXCLUDED_PHRASES.search(window) and not INCLUDED_PHRASE.search(window):
        return "EXCLUDED"
    if INCLUDED_PHRASE.search(window) and not EXCLUDED_PHRASES.search(window):
        return "INCLUDED"
    if not EXCLUDED_PHRASES.search(window) and not INCLUDED_PHRASE.search(window):
        m = SCOPE_TRAILER.search(trailer)
        if m:
            return "EXCLUDED" if m.group(2).startswith("לא") else "INCLUDED"
    return None


def classify_field(k, doc, transcript, ba03_approved=False, anchor_present=False):
    ef, fs = doc["extracted_fields"][k], (doc.get("field_states") or {}).get(k, {})
    st, val, q = ef.get("evidence_state"), ef.get("value"), fs.get("evidence_quote")
    T = norm(transcript)
    if st in ("MISSING", "UNKNOWN"):
        flags = []
        if k in PRICE_OF.values() or k in PRICE_OF:      # K8 is evaluated on VAT fields below
            pass
        if k in PRICE_OF and st == "UNKNOWN":
            pk = PRICE_OF[k]
            pq = (doc.get("field_states") or {}).get(pk, {}).get("evidence_quote") or ""
            pv = doc["extracted_fields"][pk].get("value")
            if isinstance(pv, dict):
                w, t = price_window(transcript, pq, pv.get("amount"))
                if VAT_CUE.search(w) or SCOPE_TRAILER.search(t):
                    flags.append("K8_VAT_CUE_SAID_BUT_STATE_UNKNOWN")
        return ("HUMAN_CONFIRM" if flags else "MISSING"), flags
    if st in ("UNCLEAR", "NOT_DECIDED"):
        return "UNCLEAR", []
    if st == "NEEDS_CONFIRMATION":
        return "HUMAN_CONFIRM", ["NEEDS_CONFIRMATION_BY_MODEL"]
    flags, soft = [], []
    if not q:
        flags.append("K1_NO_QUOTE")
    elif norm(q) not in T:
        flags.append("K1_QUOTE_NOT_VERBATIM")
    # ADAPTED (SRS 4.9.0 ENG-49): K2 is switched off for customer_address until EVIDENCE-CONTROLS-1.1.0.
    if k in ("customer_name", "customer_external_number") and isinstance(val, str) and q and not _words_in(val, q):
        flags.append("K2_VALUE_NOT_IN_QUOTE")
    if k == "customer_phone" and isinstance(val, str) and q and _digits(val) not in _digits(q):
        flags.append("K2_PHONE_DIGITS_NOT_IN_QUOTE")
    if k in ("parts_price", "visit_price") and isinstance(val, dict) and q and val.get("amount") not in re.findall(r"\d+(?:\.\d+)?", q):
        flags.append("K2_AMOUNT_NOT_IN_QUOTE")
    if k == "spare_parts" and isinstance(val, list):
        if not val:
            if not (q and NEG.search(norm(q)) and PARTS_TERM.search(norm(q))):
                flags.append("K3_EMPTY_LIST_WITHOUT_EXPLICIT_PARTS_NEGATION")
        else:
            for p in val:
                if q and not _words_in(p.get("name", ""), q) and not _words_in(p.get("name", ""), transcript):
                    flags.append("K2_PART_NAME_NOT_IN_QUOTE")
            nq = segment_of(transcript, q)
            if q and PLANNED_MODAL.search(nq) and not EXEC_CUE.search(nq):
                flags.append("K7_PLANNED_NOT_DONE")
            elif q and PAST_MODAL.search(nq) and not EXEC_CUE.search(nq):
                (soft if ba03_approved else flags).append("K7_PAST_MODAL_NO_EXECUTION_CUE" + ("_BA03" if ba03_approved else "_DEFAULT_NOT_REPLACED"))
            if q and NOT_DONE.search(nq):
                flags.append("K7_NEGATED_REPLACEMENT_LISTED")
    if k in PRICE_OF and val in ("INCLUDED", "EXCLUDED"):
        pk = PRICE_OF[k]
        pq = (doc.get("field_states") or {}).get(pk, {}).get("evidence_quote") or ""
        pv = doc["extracted_fields"][pk].get("value")
        basis = None
        if isinstance(pv, dict):
            w, t = price_window(transcript, pq, pv.get("amount"))
            basis = lexicon_basis(w, t)
        if basis != val:
            flags.append("K4_VAT_BASIS_NOT_IN_CLOSED_LEXICON")
    if k in ("visit_date_statement", "next_visit") and isinstance(val, dict):
        ex = norm(val.get("expression") or "")
        if k == "visit_date_statement" and ex in DEICTIC_NOW:
            flags.append("K6_DEICTIC_NOW_IS_NOT_A_DATE")
        if re.search(r"(^| )(ב?יום )?(" + "|".join(WEEKDAYS) + r")( |$)", ex) and val.get("date") is None:
            soft.append("K6_WEEKDAY_NEEDS_CONFIRMATION")
    if flags:
        return "REJECTED_INFERENCE", flags
    if soft:
        return "HUMAN_CONFIRM", soft
    return "VERIFIED", []


def classify_form(doc, transcript, ba03_approved=False, anchor_present=False):
    out, cnt = {}, {}
    for k in FIELDS:
        c, f = classify_field(k, doc, transcript, ba03_approved, anchor_present)
        out[k] = {"class": c, "flags": f}
        cnt[c] = cnt.get(c, 0) + 1
    attention = [k for k, v in out.items() if v["class"] in ("HUMAN_CONFIRM", "REJECTED_INFERENCE")]
    return {"controls_version": CONTROLS_VERSION, "fields": out, "class_counts": cnt, "fields_needing_human_attention": attention, "form_needs_human_attention": bool(attention),
            "values_modified_by_controls": []}
