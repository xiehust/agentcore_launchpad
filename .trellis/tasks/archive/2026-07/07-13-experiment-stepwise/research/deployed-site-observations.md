# Deployed agentxray Live console — first-hand observations (2026-07-13)

Source: https://d3qnw1rhjyi9ke.cloudfront.net/ (password-gated), Live AWS mode,
优化实验 (Experiments) section. Verified two experiments: one at stage
`abtest` (name "3"), one at `done` (name "2"). Screenshots captured during the
session: /tmp/xray-exp-1.png … /tmp/xray-exp-4.png (viewport captures; regenerate
from the site if needed later).

## Page anatomy (experiment detail)

Vertical stack of stage cards, all prior stages remain visible with results;
the ACTIVE stage card has an orange left border + orange primary action button.
Cards observed:

1. **Header card** — eyebrow `优化`, title = experiment name, stage Badge
   (e.g. `A/B 测试` amber, `完成` green), `← 返回` back button, and a mono
   fact row: agent name, runtime ARN, `gw: …`, `ab: …` ids as they appear.

2. **`1 · AI 推荐` (推荐)** — hint: "推荐基于该 Agent 近期的 CloudWatch
   trace — 请先在评估运行页对它跑一次评估。" Two buttons: `推荐 System
   Prompt`, `推荐工具描述`. Result: side-by-side panels 当前 vs 推荐, the
   recommended panel outlined green with a `CHANGED` tag in the corner.
   (While active, editable textareas + Accept button follow — from code; the
   observed experiments were past this stage so only the diff remained.)

3. **`2 · 配置 Bundle`** — hint about `BedrockAgentCoreContext.
   get_config_bundle()`. Result: CONTROL(当前配置) vs TREATMENT(接受的推荐)
   side-by-side (treatment green + CHANGED), then mono lines
   `control: <bundle-name> @ <uuid>` / `treatment: <bundle-name> @ <uuid>`.

4. **`3 · 网关 + 配置 Bundle A/B(50/50)`** —
   - Not-yet-run: single orange button `创建网关 + 在线评估 + A/B 测试`.
   - After creation: mono fact line `gw <id> · target <name> · A/B <id>`,
     then **通过网关发送流量**: a dataset `<select>` listing every eval
     dataset with item counts ("HR 金丝雀提示词(中文样例) (10 条)" …) —
     the USER PICKS which prompt set becomes traffic — and a `发送流量`
     button; separate `监控结果` button with note "最后一个会话后聚合约需
     10–15 分钟;每 30 秒轮询(上限 25 分钟)。"
   - Results: grouped bar chart (C 对照 grey vs T1 实验 orange) per metric
     (Builtin.GoalSuccessRate, Builtin.Helpfulness) with y 0–1 values printed;
     one row per metric: `Builtin.GoalSuccessRate  -14.3%  p = 0.674  n = 5/14`
     + right-aligned badge `not significant` (amber dot pill).
   - Verdict note (red border): "T1 在任一指标上都没有胜过对照组（…）。建议积
     累更多会话后再决定是否提升。差异不具有统计显著性。"
   - **提升** sub-section: orange button `将 Treatment 提升为 Control Bundle`
     — promote is OFFERED EVEN when not significant (user's call; verdict is
     advisory). [Launchpad currently also allows promote; keep semantics.]

5. **`4 · 目标路由金丝雀(可选)`** — label `挑战者 AGENT(已部署)` dropdown;
   empty state when no other deployed agent exists: "没有其他已部署 Agent —
   请先在 Agents 页部署 HR v2 样例(或你自己的)。" (canary is explicitly
   optional).

6. **`实验完成`** (cyan accent) — "结束后请清理网关、A/B 测试、Bundle 和在线
   评估资源。"

## Deltas vs launchpad current experiment page worth adopting

- Traffic is user-triggered AND the user chooses the dataset/prompt set —
  launchpad hardcodes `TRAFFIC_PROMPTS` in service.py and auto-sends.
- Monitoring/aggregation is its own user action with a stated polling
  contract (30s interval / 25min cap) instead of an invisible background wait.
- Per-metric significance rows with explicit `p = …`, `n = x/y`, and a
  significant/not-significant pill; advisory verdict paragraph.
- Recommendation diff panels with CHANGED marking, then editable accept step.
- Stage ids (gw/ab/bundle uuids) surfaced as mono fact rows inside each card.
- The done card explicitly reminds about cleanup.

## Login / language notes

- Whole app is behind a simple password gate (irrelevant to launchpad).
- Full zh-CN parity exists for every string observed (launchpad also ships
  en + zh-CN — new strings must land in both).
