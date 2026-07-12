# Gate USE IN NEW AGENT button on APPROVED status

## Goal

用户指出：Registry 详情面板的「USE IN NEW AGENT」在记录未发布（非 APPROVED）时不应可点。
现状（Registry.tsx:506-514）：非 A2A 记录一律可点，但向导 attachables 目录仅含 APPROVED
记录（`attachable_records` APPROVED-only），DRAFT/PENDING/REJECTED/DEPRECATED 点过去
预选静默失效。

## Requirements

- 按钮保留可见但 `status !== "APPROVED"` 时 disabled + title 提示
  （复用状态机文案语义：仅 APPROVED 记录可挂载到 Agent）——可见禁用比隐藏更能
  传达审批流，与详情面板 how-it-works 文案一致。
- i18n 新键 zh-CN + en。

## Acceptance Criteria

- [x] AC1: DRAFT 记录按钮禁用带提示；APPROVED 记录可点且跳转行为不变。
- [x] AC2: tsc/lint/build 全绿；浏览器实操验证两种状态。
