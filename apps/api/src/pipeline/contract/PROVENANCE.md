# Provenance of imported research assets (SRS 4.9.0 vertical slice)

Source root: `STT_CLOUD_TRANSFER_20261117/.../research/stage_b` (read-only; originals untouched).

| File here | Source | Status | Change |
|---|---|---|---|
| validate-extraction.ts | contracts/typescript/validate-extraction.ts (sha256 eb31938d…) | ADAPT | 1 line: schema path (`CANON = HERE`) |
| extraction.schema.json | contracts/canonical/extraction.schema.json (STAGEB-EXTRACTION-1.0.0, sha256 fb4a8bf7…) | REUSE | none |
| extraction_prompt_v4_ba03.txt | model_comparison/prompts/extraction_prompt_v4_layerA_neutral_ba03.txt (sha256 8ff84839…) — the prompt frozen for the Claude comparison round | REUSE | none |
| ../../../python/controls/evidence_controls.py | research/stage_b/controls/evidence_controls.py (EVIDENCE-CONTROLS-1.0.0-CANDIDATE, sha256 743da300…) | ADAPT | K2 switched off for `customer_address` (SRS ENG-49) |
| ../../../python/controls/form_presenter.py | research/stage_b/controls/form_presenter.py (sha256 ce2f5648…) | REUSE | none |
| ../../../python/stt_worker.py | local_stt/run_faster_whisper.py | ADAPT | rewritten as a long-running JSON-lines worker; same model/decoding config |
