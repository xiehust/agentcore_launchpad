# front-desk 下游 session id 派生修复

## 背景

`backend/samples/frontdesk_agent/main.py` 的 `call_agent` 每次调用都用
`uuid.uuid4().hex + uuid.uuid4().hex[:8]` 生成全新随机 `runtimeSessionId`
（main.py:121）。后果（trace `6a55886c53483d4a4cca216647c57479` 中已实证）：

1. 下游 harness（如 aurora-support）每次都冷启动会话：2× ListEvents 查空 +
   2× CreateEvent 新建 session/agent 状态，纯开销。
2. 同一个 front-desk 会话内两次路由到同一专家时，专家的短期记忆完全丢失。
3. Memory 里的事件存在随机 session id 下，无法从 front-desk 的会话 id
   反查（observability 关联对不上号）。

## Requirements

- `call_agent` 的下游 session id 改为从 front-desk 自身请求的
  `context.session_id` 稳定派生（同一 front-desk 会话 + 同一目标 agent →
  同一下游 session id）：`sha256(f"{fd_session}:{agent_name}").hexdigest()`。
- front-desk 无 session id 时（adhoc 调用）保持随机 fallback。
- 派生结果需满足 runtimeSessionId 约束（≥16 位，字母数字），sha256 hex
  64 位满足。
- 不同目标 agent 派生出不同 session id（含 agent 名区分）。
- actor_id 透传不在本任务范围（单独跟进）。

## Acceptance Criteria

- [ ] 离线单测：派生函数对 (session, agent) 稳定、对不同 agent 不同、
      无 session 时 fallback 随机且长度合法；现有 frontdesk 测试全绿。
- [ ] 重新部署 front-desk agent（scripts/deploy_frontdesk_agent.py）后，
      用同一 runtimeSessionId 连续两次经 front-desk 路由到同一专家，
      在 AgentCore Memory 中该派生 session id 下能看到两轮事件累积
      （第二轮 harness 恢复了第一轮历史）。
