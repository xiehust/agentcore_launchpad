# Research — AWS Registry API 约束 & 现有代码地图（2026-07-11 核实）

## A. AWS API 事实（来源：backend/.venv botocore 模型 + 官方文档）

### CreateRegistryRecord（bedrock-agentcore-control）
- `descriptorType` enum：`MCP | A2A | CUSTOM | AGENT_SKILLS`。
- AGENT_SKILLS 描述符：
  - `descriptors.agentSkills.skillMd.inlineContent` — **必填**，max **102,400** 字符。
  - `descriptors.agentSkills.skillDefinition.{schemaVersion, inlineContent}` — 选填，max 102,400。
- `synchronizationType: 'URL'` + `fromUrl.{url, credentialProviderConfigurations}`（OAUTH/IAM）
  在 shape 中存在，**但官方文档（registry-create-manage-records.html）明确：同步只支持 MCP 和
  Agent(A2A) 记录类型，Agent Skills / Custom 必须走 Manual**。→ skill 的 zip/git/url 来源
  只能在 Launchpad 层实现。
- `UpdateRegistryRecord` 支持改 descriptors / recordVersion，并有 `triggerSynchronization`
  （对 skills 无用）。update 会产生记录新 revision。
- 记录状态机：`CREATING → DRAFT → PENDING_APPROVAL → APPROVED/REJECTED → DEPRECATED(终态)`，
  另有 `CREATE_FAILED / UPDATE_FAILED`（statusReason 携带原因）。
- 数据面（bedrock-agentcore）有 `SearchRegistryRecords` 供消费方搜索。

## B. 现有代码地图（探索代理核实，file:line 为 2026-07-11 快照）

### 前端
- `frontend/src/pages/Registry.tsx`（546 行，单文件）：
  - 注册抽屉表单 `:374`；skill 分支仅 name/desc + `<textarea id="reg-md">`（`:424-434`）。
  - `submitRegistration:145` → `POST /api/registry/records`
    `{type:"AGENT_SKILLS", name, description, skill_md}`。
  - name 校验正则 `^[a-z][a-z0-9-]{2,63}$`（`:141-143`）。
  - 详情 `descriptorExcerpt:36`；`openInWizard:208` 解析 `skillDefinition.inlineContent.path`。
- Studio 侧引用：`studio/PropertyPanel.tsx:86-192`（attachables 选择器）、
  `studio/SampleGallery.tsx:52-90`（approveSkill 也走同一 inline POST）。

### 后端
- `backend/app/routers/registry.py`：
  - `RegisterRequest:62-70` — `skill_md ≤ 200000` 字符（**bug：超 AWS 102400 上限**）。
  - `register_record:73` → `console.register_skill`。
- `backend/app/services/registry_console.py`：
  - `register_skill:275-306` — 单文件 `put_object` 到 `skills/{name}/SKILL.md`；
    `definition.files` **硬编码 `["SKILL.md"]`**（`:291-297`）；`_parse_frontmatter:290`。
  - `upload_skill_bundle:59-84` — **多文件上传范式**（rglob → upload_file → 真实 files 列表），
    目前只给 samples 用，producer 改造直接模仿它。
  - `_require_new_name:246`（409）；`attachable_records:193`（APPROVED → skills 目录）。
- `backend/app/services/agentcore/registry.py`：
  - `build_skills_descriptors:83-94`（skillMd + skillDefinition JSON）。
  - `upsert_record:111`（create/update 双分支已备）；lifecycle helpers（submit/approve/...）。
- 消费端（零改动即支持多文件）：`backend/app/deployer/zip_runtime.py`
  - `_download_skill_prefix:129-162` — 按 S3 前缀整体下载，50MB 上限（`_SKILL_BUNDLE_MAX_BYTES:99`）、
    路径穿越防护（`:156`）。
  - `bundle_skills_into:185-236` — 打进部署包；studio local-debug 经 `local_exec.py:113` 复用。

### 基础设施空缺
- 后端**没有任何 multipart/UploadFile 端点**；**没有任何 git clone 基础设施**——均需新建。
- registry 记录不入本地 DB，全部 boto3 实时读 AWS；skill 文件真身在
  `s3://{artifacts_bucket}/skills/{name}/`。

## C. 设计推论（写入 design.md 的依据）

1. 所有来源收敛为 `SkillBundle` + 单一「校验→S3→建记录」管道；inline 变成管道的一个 acquirer。
2. 消费端已按前缀整体下载 → 多文件 skill 部署侧零改动，仅 producer 侧要改。
3. `files` 硬编码与 200k 口子是本任务顺带修复的两个既有缺陷。
4. staging（inspect→import 两步）是 git monorepo 多 skill 勾选的必需交互，zip/url 复用同一模型。
