# Registry register/edit as standalone sub-pages (Evaluation-style)

## Goal

Registry 页（`/registry`）当前的「+ 注册」是列表旁的内嵌抽屉表单，空间局促（git 多选列表
尤其挤）；且 Registry 没有「编辑」能力。本任务：

1. 把**新建注册**改为独立子页面 `?view=register`，布局仿 Evaluation 页的
   `?view=new`（ViewHead + 返回按钮 + `eval-grid` Panel 栅格）；
2. **新增记录编辑**能力：独立子页面 `?view=edit&record=<id>`，支持描述 + 内容全量编辑
   （用户已确认选全量编辑），后端新增 `PUT /api/registry/records/{id}`。

## Background / Constraints

- Evaluation 页已有成熟的子页面模式（`frontend/src/pages/Evaluation.tsx:159-354`）：
  `useSearchParams` 读 `?view=`，早退渲染子页组件，`onBack=() => setSearchParams({}, {replace:true})`；
  子页 = `<section>` + `ViewHead(kicker/title/meta)` + 返回 `Btn` + `eval-grid` 内多个 `Panel`。
- 注册表单主体（类型选择 + MCP 字段 + `SkillSourceForm` 四来源）已在上个任务组件化
  （`pages/registry/SkillSourceForm.tsx` + `GitSourcePanel.tsx`），迁移成本低。
- AWS 侧 `UpdateRegistryRecord` 已有 wrapper（`upsert_record` update 分支 +
  `wrap_descriptors_for_update` + `record_version` 参数，reimport 在用）。
- 技能 bundle 真身在 `s3://{bucket}/skills/{name}/`；**记录名与 S3 前缀键绑定 → 编辑不改名**
  （与 Agent 管理 redeploy 的 name-immutable 模式一致）。
- 契约细节以 `.trellis/spec/launchpad/registry-skill-ingestion.md` 为准（inspect→import
  staging、错误矩阵、caps）。

## Requirements

### R1 — 注册子页面 `?view=register`（P0）
- 列表页「+ 注册」按钮改为跳转 `?view=register`（内嵌抽屉删除）。
- 子页布局仿 Evaluation `?view=new`：左 Panel 为注册表单（记录类型 MCP/AGENT_SKILLS +
  现有四来源技能表单），右 Panel 为流程说明（DRAFT→提交→批准 状态机、技能上传去向、上限）。
- 注册成功：toast + 返回列表页并选中新记录（git 批量导入多条时选中第一条，全部成功才返回）。
- 现有行为不回归：四种来源全部可用；`SampleGallery.approveSkill` 直连 API 不受影响；
  浏览器返回键能从子页回到列表。

### R2 — 编辑子页面 `?view=edit&record=<id>`（P1）
- 详情面板新增「编辑」按钮（DEPRECATED 记录不显示）→ 跳转编辑子页。
- 可编辑内容：
  - 公共：description；**name 不可改**（显示为只读并注明原因）。
  - MCP 记录：server URL（重建 descriptors）。
  - AGENT_SKILLS 记录：
    a) SKILL.md 内容内联编辑（textarea 预填当前内容）——多文件 bundle 只替换 SKILL.md、
       保留其余支撑文件；
    b) 或重新上传 zip **整体替换** bundle（走现有 inspect 预览，确认后随保存提交）。
- 保存 → `PUT /api/registry/records/{id}` → toast + 返回列表并选中该记录。
- A2A 记录不提供编辑（由 agent 部署管理）；DEPRECATED 记录 400。

### R3 — 后端 `PUT /api/registry/records/{record_id}`（P1）
- 请求体（字段全部可选，至少一个）：`{description?, url?, skill_md?, staging_id?+index?}`
  - `url` 仅 MCP；`skill_md` / `staging_id` 仅 AGENT_SKILLS，二者互斥。
- 语义：读取现有记录 → 按类型改写 descriptors → `upsert_record` update 分支。
  内容变更（url/skill_md/bundle）时 `recordVersion` minor bump（复用 `_bump_minor`）；
  仅 description 不 bump。
- 技能内容语义：`skill_md` → 覆写 S3 该前缀下的 SKILL.md（其余文件保留），descriptor
  的 skillMd 与 definition 同步更新；`staging_id` → 清旧前缀→上传新 bundle
  （复用 reimport 的 `_reupload_and_update` 机制），definition.files 换成新列表，
  `source` 置为新 bundle 的来源。
- 校验沿用共享 caps（SKILL.md ≤100KB 等）与错误矩阵；DEPRECATED → 400；
  类型与字段不匹配 → 400。

## Out of Scope

- 记录改名、A2A 记录编辑、审批流变更。
- MCP 记录的 URL 同步触发（`triggerSynchronization`）——现有行为不动。
- Evaluation 页自身的任何改动。

## Acceptance Criteria

- [x] AC1: 列表页点「+ 注册」进入 `?view=register` 子页（ViewHead + 返回按钮 + Panel 栅格），
      四种来源（inline/zip/git/url）在子页内全部注册成功，成功后回列表并选中新记录。
- [x] AC2: 浏览器返回键从注册子页回到列表；`?view=register` 直链可用。
- [x] AC3: 技能记录详情点「编辑」进入 `?view=edit&record=<id>`；修改 description 保存后
      记录更新、version 不变；修改 SKILL.md 内容保存后 descriptor 更新、version minor bump、
      S3 上其余支撑文件保留。
- [x] AC4: 编辑页重新上传 zip 替换 bundle：S3 前缀换成新文件集、definition.files 更新、
      version bump。
- [x] AC5: MCP 记录编辑 URL 保存后 descriptors 更新。
- [x] AC6: DEPRECATED 记录无编辑入口且 PUT 返回 400；A2A 记录无编辑入口。
- [x] AC7: 内嵌抽屉代码删除，Registry.tsx 无回归（生命周期动作/reimport/搜索/tab 均正常）。
- [x] AC8: 后端 pytest + ruff、前端 tsc/lint/build 全绿；浏览器实操验证注册与编辑主流程。
