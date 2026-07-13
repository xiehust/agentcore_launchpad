# Managed KB management and agent attach

## Goal

Launchpad users can create and manage Amazon Bedrock **Managed Knowledge Bases**(全托管 RAG:托管向量库/embedding/重排/Smart Parsing),and mount selected KBs onto agents at create time. Mounted agents retrieve grounded knowledge through AgentCore Gateway MCP tools(`Retrieve` / `AgenticRetrieveStream`)。

## Product decisions (confirmed with river, 2026-07-13)

1. **挂载拓扑**:共享专用 gateway `launchpad-kb-gw` + per-KB `Retrieve` target(全局可见)+ **per-agent `AgenticRetrieveStream` target**,retrievers 严格绑定该 agent 所选 KB 集合(agent 的主检索工具按选择定制)。
2. **数据源 v1**:只做 S3(免凭证)。其余 5 个连接器(Web Crawler / SharePoint / Confluence / Google Drive / OneDrive)UI 占位 coming soon。
3. **管理深度 v1**:完整——数据源增删 + 同步/ingestion 状态监控 + 检索 Playground。
4. **流程**:Trellis 任务 + 独立 git worktree 实施。

## Requirements

### R1 — KB 管理页(新顶层导航 "Knowledge Bases")
- 列表:名称、状态、数据源数、最近同步状态/时间、被哪些 agent 挂载(数量,可展开)。
- 创建(`?view=` 子页模式,对齐 Registry):名称、描述(描述会用于 agent 引导,创建时提示用户写清"何时查这个库")。
- S3 数据源两种来源:
  - **上传文件**(主路径):文件上传到 artifacts 桶 `kb/{kb-slug}/` 前缀下,自动配置为数据源。
  - **已有 S3 位置**(高级):填 bucket + 可选 prefix;KB 服务角色按 KB 粒度动态授权读取该桶。
- 创建后自动:等数据源 AVAILABLE(异步 2–5 分钟)→ 自动触发首次 ingestion → 列表/详情可见进度。

### R2 — KB 详情页(`?view=` 子页)
- 概览:状态、KB ID/ARN、描述(可编辑)。
- 数据源:列表 + 新增/删除 + 手动 Sync now + ingestion job 历史(状态、文档统计、失败原因)。
- **检索 Playground**:输入查询 → 展示 chunks(文本、score、来源 S3 URI、metadata),可调 numberOfResults;用于建完 KB 立即验证数据质量。
- 关联 agents 列表(从 agent spec 反查)。

### R3 — 删除保护
- 有 agent 挂载时删除需二次确认并明确列出受影响 agent;删除时先清理该 KB 的 gateway target,再删 KB(含其数据源)。

### R4 — Create Agent 向导 "Knowledge" 区块
- **仅 harness 方法启用**(container/zip/studio 置灰 + coming soon 提示,与现有 "Gateway tools coming soon" 语义一致;决策 2026-07-13:container 现状不支持 gateway 工具,不为 v1 新造鉴权通道)。后端同样校验:非 harness 的 spec 带 `knowledge_bases` 时 400。
- 与 MCP/Skills picker 并列;多选 KB(仅 ACTIVE 且 type=MANAGED 的 KB 可选),每项显示名称+描述。
- 选择写入 AgentSpec(`knowledge_bases`),发布时:
  - 确保 per-KB `Retrieve` target 存在且 READY;
  - 创建/更新该 agent 的 `AgenticRetrieveStream` target(retrievers = 所选 KB);
  - agent 挂载 `launchpad-kb-gw`(harness 走 gateway attach;container 走 MCP servers 注入);
  - 系统提示词注入所选 KB 的名称/描述与用法引导。

### R5 — Agent 详情 & 生命周期
- Agent 详情页显示挂载的 KB;编辑改选后 re-publish 生效(per-agent target 的 retrievers 同步更新)。
- 删除 agent 时清理其 per-agent KB target。

### R6 — IAM 自动化
- Gateway 执行角色获得 `bedrock:GetKnowledgeBase`、`bedrock:Retrieve`(knowledge-base/*)、`bedrock:AgenticRetrieveStream`(*)。
- KB 服务角色(CreateKnowledgeBase 必填 roleArn)由基建提供,S3 读权限按 KB 动态收敛(inline policy per KB,镜像 `launchpad-fs-{agent}` 模式)。

## Constraints

- Region:us-west-2(实施前先验证 Managed KB 在该区可用)。
- boto3/botocore 1.43.44 已支持全部所需 shape(已本地验证)。
- Managed KB 事实:CreateDataSource 异步(CREATING→AVAILABLE 2–5 min,期间不能 StartIngestionJob);gateway target 创建后异步校验约 30s,需 poll 至 READY,FAILED 时展示 reason。
- Connector target 仅支持 `GATEWAY_IAM_ROLE` 凭证。
- KB 不进 Registry record 体系(descriptorType 无 KB 类型);注意 `ensure_default_records` 不得把 kb-gateway 的 target 注册成 MCP record。
- v1 不做:userContext/ACL 过滤、metadata filter UI(Playground 可留 numberOfResults 即可)、自定义 embedding 模型(用 MANAGED)、guardrail 配置、其余 5 个连接器。

## Acceptance Criteria

- [ ] 在 Knowledge Bases 页创建 KB(上传 ≥2 个文档),页面能观察到:数据源 AVAILABLE → ingestion 完成;Playground 查询返回相关 chunks(含 score 与 S3 来源)。
- [ ] Create Agent 勾选该 KB 并发布成功后:`launchpad-kb-gw` 上存在 per-KB `Retrieve` target 和该 agent 的 `AgenticRetrieveStream` target(retrievers 只含所选 KB),均 READY。
- [ ] 与该 agent 对话,提问文档内知识,agent 调用 KB 检索工具并给出有依据的回答(observability 可见工具调用)。
- [ ] 未勾选 KB 的 agent 不挂 kb-gateway,行为与现状一致(回归)。
- [ ] Agent 编辑改选 KB 后 re-publish,per-agent target retrievers 随之更新;删除 agent 后其 target 被清理。
- [ ] 删除被挂载的 KB 时出现保护提示;确认删除后 target 与 KB 均清理干净。
- [ ] harness 方式支持挂载;container/zip/studio 在向导中 KB 区块置灰并提示 coming soon,后端拒绝非 harness spec 携带 KB(不静默失败)。
- [ ] 列表/picker 只显示 type=MANAGED 的 KB(账号里既有 VECTOR 型 KB 不得混入——connector 只支持 Managed KB)。
