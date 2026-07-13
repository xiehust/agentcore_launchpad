# Implement — Managed KB management and agent attach

依赖顺序执行;每步末尾有验证。在独立 git worktree(分支 `feat/managed-kb`)中实施。

## 0. 前置验证(worktree 内,开工第一步)
- [x] 验证 us-west-2 Managed KB 可用:`aws bedrock-agent create-knowledge-base --name launchpad-kb-probe --role-arn <暂用任意已有角色测 validation 错误类型> ...` 或直接用 boto3 dry-probe(预期:MANAGED type 被接受;若 region 不可用会报 ValidationException,任务需改区/停止并上报)。
- [x] `git worktree add ../agentcore_launchpad-kb feat/managed-kb`,后续全部改动在 worktree。

## 1. IAM / CDK(先行,权限生效慢)
- [x] `infra/stacks/base_stack.py`:GatewayRole 加 KB 检索三权限;新增 `launchpad-kb-role`(trust bedrock.amazonaws.com + SourceAccount;读 artifacts 桶 `kb/*`);CfnOutput `KbRoleArn`。
- [x] `services/bootstrap.py` 读取新 output 进 `settings.resources`。
- [x] 验证:`cdk diff` 审查后 `cdk deploy`;`aws iam get-role --role-name launchpad-kb-role`。

## 2. 后端:clients + KB service + router
- [x] `services/agentcore/client.py` 加 `agent_client()` / `agent_runtime_client()`。
- [x] `services/knowledge.py`(CRUD/数据源/ingestion/query/S3 上传/inline policy/attached 反查)。
- [x] `routers/knowledge.py` 全部端点 + `main.py` 注册。
- [x] 验证(真实 AWS):curl 建 KB(上传 2 个 md)→ poll 数据源 AVAILABLE → start ingestion → jobs 完成 → POST query 返回 chunks。记录时延观感(2–5min)。

## 3. 后端:kb-gateway + targets
- [x] `services/kb_gateway.py`:ensure_kb_gateway / ensure_retrieve_target / sync_agentic_target / delete 系列 + wait READY。
- [x] 确认 `registry_console.ensure_default_records` 不吸入 kb-gw target(必要时按 gateway_id 过滤)。
- [x] 验证:脚本调 ensure → `aws bedrock-agentcore-control list-gateway-targets` 两类 target READY;MCP tools/list 可见 `kb-*___Retrieve` / `agentic-*___AgenticRetrieveStream`,tools/call Retrieve 返回结果。

## 4. 发布管道集成
- [x] `schemas/agent.py` AgentSpec + KnowledgeBaseRef。
- [x] pipeline provision 钩子 `prepare_agent_kb`(harness-only);harness attach 追加 kb-gw(与 launchpad-gw attach 并存,名字区分);非 harness spec 带 KB → 后端 400(已核实 container 无 gateway 通道,决策 2026-07-13)。
- [x] generate 阶段 systemPrompt 注入 KB 段落。
- [x] agent 删除清理 agentic target;re-publish 更新 retrievers。
- [x] 验证:发布 harness agent(勾选 KB)成功且 target 就绪;发布不带 KB 的 agent 回归无影响;container spec 携带 KB 被拒。

## 5. 前端
- [x] nav + `KnowledgeBases.tsx`(列表/create/detail:数据源+同步轮询+Playground+关联 agents)。
- [x] `CreateAgent.tsx` Knowledge picker;Agent 详情展示与编辑。
- [x] 验证:vite dev(端口先确认 5173/5174)+ agent-browser 走完整 UI 流,截图关键页。

## 6. E2E 验收(对照 prd.md Acceptance Criteria 逐条)
- [x] UI 建 KB → 同步完成 → Playground 命中。
- [x] UI 创建挂 KB 的 agent → chat 提问文档知识 → 回答有据 + observability 见工具调用。
- [x] 改选 re-publish / 删 agent / 删 KB(含保护)全链路。
- [x] 回归:无 KB agent、registry attachables、既有 gateway 功能。

## 7. 收尾
- [x] 演示资源:保留 KB aurora-deck-docs(BL6ZKAVWFB,托管向量库有存储计费,不要可删)+ agent aurora-support + launchpad-kb-gw;探针(probe/aurora-e2e/plain-probe/kb-del-probe)已全部清理。
- [x] trellis-update-spec(launchpad spec 增 managed-kb.md)+ 记忆更新。
- [x] worktree 分支 e0bd3b6 → merge 回 main(b88d434);aurora-support 台账已迁入主库;归档任务。

## 回滚点
- 步骤 1 后:仅多角色/权限,无行为变化。
- 步骤 2–3 后:纯新增 API,不影响既有页面。
- 步骤 4 是唯一触碰既有发布链路的点——`knowledge_bases` 为空即零路径,回归验证在此步内完成。
