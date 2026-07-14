# 洞察-这些会话 重跑确认提醒

## 背景

Evaluation 页 Insights 面板的「洞察 · 这些会话」按钮
（`frontend/src/pages/Evaluation.tsx` `insights-on-sessions-btn`）：

- 同一会话集的洞察运行**排队/进行中**时按钮已禁用（`insightsPending`）。
- 但同一会话集**已有完成的洞察结果**时（如 run-1c19b4，失败归因区已展示
  聚类），再点仍弹通用确认「将…新建一个洞察运行…排队」，没有提醒这会把
  洞察**重复再运行一遍**（重新调用评估服务、新增一条运行记录、产生用量）。

## Requirements

- 新增判断：runs 里存在 mode=insights、status=completed、且 session_ids
  集合与所选 run 相同 → 视为"已跑过洞察"。
- 已跑过时，ConfirmDialog 正文换用加强文案（zh/en 两套 locale）：明确
  说明这些会话已有洞察结果，继续会重复再运行一次并新建一条运行记录。
- 未跑过时保持现有文案不变；排队/进行中的禁用逻辑不动。

## Acceptance Criteria

- [ ] 对已有完成洞察的 run 点击按钮，确认弹窗出现"重复再运行"提醒文案
      （浏览器实测截图/快照佐证，zh-CN）。
- [ ] 对未跑过洞察的 run，弹窗仍为原文案。
- [ ] `npm run lint` / `tsc` / 相关前端测试（如有）通过。
