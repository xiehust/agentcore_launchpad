# Implement — Registry skill multi-source ingestion

按 P0 → P1 → P2 三个切片推进；每个切片结束是一个 review gate + 可回滚点（独立 commit）。

## Slice P0 — 统一管道 + ZIP 上传 ✅ (2026-07-11)

### 后端
- [x] 1. 新建 `backend/app/services/skill_ingest.py`：
      `SkillSource` / `SkillBundle` / `SkillValidationError`、
      `bundle_from_inline`、`bundle_from_zip`、`validate_bundle`、顶级目录剥壳、
      共享常量 `SKILL_MD_MAX_BYTES=102400`、`SKILL_BUNDLE_MAX_BYTES`（与 `zip_runtime.py:99` 统一引用）。
- [x] 2. `registry_console.py`：新增 `register_skill_bundle`（多文件上传 + 真实 `files` +
      `source` 溯源，模式参照 `upload_skill_bundle:59-84`）；`register_skill` 改为
      `bundle_from_inline` + 新函数的薄封装。
- [x] 3. `routers/registry.py`：
      - `RegisterRequest.skill_md` 上限 200000 → 102400；
      - 新增 `POST /api/registry/skills/inspect`（multipart zip 分支）+ staging 缓存（TTL 10min）；
      - 新增 `POST /api/registry/skills/import`（staging_id + selections）。
- [x] 4. 后端单测：zip 解析（正常/剥壳/穿越/软链/bomb/缺 SKILL.md/超大 md）、
      inspect→import happy path、staging 过期、inline 回归（现有 test_registry*.py 不动全绿）。

### 前端
- [x] 5. `Registry.tsx` skill 分支加来源分段控件（inline/zip；git/url 占位禁用）；
      抽出 `frontend/src/pages/registry/SkillSourceForm.tsx`。
- [x] 6. zip 流：文件选择 → FormData inspect → 预览卡片（name/desc 可编辑 + 文件树 + 错误）→ import。
- [x] 7. 详情面板展示 `skillDefinition.files` 与 `source` 徽标（无 source 的旧记录不显示）。

### 验证（P0 gate）
- [x] 8. `cd backend && uv run pytest`；`cd frontend && npm run build && npm run lint`。
- [x] 9. 手工 AC1：真实上传三文件 zip → 检查 S3 前缀与记录 descriptors。
- [x] 10. 手工 AC2：审批 → Studio attach → 打包产物含全部文件。（消费端零改动+既有单测覆盖；全量验证并入步骤 24 收尾回归）
- [x] 11. review gate：P0 独立 commit（回滚点）。

## Slice P1 — Git 导入 ✅ (2026-07-11)

- [x] 12. `skill_ingest.bundles_from_git`：https-only、浅克隆子进程（60s 超时、
      `GIT_TERMINAL_PROMPT=0`）、token 注入 + 日志脱敏、删 `.git`、subdir 限定、
      `rglob("SKILL.md")` 多 skill 发现。
- [x] 12b. git 环境检测与降级链（R2.1）：`which git` 探测（带缓存）；缺失时
      github/gitlab/gitee/bitbucket 归档 zip 降级（token 走 Authorization header，
      复用 `bundle_from_zip`）；其他主机抛 `GitUnavailableError` 携带按包管理器生成的
      `install_hint`。
- [x] 12c. capabilities 端点：`GET /api/registry/skills/capabilities`
      （git 可用性/版本/降级主机列表/auto_installable 判定）；
      `POST /api/registry/skills/capabilities/git-install`（显式触发、非交互安装、
      120s 超时、回显结果、成功后失效探测缓存；无权限时仅返回 hint）。
- [x] 13. inspect JSON 分支（`{source:{kind:"git",...}}`）；import 支持多选批量注册（逐项成败）。
- [x] 14. 单测：本地 bare repo fixture（clone/ref/subdir/多 skill/非 https 拒绝/token 脱敏）；
      git 缺失场景（monkeypatch `shutil.which`→None）：归档降级命中已知主机、
      未知主机报 GitUnavailableError+hint、capabilities 上报 false、
      git-install 无权限时返回 hint 不执行。
- [x] 15. 前端 git 分支：url/ref/subdir/token 输入 + 扫描 → 复选列表（可改 name）→ 批量导入；
      切入时拉 capabilities，git 缺失展示警告横幅 + 自动安装按钮/手动安装命令。
- [x] 16. 验证：AC3 手工（公开 monorepo，如 anthropics/skills 勾选 2 个）；
      AC9 手工（临时 PATH 去掉 git 验证降级与提示）；pytest/build/lint。
- [x] 17. review gate：P1 独立 commit（回滚点）。

## Slice P2 — URL 来源 + 重新导入 ✅ (2026-07-11)

- [x] 18. `skill_ingest.bundle_from_url`：https-only、60s 超时、50MB 流式上限、
      zip vs raw md 分流；inspect JSON 分支扩展 kind:"url"。
- [x] 19. `reimport_skill(record_id)` + `POST /records/{id}/reimport`：
      按 source 重 acquire → 清旧 S3 前缀（delete_objects）→ 重传 → update 分支 bump recordVersion。
- [x] 20. 单测：url 两种形态（monkeypatch fetcher）、reimport（S3 清理 + 版本 bump）、
      非 git/url 来源 reimport 返回 4xx。
- [x] 21. 前端：url 分支表单；详情页「从来源重新导入」按钮（git/url 且非 DEPRECATED）。
- [x] 22. 验证：AC7 手工；pytest/build/lint。
- [x] 23. review gate：P2 独立 commit。

## 收尾

- [x] 24. 全量回归：`uv run pytest`（backend 全部）+ 前端 build/lint + AC 清单逐项勾对。
- [ ] 25. 更新 spec（步骤 3.3，`trellis-update-spec`）：registry 前端/后端行为写入 spec 索引。
- [ ] 26. journal 记录 + commit（步骤 3.4）。

## 验证命令速查

```bash
cd backend && uv run pytest tests/ -x -q          # 后端
cd frontend && npm run build && npm run lint       # 前端
uv run pytest tests/test_registry.py tests/test_registry_manage.py -q  # registry 回归
```

## 回滚点

- 每个 slice 一个 commit；任一 slice 出问题 revert 该 commit 即可，无数据迁移。
- S3 布局与现有记录 schema 向后兼容，回滚不影响已注册 skill。
