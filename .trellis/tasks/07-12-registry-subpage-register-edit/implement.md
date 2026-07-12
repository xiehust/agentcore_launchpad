# Implement — Registry register/edit standalone sub-pages

两个切片，每片独立 commit 作为回滚点。

## Slice P0 — 注册子页面（纯前端） ✅ (2026-07-12)

- [x] 1. 新建 `frontend/src/pages/registry/RegisterView.tsx`：ViewHead + 返回 Btn +
      `eval-grid`（左：迁入的注册表单——类型 selchips + MCP 字段 + `<SkillSourceForm>`；
      右：流程说明 Panel，仿 `evalPage.newRun.how.*`）。提交/收尾逻辑自
      Registry.tsx `submitRegistration`/`finishRegistration` 迁入，成功 `onDone(recordId)`。
- [x] 2. `Registry.tsx`：`useSearchParams` 视图分派（`view==="register"` 早退渲染）；
      「+ 注册」按钮 → `setSearchParams({view:"register"})`；删除抽屉状态与 JSX；
      onDone → 清参数 + reload + 选中新记录。保留 `register-btn` testid。
- [x] 3. i18n：`registry.register.pageTitle` + `registry.register.how.*`（zh-CN + en）。
- [x] 4. 验证：tsc/lint/build；浏览器实操 AC1/AC2（四来源在子页注册 + 返回键）；
      检查 SampleGallery 注册链路不回归（grep 确认它直连 API）。
- [x] 5. review gate：P0 commit（回滚点）。

## Slice P1 — 编辑子页面 + 后端 PUT ✅ (2026-07-12)

### 后端
- [x] 6. `registry_console.update_record(record_id, ...)`：四分支
      （desc-only 不 bump / MCP url 重建 descriptors / skill_md 只覆写 SKILL.md 保留
      其余文件 / staging_id 整体替换复用 `_reupload_and_update` 语义）+ gating
      （DEPRECATED、A2A → 400）。
- [x] 7. `routers/registry.py`：`PUT /records/{record_id}`（`UpdateRecordRequest`，
      字段互斥/类型匹配校验，错误矩阵见 design §2）。
- [x] 8. 单测：desc-only（断言 record_version 未传）/ url / skill_md（断言仅 put_object
      SKILL.md、无前缀删除、bump 1.0.0→1.1.0）/ staging 替换（断言旧前缀清理 + files
      更新 + staging 消费）/ 400 矩阵 / 410 / 422 超限。

### 前端
- [x] 9. 新建 `frontend/src/pages/registry/EditView.tsx`（design §1.2：加载记录、
      name 只读、desc input、MCP url input、技能内容二选一（textarea 预填 / zip inspect
      预览）、右侧当前记录摘要 Panel、保存无变更禁用）。
- [x] 10. `Registry.tsx`：详情面板加「编辑」Btn（`edit-btn`，A2A/DEPRECATED 不显示）→
      `setSearchParams({view:"edit", record:id})`；view==="edit" 早退渲染；onDone 选中并刷新。
- [x] 11. i18n：`registry.edit.*`（zh-CN + en）。
- [x] 12. 验证：pytest/ruff + tsc/lint/build；浏览器实操 AC3/AC4/AC5/AC6
      （编辑 desc、改 SKILL.md 验证支撑文件保留、zip 替换、MCP url、gating）。
- [x] 13. review gate：P1 commit（回滚点）。

## 收尾
- [x] 14. 全量回归 + AC 清单勾对；spec 更新（registry-skill-ingestion.md 追加 PUT 契约
      + launchpad/index.md）；journal + 归档。

## 验证命令

```bash
cd backend && uv run pytest -q && uv run ruff check app tests
cd frontend && npx tsc --noEmit && npm run lint && npm run build
# 浏览器实操：agent-browser（上传文件放 workspace 路径，不放 /tmp）
```

## 回滚点

- P0/P1 各一个 commit；后端仅新增端点、前端组件化迁移，revert 即回滚，无数据迁移。
