请从零构建一个名为 **AgentCore Launchpad** 的生产级 Enterprise Agent Platform。这是一个交付给客户的 **sample asset**——不是演示 demo,而是把 Amazon Bedrock AgentCore 各核心组件能力真正落地、可直接运行在客户 AWS 账号里的完整样板项目。目标有两个:一是让用户能在平台上**自助创建 Agent 并一键部署到 AgentCore Runtime**,二是让 AgentCore 的构建、工具、治理、评估各组件都真实接入、端到端跑通。要求:代码是生产质量(而非示意代码),所有 AgentCore 能力走真实 API、真实资源;结构清晰、每个组件独立可用、可被客户直接采用或二次开发。

## 一、核心能力:用户自助创建并部署 Agent

平台要提供一个统一的入口,让用户选择不同方式创建 Agent,最终都部署到 AgentCore Runtime 托管运行:

- **方式 A — Claude Agent SDK**:用户基于 Claude Agent SDK 定义 Agent(system prompt、工具、subagent、MCP 集成),平台负责打包并部署到 AgentCore Runtime。
- **方式 B — AgentCore Harness**:用户用 AgentCore 原生 harness 方式定义 Agent 入口(如 `@app.entrypoint` / BedrockAgentCoreApp),平台负责容器化并部署到 Runtime。
- **方式 C — Strands Studio UI 可视化编排**:集成 [Open Studio for Strands Agent](https://github.com/xiehust/strands_studio_ui)——一个 React + FastAPI 的可视化拖拽编排工具,用户通过 node-based 编辑器构建 Strands Agent 工作流(单 Agent / 多 Agent 层级 / Graph / Swarm),自动生成 Python 代码,再一键部署到 AgentCore。

三种方式统一收敛到同一个部署流程:**生成 Agent 代码 → 打包依赖 → 通过 IaC(CloudFormation/CDK)创建资源 → 部署到 AgentCore Runtime → 返回 Agent ARN 供调用**。平台要屏蔽三种方式的部署差异,对外提供一致的"创建 → 部署 → 调用 → 观测"体验。

## 二、核心能力:Skills / Agents / MCP 工具注册管理界面

平台要提供一个统一的**资产管理控制台(Web UI)**,让用户可视化地注册、编目、发现和管理三类核心资产。这一层底层与 AgentCore Registry 打通,作为 Registry 的可视化操作界面。

- **Agents 管理**:列出平台上已创建 / 已部署的 Agent,展示元数据(创建方式、Runtime ARN、状态、版本、owner),支持注册进 Registry、查看详情、发起调用、下线。
- **MCP 工具管理**:注册和编目 MCP 工具(含通过 Gateway 由 REST API / Lambda 转换而来的工具),展示每个工具的 schema、来源、鉴权要求,支持在 Agent 创建时被选用。
- **Skills 管理**:注册和管理可复用的 Skill(可被 Agent 组合调用的能力单元),展示 Skill 的定义、输入输出、依赖的工具/模型,支持版本化。
- **统一能力**:三类资产都支持注册 / 检索 / 版本管理 / 详情查看 / 启用停用;界面体现"发现层"定位——从这里可以发现有哪些可复用的 Agent、工具、Skill,并在创建新 Agent 时直接引用。

## 三、核心能力:Chat 交互页面与 API 直接调用

Agent 部署到 Runtime 后,平台要提供两种消费入口——一个面向人,一个面向系统集成:

- **Chat 交互页面**:一个 Web 聊天界面,用户选中任意已部署的 Agent 即可直接对话。要支持流式响应(streaming)、多轮对话历史、session 上下文保持(对接 AgentCore Memory),并在界面上可视化本次调用命中的工具、记忆读写、以及 trace 链路,便于日常使用和排障。
- **API 直接调用能力**:每个已部署 Agent 对外暴露标准调用接口(如 REST / HTTP endpoint),支持同步与流式调用、鉴权(API Key / IAM)、以及在请求中透传 session 标识。提供 API 文档(OpenAPI)和 curl / SDK 调用示例,让 Agent 可被外部系统直接集成。
- **两个入口共享同一后端**:Chat 页面本质上是 API 的一个前端消费者,二者走同一套调用链路(Runtime 调用 → Memory → Gateway 工具 → Policy 校验 → Observability 记录),保证行为一致、便于对照验证。

## 四、平台要展示的 AgentCore 组件

在上面自助创建能力的基础上,按四层组织,每一层至少有一个可运行的示例:

**1. 构建核心(Build Core)**
- 支持上述三种方式创建 Agent(Claude Agent SDK / AgentCore Harness / Strands Studio UI)。
- 集成 AgentCore Runtime:把 Agent 部署为托管的 serverless runtime,展示 session 隔离与调用。
- 集成 AgentCore Memory:展示短期记忆(单 session 上下文)与长期记忆(跨 session 用户偏好)的读写。

**2. 构建工具(Build Tools)**
- AgentCore Gateway:把至少一个 REST API 和一个 Lambda 转换成 Agent 可调用的 MCP 工具,展示协议转换与鉴权透传。
- AgentCore Builtin Tools:调用内置的 Code Interpreter(执行代码)和 Browser Tool(网页操作)各一个示例。
- AgentCore Payments:用 PaymentManager 真实接入一次 Agent 自主支付流程,默认走支付提供方的 sandbox / 测试环境(真实 API、测试资金,不动真实资金),授权、幂等、对账链路都真实打通。

**3. 治理(Governance)**
- AgentCore Observability:开启 trace / metric / log,展示端到端调用链(用户 → Agent → 工具 → 模型),并接入 CloudWatch。
- AgentCore Registry:作为上面 Skills/Agents/MCP 工具管理界面的后端,把创建的 Agent、MCP 工具、Skill 注册进 Registry,展示发现与编目。
- AgentCore Policy:用 Cedar 写一条细粒度工具访问策略(如"只有特定角色可调用 Payments 工具"),通过 Gateway 拦截生效,展示 Allow/Deny 评估。

**4. 评估与优化(Evaluation & Optimization)**
- AgentCore Evaluation:对创建的 Agent 定义一组评估用例,跑一次自动化评测(batch + online、LLM-as-a-judge),输出准确性 / 工具调用正确率等指标;并支持 Insights 失败归因(failure analysis → 分类/子类/根因 + 建议修复、用户意图聚类、执行模式分析)。
- AgentCore Optimization:基于评估与 traces,给出 system prompt 与 tool description 的 AI 优化建议 → 生成 control/treatment 的 Configuration Bundles → 通过 Gateway 做 A/B(config-bundle 50/50)与 target-based canary(90/10 渐进放量)→ 显著性判定与 verdict → promote 晋级 → cleanup 清理。
- **参考实现**:这一层可直接参考并复用 [agentcore_eva_opt](https://github.com/xiehust/agentcore_eva_opt)(Lab 4 — Agent Optimization 的交互式重建,React 18 + Vite 前端 / FastAPI + boto3 后端)。它有两种模式:**Simulation**(10 步向导,无需 AWS 凭证、零成本、全部为模拟数据,适合讲解流程)和 **Live AWS**(通用的 agent 评估控制台,发真实 bedrock-agentcore 调用:上传/编辑 agent 代码、管理评估数据集与 evaluators、部署真实 runtime、跑真实 batch evaluation)。控制台分七个区:Agents / Datasets / Evaluators(13 个内置 + 自定义 LLM-judge)/ Runs / Insights / Experiments / Cleanup。它还支持评估**外部 agent**(只要 OTEL traces 落到 CloudWatch,不限于 AgentCore Runtime,Lambda/EKS/本地皆可)。把它作为 Launchpad 评估与优化层的实现基础,与平台的 Agent 创建/部署、Registry、Observability 打通。**作为 sample asset,评估优化层以 Live AWS 真实模式为主**(真实 batch/online evaluation、真实 A/B 与 canary),Simulation 模式仅作为无凭证快速上手的辅助入口保留。