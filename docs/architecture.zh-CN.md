# 架构 / Architecture

AgentCore Launchpad 是覆盖在 Amazon Bedrock AgentCore 之上的一层轻量、有明确取舍
的平台。控制台中的每项能力都映射到一个真实的 AgentCore 服务和你账号里的真实资源
——平台的职责是为这些服务提供统一的 create → deploy → invoke → observe 体验,而
不是重新实现它们。

English: [architecture.md](architecture.md)

## 系统图

```
 Browser
 ┌─────────────────────────────┐        ┌──────────────────────────┐
 │ Platform console  :5173     │        │ Strands Studio UI  :5273 │
 │  Overview · Create · Chat   │        │  drag-and-drop canvas    │
 │  Registry · Governance ·    │        │  (方式C, vendored)       │
 │  Evaluation                 │        └────────────┬─────────────┘
 └──────────────┬──────────────┘            /api,/ws │  /launchpad-api
                │ /api  /v1                           │  (→ platform /api)
                ▼                                     ▼
 ┌─────────────────────────────┐        ┌──────────────────────────┐
 │ Platform backend  :8000     │◀───────│ Studio backend    :8100  │
 │  FastAPI                    │ deploy  │  FastAPI (local run,     │
 │  · deploy pipeline          │ via     │  chat, exec history)     │
 │  · invoke chain (/api,/v1)  │ pipeline└──────────────────────────┘
 │  · SQLite ledger (data/)    │
 └──────────────┬──────────────┘
                │ boto3 (bedrock-agentcore control + data planes)
                ▼
 ┌───────────────────────────────────────────────────────────────┐
 │ AWS · us-west-2                                                 │
 │  AgentCore: Runtime · Harness · Memory · Gateway · Identity ·   │
 │             Registry · Policy(Cedar) · Evaluation/Optimization  │
 │  Shared infra (CDK launchpad-base): S3 · ECR · CodeBuild ·      │
 │             Cognito · IAM exec role · HR Lambda · Facts API     │
 │  Observability: CloudWatch Transaction Search (aws/spans)       │
 └───────────────────────────────────────────────────────────────┘
```

## 四层映射(来自 prompt.md)

项目简报把 AgentCore 能力组织为四层;每一层在本仓库中都有真实、可运行的代码支撑。

| 层 | 平台入口 | AgentCore 服务 |
|---|---|---|
| **1. 构建核心(Build Core)** | Create Agent(方式A/B/C)、统一管道、Chat 记忆 | Runtime、Harness、Memory |
| **2. 构建工具(Build Tools)** | 工具目录、内置工具演示 | Gateway(REST + Lambda → MCP)、内置工具(Code Interpreter、Browser) |
| **3. 治理(Governance)** | Governance 页面、Registry 控制台、trace 面板 | Observability(Transaction Search)、Registry、Policy(Cedar) |
| **4. 评估与优化(Evaluation & Optimization)** | Evaluation 页面、Experiments | Evaluation(batch + online、LLM-judge、insights)、Optimization(config bundles、A/B、canary) |

## 平台 ↔ AgentCore 服务映射

| AgentCore 服务 | 平台如何使用 |
|---|---|
| **Runtime** | 托管 zip 与 container Agent(`CreateAgentRuntime`);调用链访问 runtime 数据面。 |
| **Harness** | 托管方式B Agent(`CreateHarness`)——托管入口,无构建产物。 |
| **Memory** | 一个共享的 `launchpad_memory` 单例:短期 session 事件 + 长期语义与用户偏好策略。Managed-harness Agent 把偏好抽取到 `/preferences/{actor}`,并在新 session 中自动检索。 |
| **Gateway** | `launchpad-gw` 把一个 REST API(office-facts)和一个 Lambda(hr-database)转成带 Cognito-JWT 鉴权的 MCP 工具;Agent 的工具调用经由它流转。 |
| **Identity** | 支撑网关的 token vault——一个 OAuth2 provider(Agent 出站鉴权)和一个 API-key provider。 |
| **Registry** | `launchpad-registry` 编目三类 descriptor:A2A(Agent)、MCP(工具)、AGENT_SKILLS(Skill)。每次部署都会自动创建并提交一条 A2A 记录。 |
| **Policy** | 以 `ENFORCE` 模式挂接到网关的 Cedar 策略引擎;deny 决策会带上作出判定的 policy id。支持 NL → Cedar 策略生成。 |
| **Evaluation** | 基于 CloudWatch trace 的真实 `StartBatchEvaluation` / insights,范围精确到某次运行产生的 session。13 个内置评估器加自定义 LLM-as-a-judge。 |
| **Optimization** | 推荐 → 配置捆绑(configuration bundles)→ 网关 A/B(config-bundle 50/50)→ target-based canary → verdict → promote → cleanup。 |
| **Observability** | CloudWatch Transaction Search(X-Ray trace segment destination → CloudWatch Logs)。trace 从 `aws/spans` 日志组读取,并渲染为按 session 的链路面板。 |
| **内置工具(Builtin Tools)** | Code Interpreter(`aws.codeinterpreter.v1`)与 Browser(`aws.browser.v1`)各有一个可运行的演示端点。 |

## 统一的五阶段部署管道

三种创建方式统一收敛到同一组有序阶段,定义在 `backend/app/deployer/pipeline.py`:

```
generate → package → provision → deploy → register
```

每种方式为每个阶段贡献一个可调用函数(或省略以跳过)。阶段进度持久化在
`Deployment` 行上,并作为 JSONL 事件镜像进 `Job` 日志,因此重启后的后端会从第一个
未成功的阶段继续(启动时执行 `resume_pending_jobs()`)。

| 阶段 | 方式B — harness | zip_runtime / 方式C — studio | 方式A — container |
|---|---|---|---|
| **generate** | 从 AgentSpec 构建 `CreateHarness` 请求 | 渲染 Strands 模板(studio:原样适配用户代码) | 组装 ARM64 构建上下文(Dockerfile + `main.py` + `.claude` 脚手架) |
| **package** | *跳过*(无产物) | `pip install` ARM64 wheels → zip → S3 | zip 上下文 → S3 → CodeBuild(docker build+push)→ ECR |
| **provision** | 复用共享执行角色 | 复用共享执行角色 | 复用共享执行角色 |
| **deploy** | `CreateHarness` + 轮询 READY | `CreateAgentRuntime` + 轮询 READY | `CreateAgentRuntime(containerConfiguration)` + 轮询 READY |
| **register** | A2A 注册记录,自动提交 | A2A 注册记录,自动提交 | A2A 注册记录,自动提交 |

典型耗时:harness ≈ 30 秒,zip ≈ 1–3 分钟(含 pip),container ≈ 2–4 分钟(实测:CodeBuild 1.7 分钟 + 数秒即 READY)
(经 CodeBuild)。见 [troubleshooting.zh-CN.md](troubleshooting.zh-CN.md)。

## 调用链

Chat 交互页面(`/api/chat/{id}`)与公开 API(`/v1/agents/{id}/invoke` +
`/invoke-stream`)共享**同一个**入口 `app.services.invoke.invoke_agent_text`
(SSE 走 `app.services.chat.chat_stream`),因此两个入口行为完全一致:

```
console /api  ─┐
               ├─▶ invoke_agent_text / chat_stream
public  /v1  ──┘        │
                        ├─ 方式分派:
                        │    harness            → harness data client
                        │    zip/studio/container → runtime data client
                        ▼
             AgentCore Runtime / Harness
                        │  (session 隔离、流式)
                        ├─ Memory        (session 上下文读写)
                        ├─ Gateway tools (基于 Cognito JWT 的 MCP)
                        ├─ Policy        (网关处的 Cedar ENFORCE)
                        └─ Observability (spans → CloudWatch Transaction Search)
```

公开 `/v1` 接口额外加了 `X-Api-Key` 鉴权(密钥以 sha256 哈希存储);分派之后的
一切与控制台路径完全相同。

## SQLite 台账与 job/event 模型

廉价且本地的状态存放在 `data/launchpad.db` 的 SQLite 台账中
(`backend/app/models/ledger.py` 加评估/优化模型):

| 表 | 内容 |
|---|---|
| `agents` | Agent 记录——name、method、status、ARN、resource id、registry record id、version、spec |
| `deployments` | 每次部署一行——五阶段数组,含各阶段 status/detail/时间戳 |
| `jobs` | 异步工作(type `deploy_agent`)——status + 阶段事件的 JSONL `log` |
| `chat_sessions` | Chat 交互 session——轮次、actor、最近活跃时间 |
| `api_keys` | 公开 API 密钥——sha256 哈希 + 前缀(从不存明文) |
| `policy_decisions` | 治理决策日志——principal、tool、ALLOW/DENY、原因 |
| `eval_datasets` / `eval_runs` | 评估数据集与运行状态(分数或 insight 树) |
| `experiments` | 优化闭环——阶段 + 各阶段产物,可恢复 |

**Job/event 模型。** 创建 Agent 返回 `202` 并带一个 `job_id`。部署 job 在后台线程
运行,每次阶段切换向 `Job.log` 追加一条 JSONL 事件;`GET /api/jobs/{id}` 返回这些
事件,`GET /api/agents/{id}` 返回 `Deployment.stages` 数组。随 job 完成,Agent 从
`deploying → active`(或 `failed`)。权威的资源状态(runtime 状态、注册记录状态、
评估/trace 数据)始终存放在 AWS;台账只保存标识符与派生的进度。

## 本地进程拓扑

`bash scripts/dev.sh`(`make dev`)最多启动四个进程;端口可通过环境变量覆盖。

| 服务 | 端口 | 覆盖变量 |
|---|---|---|
| platform backend | 8000 | `PLATFORM_API_PORT` |
| platform frontend | 5173(被占用则自动切换) | `PLATFORM_UI_PORT` |
| studio backend | 8100 | `STUDIO_API_PORT` |
| studio frontend | 5273 | `STUDIO_UI_PORT` |

Studio 的 Launchpad 部署区块把 `/launchpad-api` 代理到平台后端的 `/api`,因此
studio 创建的 Agent 走同一条管道、台账与注册表。见
[studio-integration.md](studio-integration.md)。
