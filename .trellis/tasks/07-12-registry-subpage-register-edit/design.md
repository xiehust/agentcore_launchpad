# Design — Registry register/edit standalone sub-pages

## 1. 前端结构（仿 Evaluation 模式，`Evaluation.tsx:159-354` 为范本）

```
Registry.tsx（列表 + 详情，保留）
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get("view");
  if (view === "register") return <RegisterView onBack={...} onDone={...} />;
  if (view === "edit")     return <EditView recordId={searchParams.get("record")} onBack={...} onDone={...} />;
  // 列表页：「+ 注册」按钮 → setSearchParams({view:"register"})
  // 详情面板：新增「编辑」Btn（type!==A2A 且 status!==DEPRECATED）→ setSearchParams({view:"edit", record:id})
```

新文件（与 SkillSourceForm/GitSourcePanel 同目录 `frontend/src/pages/registry/`）：

### 1.1 `RegisterView.tsx`
- `<section>` + `ViewHead(kicker=registry.kicker, title=注册记录, meta=…)` + `◂ 返回` Btn
  + `eval-grid`：
  - 左 Panel（`brk`）：现有注册表单整体迁入 —— 记录类型 selchips（MCP / AGENT_SKILLS）、
    MCP 分支（name/desc/url）、技能分支（`<SkillSourceForm>` 四来源，含 name/desc 的
    inline 分支字段）。提交逻辑从 Registry.tsx 的 `submitRegistration` / `finishRegistration`
    迁入本组件。
  - 右 Panel：流程说明（kv 步骤 01-04：注册→DRAFT→提交审批→APPROVED 可挂载；
    note 说明技能上传到制品桶 + 100KB/50MB caps）—— 仿 `evalPage.newRun.how.*` 的结构。
- 成功回调 `onDone(recordId)`：父组件 `setSearchParams({}, {replace:true})` + 选中记录 + reload。
  git 批量导入沿用 GitSourcePanel 现有语义（全部成功才触发 onImported）。
- Registry.tsx 中删除：`showReg`/`regType`/`regName`/`regDesc`/`regUrl`/`regMd`/`regSource`
  状态、抽屉 JSX、`submitRegistration`；`finishRegistration` 的收尾语义并入 onDone。

### 1.2 `EditView.tsx`
- 挂载时 `GET /api/registry/records/{id}` 加载；不存在/加载失败 → 错误 note + 返回按钮。
- 布局：ViewHead（title=编辑记录 · {name}）+ 返回 Btn + `eval-grid`：
  - 左 Panel：表单
    - name：只读展示（mono，注明「名称与 S3 前缀绑定，不可修改」）
    - description：input
    - MCP 记录：URL input（预填 descriptors 解析出的 server url——从
      `descriptors.mcp.server.inlineContent` JSON 提取，解析失败则空）
    - AGENT_SKILLS 记录：内容编辑二选一 selchips：
      - 「编辑 SKILL.md」：textarea 预填 `descriptors.agentSkills.skillMd.inlineContent`
      - 「重新上传 ZIP」：复用现有 zip inspect 流（`/skills/inspect` multipart →
        预览卡展示新文件树）→ 保存时把 `staging_id`+`index` 交给 PUT
    - 保存 Btn（无变更时禁用）→ `PUT /api/registry/records/{id}` → toast → `onDone(id)`
  - 右 Panel：当前记录摘要（状态 chip、version、来源徽标、files 列表、updated_at）
    ——只读，编辑前后对照用。
- testids：`edit-btn`（详情面板入口）、`edit-desc-input`、`edit-url-input`、
  `edit-mode-md`/`edit-mode-zip`、`edit-md-textarea`、`edit-save-btn`、`edit-error`。

### 1.3 参数与路由注意
- `setSearchParams` 进子页用默认 push（浏览器返回键回列表，与 Evaluation 一致）；
  返回/完成用 `{replace:true}`。
- Registry.tsx 现有的行选中是组件内 state（无 `?record=` 参数），与 `record` 参数无冲突；
  onDone 后用返回的 record id 直接 `setSelected`。
- i18n：新增 `registry.register.pageTitle/how.*`、`registry.edit.*` 于 zh-CN + en。

## 2. 后端 `PUT /api/registry/records/{record_id}`

### 请求/校验

```python
class UpdateRecordRequest(BaseModel):
    description: str | None = Field(default=None, max_length=500)
    url: str | None = None                      # MCP only
    skill_md: str | None = Field(default=None, max_length=102400)  # AGENT_SKILLS only
    staging_id: str | None = None               # AGENT_SKILLS only，与 skill_md 互斥
    index: int = 0                              # staging 内 bundle 下标
```

| 条件 | 错误 |
|---|---|
| 全部字段为 None | 400 `registry.nothing_to_update` |
| 记录 DEPRECATED | 400 `registry.not_editable` |
| 记录类型 A2A | 400 `registry.not_editable` |
| url 用于非 MCP / skill_md 或 staging_id 用于非技能 | 400 `registry.field_type_mismatch` |
| skill_md 与 staging_id 同时给 | 400 `registry.field_conflict` |
| staging 过期 | 410 `registry.staging_expired` |
| skill_md 超限/校验失败 | 422 `registry.skill_invalid` |

### 服务层 `registry_console.update_record(record_id, req)`

1. `console_get` 读记录；gating（DEPRECATED/A2A）。
2. 按类型分派：
   - **MCP + url**：`reg.build_mcp_descriptors(name, new_url, tools=None)` 重建 →
     update（内容变更 → bump）。
   - **AGENT_SKILLS + skill_md**（只换 SKILL.md，保留其余文件）：
     校验（≤100KB、frontmatter 可解析）→ `put_object` 覆写 `skills/{name}/SKILL.md` →
     definition = 旧 definition 基础上更新 description/version(frontmatter)/imported_at
     （files 不变，source 保持原值）→ `build_skills_descriptors` → update + bump。
   - **AGENT_SKILLS + staging_id**（整体替换）：取 staged bundle →
     复用 reimport 的 `_reupload_and_update` 语义（清旧前缀→传新文件→descriptor 全新，
     name 固定为记录名 name_override）→ bump；消费后 drop staging。
   - **仅 description**：重发现有 descriptors（AWS update 必带 descriptors）+ 新
     description，不 bump `recordVersion`。
3. 返回 `_record_out(console_get(record_id))`。

实现注意：
- `upsert_record(..., record_version=...)` 已支持（reimport 引入）；description 是
  update_registry_record 顶层参数。
- `_bump_minor` / `_delete_prefix` / staging（`_staging` dict）都在现有代码里，直接复用。
- skill_md-only 路径**不要**清前缀（会误删支撑文件）。

## 3. 权衡与已排除

- **name 可编辑**：排除。S3 前缀、attachables、部署包 skills/ 目录都按 name 键——改名
  = 移动前缀 + 全链路失效风险，价值低。
- **抽屉保留 + 子页并存**：排除。两套注册入口双倍维护，用户明确要独立页面。
- **edit 用 PATCH**：用 PUT 但字段可选（部分更新语义），与 datasets 的 PUT 部分更新
  先例一致（`evaluation/routers.py DatasetUpdate`）。
- **MCP url 编辑触发 re-sync**：不做（out of scope，现有 MCP 注册也不 sync）。

## 4. 兼容性与回滚

- 后端仅新增端点；前端删抽屉但表单组件复用，`?gateway=`/`?skill=` 深链指向 /create
  不受影响。回滚 = revert 提交，无数据迁移。
- 旧记录（无 files/source 字段）进编辑页：skill_md 从 descriptors 预填仍可用；
  zip 替换路径生成全新 definition —— 天然兼容。

## 5. 测试策略

- 后端（stub 风格延续）：update_record 各分支（desc-only 不 bump / url / skill_md 保留
  其余文件（断言只 put SKILL.md、无 delete）/ staging 替换（断言旧前缀清理+新文件）/
  gating 400 矩阵 / staging 410 / 超限 422）。
- 前端：tsc/lint/build；浏览器实操走 AC1-AC7（复用 agent-browser，上传文件放 workspace
  路径——见 dev-environment quirks）。
