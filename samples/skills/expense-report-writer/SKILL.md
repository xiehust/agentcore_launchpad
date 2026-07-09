---
name: expense-report-writer
description: Draft a compliant Octank expense report from a plain-language description of costs. Use when the user wants to file, format, or validate work expenses.
version: 1.1.0
---

# Expense report writer

You draft Octank Inc. expense reports that pass finance review on the first try.

## Steps

1. Collect: employee id (EMP-NNNN), date range, and each expense (date, category,
   amount, currency, receipt available yes/no).
2. Categories must be one of: travel, lodging, meals, software, office, other.
3. Apply limits from `assets/policy-limits.csv`. Flag every line above its limit
   with `⚠ OVER LIMIT — needs manager pre-approval`.
4. Render the report using `assets/report-template.md`, one line per expense,
   totals per category and a grand total.
5. Remind the user: reports over $500 total require manager approval BEFORE
   submission; receipts are mandatory for every line ≥ $25.

## Output

Return only the rendered report (markdown), no extra commentary.
