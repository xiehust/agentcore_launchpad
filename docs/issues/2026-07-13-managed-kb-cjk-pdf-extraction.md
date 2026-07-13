# Managed KB: SMART_PARSING destroys CJK text when ingesting a healthy Chinese PDF

| | |
|---|---|
| **Status** | Open — deferred (upstream AWS limitation; verified workaround available) |
| **Severity** | High for CJK content (retrieval on affected documents is useless) |
| **Component** | Amazon Bedrock Managed Knowledge Base — ingestion / Smart Parsing |
| **Affected area in Launchpad** | Knowledge Bases → upload PDF → Playground / agent retrieval |
| **Environment** | us-west-2, KB `BL6ZKAVWFB` (`aurora-deck-docs`, type MANAGED), botocore 1.43.44 |
| **Date investigated** | 2026-07-13 |

## Summary

Uploading a Chinese PDF (`和豆包的对话_0627.pdf`, 7 pages, 361,727 bytes) to a
Managed Knowledge Base produces garbled chunks in the index: all CJK characters
are destroyed during Bedrock-side ingestion and replaced with scattered ASCII
fragments, while embedded Latin words (AWS, Bedrock, CloudWatch…) survive.
Retrieval on the document is therefore useless, and the per-document metadata
reports `_language_code: en`.

The PDF itself is healthy. The failure is inside the Managed KB's
**SMART_PARSING** text extraction, and Managed KBs offer **no alternative
parser**, so this cannot be fixed by configuration.

## Reproduction

1. Upload `和豆包的对话_0627.pdf` to a Managed KB via Launchpad
   (`POST /api/knowledge-bases/{kb}/files`) and let ingestion complete
   (`COMPLETE`, 1 document indexed).
2. Query the Playground (`POST /api/knowledge-bases/BL6ZKAVWFB/query`) with
   `"豆包评价"` — or open
   `http://localhost:5173/knowledge-bases?view=detail&kb=BL6ZKAVWFB` and search.
3. Observe garbled results, e.g. top chunk (score 0.365):

   ```
   'X THE\n1 ADP, #5: , emo, . K A , , WS - T3 1 #7 1 Л , , = (10, -\n…'
   metadata._language_code = "en"
   ```

## Evidence chain (what was ruled out)

1. **Not a transport/encoding bug in Launchpad.** The same API responses carry
   `_document_title: 和豆包的对话_0627.pdf` in perfect UTF-8 end-to-end
   (backend → JSON → UI). Only the *indexed chunk text* is garbage — i.e. the
   corruption already exists in the vector store.
2. **Not a broken PDF.** Local extraction of the exact S3 object with `pypdf`
   yields clean Chinese: page 1 has 457 CJK characters
   (`和豆包的对话_0627\n用户：\n前两天亚马逊云科技发布了一个 企业生产级智能体开发和部署指南…`);
   whole document: 4,660 chars, 3,351 CJK. Fonts are `Type0`
   SourceHanSansCN (Bold/Regular/Medium) **with `/ToUnicode` maps** plus
   Helvetica — a textbook-healthy CJK text layer.
3. **Bedrock-side extraction is the culprit.** The chunks stored by ingestion
   (returned verbatim by `bedrock-agent-runtime.Retrieve`) contain no CJK at
   all. SMART_PARSING evidently fails on Type0/CID-keyed CJK fonts (or applies
   a Latin-biased OCR/visual pass), keeping only ASCII spans.
4. **No parser escape hatch.** Per AWS docs
   ([Customize ingestion for managed KBs](https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-customize-ingestion.html)):
   *“Managed knowledge bases only support the `SMART_PARSING` strategy. Other
   parsing strategies such as `BEDROCK_FOUNDATION_MODEL` and
   `BEDROCK_DATA_AUTOMATION` are not supported.”* (Classic VECTOR KBs do
   support those, but they cannot be served by the AgentCore
   `bedrock-knowledge-bases` gateway connector, which is Managed-only.)
5. **Plain Chinese text ingests correctly** (control experiment). Extracting
   the same content to UTF-8 Markdown
   (`和豆包的对话_0627_文本版.md`) and re-syncing produced fully correct
   Chinese chunks; the query `"豆包评价 白皮书 靠谱"` returns readable,
   relevant passages (top score 0.527). So the embedding/retrieval pipeline
   handles Chinese fine — only PDF text extraction is broken.

## Notes on `_language_code`

`_language_code` is set to `en` even for the correctly-ingested Chinese
Markdown, so it is an inaccurate service-side detection label (a symptom for
the garbled PDF, merely cosmetic for healthy Chinese text). Retrieval quality
is embedding-based and unaffected by this label.

## Current state of the demo KB

`aurora-deck-docs` (`BL6ZKAVWFB`) currently contains **both** the garbled PDF
chunks and the correct `_文本版.md` chunks. Searching Chinese terms returns the
good Markdown chunks first, but the polluted PDF chunks still exist. Cleanup
(delete the source PDF from `s3://…/kb/BL6ZKAVWFB/` and re-sync so incremental
ingestion drops its chunks) is pending a product decision.

## Proposed fix (deferred — not scheduled)

Launchpad-side upload pre-processing, since the upstream parser cannot be
changed:

- On PDF upload, sample-extract the text layer (`pypdf`); if CJK share exceeds
  a threshold (e.g. ≥10%) and extraction quality is healthy, store the
  extracted UTF-8 Markdown in the indexed data-source prefix instead of the
  PDF, and archive the original under a non-indexed prefix (e.g.
  `kb-originals/{kb_id}/`) for provenance.
- Leave non-CJK PDFs untouched (SMART_PARSING performs well on Latin content
  and retains multimodal/table handling).
- If the text layer is absent/unhealthy (scanned PDFs), upload as-is and warn
  in the UI.
- Dependency: add `pypdf` to backend requirements.

## Related

- Spec: `.trellis/spec/launchpad/managed-kb.md` (Managed KB facts + invariants)
- Task that shipped the KB feature: `.trellis/tasks/archive/2026-07/07-13-managed-kb`
- AWS re:Post / support case: none filed yet — consider reporting the CJK
  SMART_PARSING failure to AWS with this PDF as the repro artifact.
