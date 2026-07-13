# Design — Managed KB management and agent attach

## Verified AWS facts (2026-07-13, docs + local botocore 1.43.44)

### KB 控制面(`bedrock-agent` client,代码里目前不存在,需新增)
```python
bedrock_agent.create_knowledge_base(
    name=..., description=..., roleArn=KB_ROLE_ARN,          # roleArn 必填
    knowledgeBaseConfiguration={
        "type": "MANAGED",                                    # enum: VECTOR|KENDRA|SQL|MANAGED
        "managedKnowledgeBaseConfiguration": {"embeddingModelType": "MANAGED"},
    })
bedrock_agent.create_data_source(                             # 异步!CREATING→AVAILABLE 2–5min
    knowledgeBaseId=kb_id, name=...,
    dataSourceConfiguration={
        "type": "MANAGED_KNOWLEDGE_BASE_CONNECTOR",
        "managedKnowledgeBaseConnectorConfiguration": {
            "connectorParameters": {                          # botocore document type(自由 JSON)
                "type": "S3", "version": "1",
                "connectionConfiguration": {"bucketName": ..., "bucketOwnerAccountId": ...},
                "filterConfiguration": {"inclusionPrefixes": ["kb/slug/"]},
            }}},
    vectorIngestionConfiguration={"parsingConfiguration": {"parsingStrategy": "SMART_PARSING"}})
# 同步:start_ingestion_job / list_ingestion_jobs / get_ingestion_job / stop_ingestion_job
```
Playground 检索:`bedrock-agent-runtime.retrieve(knowledgeBaseId, retrievalQuery={"text":...}, retrievalConfiguration=...)`(gateway 侧用的就是 `bedrock:Retrieve` 动作,数据面同一 API)。

### Gateway connector target(`bedrock-agentcore-control`,client 工厂已有)
```python
control_client().create_gateway_target(
    gatewayIdentifier=KB_GW_ID, name="kb-<slug>" | "agentic-<agent>",
    targetConfiguration={"mcp": {"connector": {
        "source": {"connectorId": "bedrock-knowledge-bases"},
        "configurations": [
            # per-KB target ─ 只放 Retrieve 条目
            {"name": "Retrieve", "parameterValues": {"knowledgeBaseId": kb_id}},
            # per-agent target ─ 只放 AgenticRetrieveStream 条目;两个字段都必填
            {"name": "AgenticRetrieveStream", "parameterValues": {
                "retrievers": [{"description": kb.desc,
                                "configuration": {"knowledgeBase": {"knowledgeBaseId": kb_id}}} ...],
                "agenticRetrieveConfiguration": {"foundationModelType": "MANAGED",
                                                  "rerankingModelType": "MANAGED"}}},
        ]}}},
    credentialProviderConfigurations=[{"credentialProviderType": "GATEWAY_IAM_ROLE"}])
```
- 异步校验约 30s(内部做 GetKnowledgeBase),poll `get_gateway_target` 至 READY;FAILED 带 reason。
- 工具名 = `<target-name>___Retrieve` / `<target-name>___AgenticRetrieveStream`。
- 挂同一 gateway 的 agent 经 tools/list 可见全部 target 工具(已知软隔离,产品已接受;per-agent agentic target 提供"专属组合工具")。

### IAM
- Gateway 执行角色(`launchpad-gateway-role`,CDK `base_stack.py:361`)新增:
  `bedrock:GetKnowledgeBase` + `bedrock:Retrieve` → `arn:aws:bedrock:us-west-2:434444145045:knowledge-base/*`;`bedrock:AgenticRetrieveStream` → `*`(该动作不支持资源级)。
- 新增 KB 服务角色 `launchpad-kb-role`(CDK):trust `bedrock.amazonaws.com`(SourceAccount 条件);基础授权读 artifacts 桶 `kb/*`;
  用户指定外部桶时,后端对该角色 `put_role_policy` 挂 `launchpad-kb-{kbId}` inline policy(镜像 `deployer/container.py:164` 的 `launchpad-fs-{agent}` 模式),删 KB 时清理。

## 架构

### 后端(新文件,模式对齐 registry:thin router → service → AWS wrapper)
- `backend/app/services/agentcore/client.py`:新增 `agent_client()`(bedrock-agent)、`agent_runtime_client()`(bedrock-agent-runtime),lru_cache 同现有。
- `backend/app/services/knowledge.py`:KB service——CRUD、数据源、ingestion、playground query、S3 上传(reuse boto3 s3,前缀 `kb/{slug}/`)、inline policy 管理、attached-agents 反查(扫 Agent 表 spec)。
- `backend/app/services/kb_gateway.py`:kb-gateway bootstrap + target 管理——`ensure_kb_gateway()`(mirror `gateway_bootstrap.ensure_gateway`,name `launchpad-kb-gw`,复用 Cognito CUSTOM_JWT authorizer 与 `launchpad-gateway-role`)、`ensure_retrieve_target(kb)`、`sync_agentic_target(agent, kb_ids)`(create/update/delete)、`_wait_target_ready`(mirror `gateway_bootstrap.py:229`)、`delete_kb_targets(kb_id)`。
- `backend/app/routers/knowledge.py`:`/api/knowledge-bases` — GET list(合并 status/数据源数/attached agents)、POST create(multipart 或 JSON:上传文件 or 外部 S3)、GET/{id}(detail:sources+ingestion jobs)、PATCH/{id}(描述)、DELETE/{id}(?force)、POST/{id}/data-sources、DELETE data-source、POST/{id}/data-sources/{dsId}/sync、GET/{id}/ingestion-jobs、POST/{id}/query(playground)。注册进 `main.py`。
- kb-gateway 的 id/url 存 `settings.resources`(和 launchpad-gw 一致的持久化通道),懒初始化:第一次需要时 ensure。

### AgentSpec 与发布管道
- `backend/app/schemas/agent.py` AgentSpec 新增 `knowledge_bases: list[KnowledgeBaseRef] = []`,`KnowledgeBaseRef{kb_id, name, description}`(name/description 冗余存储,用于 prompt 注入与展示,不回查 AWS)。
- `deployer/pipeline.py` provision 阶段(各 method 共用入口处)调用 `kb_gateway.prepare_agent_kb(agent, spec)`:ensure per-KB targets → sync per-agent agentic target → 返回 kb-gw 连接信息;deploy 阶段各 method 消费:
  - **harness**(`deployer/harness.py:build_create_params`):按现有 `agentcore_gateway` attach 形态(`harness.py:62-80` OAuth CLIENT_CREDENTIALS)追加 kb-gw;注意与用户显式选择的 launchpad-gw attach 去重。
  - **container/zip/studio**:v1 不支持(已核实:container 生成代码的 MCP 仅无鉴权 http,gateway 工具本就是 harness-only "coming soon";决策 2026-07-13)。向导置灰 KB 区块;后端在 create/update agent 入口校验非 harness spec 的 `knowledge_bases` 非空即 400。
- 系统提示词注入:generate 阶段在 instructions 末尾追加 "Knowledge bases available" 段落——每个 KB 的名称+描述、工具命名说明(`agentic-{agent}___AgenticRetrieveStream` 为首选组合检索,`kb-{slug}___Retrieve` 为单库精查)。
- 删除 agent(`deployer/container.py:delete_agent_resources` 及各 method 对应清理处)追加 `kb_gateway.delete_agentic_target(agent)`。

### 前端
- `frontend/src/layout/nav.ts` 新增 "Knowledge Bases"。
- `frontend/src/pages/KnowledgeBases.tsx`:列表 + `?view=create`(创建向导:基本信息 → S3 数据源[上传 tab | 已有 S3 tab] → 提交)+ `?view=detail&kb={id}`(概览 / 数据源+同步监控[轮询 ingestion job] / Playground / 关联 agents)。样式与交互对齐 `Registry.tsx` 与其子页。
- `frontend/src/pages/CreateAgent.tsx`:attachables 区新增 "Knowledge" picker(数据来自 `GET /api/knowledge-bases?status=ACTIVE`),选择写入 `spec.knowledge_bases`;方法为 zip/studio 时禁用并提示。
- Agent 详情页:挂载 KB 只读展示 + 编辑流(复用现有 edit→re-publish 通道)。

## 数据流(发布含 KB 的 agent)

```
CreateAgent 勾选 KB → POST /api/agents (spec.knowledge_bases)
→ pipeline.provision: ensure launchpad-kb-gw → ensure kb-{slug} Retrieve targets(READY)
   → create/update agentic-{agent} target(retrievers=所选)→ poll READY
→ pipeline.deploy: harness attach kb-gw / container 注入 MCP_SERVERS + token 流
→ generate: instructions 注入 KB 引导
→ agent 运行时 tools/list 发现 KB 工具 → tools/call → gateway 以 launchpad-gateway-role
   调 bedrock:Retrieve / AgenticRetrieveStream → 返回 chunks / 带引用合成答案
```

## 取舍与备注

- **KB 目录不进 Registry**:registry descriptorType 仅 MCP/AGENT_SKILLS/A2A;KB 有独立 API + 页面。需确认 `registry_console.ensure_default_records`(`:102-141`)按 gateway_id 过滤,不把 kb-gw target 自动注册为 MCP record。
- **软隔离说明**:挂 kb-gw 的 agent 可见所有 per-KB Retrieve 工具与他人 agentic target 工具;硬隔离(per-agent gateway)明确不做(产品决策)。system prompt 注入负责引导。
- **target 命名**:`kb-{slug}`(slug 取 KB 名 sanitize + kb_id 后缀防撞)、`agentic-{agent_name}`;长度/字符集按 create_gateway_target 校验规则截断。
- **失败面**:target FAILED reason 透传到发布 stage 错误;CreateDataSource 未 AVAILABLE 时 Sync 按钮禁用并显示状态;Playground 对 ingestion 未完成给空态提示。
- **回滚**:功能为纯增量(新路由/新页面/AgentSpec 可选字段);发布管道对 `knowledge_bases=[]` 走零改动路径。CDK 只增权限与新角色,可安全回滚。
