# Design — Registry skill multi-source ingestion

## 1. 架构总览

所有来源在后端收敛为一个 `SkillBundle`（staging 临时目录 + 元数据），走同一条管道：

```
acquire (来源各异)                 统一管道 (单一实现)
┌─ inline 粘贴 ──┐
├─ zip 上传     ──┤→ staging dir → validate → (update 时先清旧前缀) → S3 上传
├─ git 浅克隆   ──┤                              skills/{name}/{rel}
└─ url 下载     ──┘             → definition{files: 真实列表, source: 溯源}
                                → build_skills_descriptors → upsert_record
                                → wait_record_settled → DRAFT
```

AWS 侧不变：记录仍是 inline `skillMd` + `skillDefinition`（各 ≤100KB）；
文件束真身在 `s3://{artifacts_bucket}/skills/{name}/`。
消费端（`zip_runtime._download_skill_prefix` / `bundle_skills_into`）已按 S3 前缀整体下载，零改动。

## 2. 后端模块设计

### 2.1 新模块 `backend/app/services/skill_ingest.py`

```python
@dataclass
class SkillSource:
    kind: Literal["inline", "zip", "git", "url"]
    url: str | None = None        # git/url
    ref: str | None = None        # git
    subdir: str | None = None     # git
    imported_at: str = ""         # ISO8601，注册时盖章

@dataclass
class SkillBundle:
    root: Path                    # staging 目录，SKILL.md 位于根
    name: str                     # frontmatter name（可被表单覆盖）
    description: str
    version: str                  # frontmatter version，缺省 "0.1.0"
    files: list[str]              # 相对路径，POSIX 分隔
    skill_md: str                 # SKILL.md 内容（供 inline descriptor）
    source: SkillSource

# acquirers —— 全部返回落好盘的 staging 目录（TemporaryDirectory，caller 负责生命周期）
def bundle_from_inline(skill_md: str) -> SkillBundle
def bundle_from_zip(data: bytes) -> SkillBundle
def bundles_from_git(url, ref=None, subdir=None, token=None) -> list[SkillBundle]  # monorepo 可返回多个
def bundle_from_url(url: str) -> SkillBundle   # content-type/后缀判断 raw md vs zip

def validate_bundle(b: SkillBundle) -> None    # 违规抛 SkillValidationError(422 语义)
```

关键实现点：

- **zip 解压安全**：用 `zipfile` 逐 entry 处理——拒绝绝对路径与 `..`（`Path.resolve` 后必须在
  staging 下）；跳过目录项；`external_attr` 判断符号链接直接拒绝；解压过程中累计未压缩字节数，
  超 50MB（`_SKILL_BUNDLE_MAX_BYTES`，与 `zip_runtime.py:99` 对齐，抽成共享常量）即中止。
- **顶级目录剥壳**：若 zip/git-subdir 根下没有 `SKILL.md` 但恰好只有一个顶级目录且其中有
  `SKILL.md`，自动下探一层（覆盖 GitHub 归档 `repo-ref/` 包装）。
- **git 获取**：`subprocess.run(["git", "clone", "--depth", "1", *(["--branch", ref] if ref else []),
  url, dst], timeout=60, env={"GIT_TERMINAL_PROMPT": "0", ...})`。仅接受 `https://` URL；
  token 以 `https://x-access-token:{token}@host/...` 注入克隆 URL，错误信息与日志中对 URL 做
  脱敏（replace token → `***`）。克隆后删除 `.git` 目录再扫描。
- **git 环境检测与降级链**（R2.1）：`bundles_from_git` 入口先探测
  `shutil.which("git")`（结果缓存，安装动作后失效重探）：
  1. git 可用 → 浅克隆（上面的通用路径）；
  2. git 缺失且 host ∈ {github.com, gitlab.com, gitee.com, bitbucket.org} →
     **归档降级**：按平台拼归档 URL（github: `/archive/{ref}.zip`；gitlab/gitee:
     `/-/archive/{ref}/...zip`；bitbucket: `/get/{ref}.zip`；ref 缺省 HEAD/默认分支），
     token 放 Authorization header，下载后复用 `bundle_from_zip`（剥壳逻辑已覆盖归档包装目录）；
  3. 其他 host → 抛 `GitUnavailableError`，携带 `install_hint`（按检测到的包管理器给出
     `apt-get install -y git` / `yum install -y git` / `apk add git` / `brew install git`）。
- **多 skill 发现**：在（subdir 限定后的）树内 `rglob("SKILL.md")`，每个命中目录构造一个
  `SkillBundle`；单个也返回 list，调用方统一处理。
- **url 获取**：`httpx`/`urllib` GET（60s 超时、50MB 流式上限）；`.zip`/`application/zip` →
  `bundle_from_zip`；否则按 raw SKILL.md → `bundle_from_inline` 语义。仅 `https://`。
- **校验**（`validate_bundle`）：SKILL.md 存在且 ≤102,400 字节；文件数 ≤200；总量 ≤50MB；
  frontmatter 可解析（复用 `registry_console._parse_frontmatter`，移到本模块或共享 util）；
  name 若来自 frontmatter 需匹配 `^[a-z][a-z0-9-]{2,63}$`（不匹配时要求表单显式提供）。

### 2.2 `registry_console.py` 改造

- `register_skill(name, description, skill_md)` 重构为薄封装：
  `register_skill_bundle(bundle: SkillBundle, *, name_override=None, description_override=None)`。
  内部：`_require_new_name` → 上传 `bundle.root` 下全部文件到 `skills/{name}/{rel}`
  （复用 `upload_skill_bundle` 的 rglob+upload_file 模式，`registry_console.py:59-84`）→
  `definition = {name, description, version, path, files: bundle.files, source: asdict(bundle.source)}`
  → `upsert_record(...)` → `wait_record_settled`。
- 现有 inline 路由继续可用：`register_record` 内部先 `bundle_from_inline(skill_md)` 再走新函数，
  对外行为不变（AC6）。
- **update/重导入**（R6）：新函数 `reimport_skill(record_id)` — 读记录 `skillDefinition.source`，
  按 kind 重新 acquire → 校验 → `delete_objects` 清空 `skills/{name}/` 旧前缀 → 重传 →
  `upsert_record` update 分支（`agentcore/registry.py:111` 已支持），`recordVersion` minor bump。
  仅 kind ∈ {git, url} 提供；DRAFT/APPROVED 状态均允许（AWS update 会产生新 revision）。

### 2.3 API 端点（`routers/registry.py`）

| 端点 | 方法 | 请求 | 响应 |
|---|---|---|---|
| `/api/registry/skills/inspect` | POST | multipart（`file`: zip）**或** JSON `{source:{kind:"git"|"url", url, ref?, subdir?, token?}}` | `{skills: [{name, description, version, files[], skill_md_excerpt, valid, errors[]}], staging_id}` |
| `/api/registry/skills/import` | POST | JSON `{staging_id, selections: [{name, name_override?, description_override?}]}` | `{records: [...]}`（逐个 201/错误明细） |
| `/api/registry/records`（现有） | POST | JSON，inline 路径不变 | 不变 |
| `/api/registry/records/{id}/reimport` | POST | 空体 | 更新后的 record |
| `/api/registry/skills/capabilities` | GET | — | `{git: {available, version?, fallback_hosts[], install: {auto_installable, package_manager?, hint}}}` |
| `/api/registry/skills/capabilities/git-install` | POST | 空体 | `{ok, git_version?, error?, hint?}` |

- **capabilities**：`shutil.which("git")` + `git --version`；`auto_installable` 判定 =
  检测到包管理器（apt/yum/apk/brew）且（`os.geteuid()==0` 或 `sudo -n true` 免密）。
- **git-install**：显式用户动作触发的 best-effort 安装 —— 用检测到的包管理器执行
  非交互安装（如 `apt-get install -y git`），120s 超时，stdout/stderr 尾部随响应回显；
  成功后失效 git 探测缓存。无权限/无包管理器时不尝试，直接返回 `hint` 供用户手动安装。
  该端点会改变系统状态：仅从 UI 显式按钮调用，服务端记 log。

- **staging 机制**：`inspect` 把 acquire+validate 结果留在服务端临时目录，返回随机
  `staging_id`（`secrets.token_urlsafe`），进程内 dict 保存 `{id: (path, bundles, expires)}`，
  TTL 10 分钟、定期清理。`import` 凭 id 消费，避免 zip 传两次/git 克隆两次。
  单进程 uvicorn（本项目部署形态）下进程内缓存足够；不引入 Redis。
- token 只在 `inspect` 请求中出现，随 staging 一起在内存保存到 TTL 结束，不写盘、不入日志。
- `RegisterRequest.skill_md` 上限 200000 → 102400（AC5）。

### 2.4 数据契约（skillDefinition.inlineContent JSON）

```json
{
  "name": "meeting-summarizer",
  "description": "...",
  "version": "0.1.0",
  "path": "s3://{bucket}/skills/meeting-summarizer/",
  "files": ["SKILL.md", "scripts/helper.py", "references/doc.md"],
  "source": {"kind": "git", "url": "https://github.com/org/skills", "ref": "main",
              "subdir": "skills/meeting-summarizer", "imported_at": "2026-07-11T00:00:00Z"}
}
```

向后兼容：旧记录无 `source` / `files` 只有 `["SKILL.md"]`，读取方（Registry 详情页、
`openInWizard`、`attachable_records`）都只按存在性读取，不做强 schema 校验。

## 3. 前端设计（`frontend/src/pages/Registry.tsx`）

- skill 分支顶部加来源分段控件 `regSource: "inline" | "zip" | "git" | "url"`（默认 inline）。
- **inline**：现状不变。
- **zip**：`<input type="file" accept=".zip">` → 选中即 `FormData` POST `inspect` →
  展示解析结果卡片（name/description 预填可编辑 + 文件树 + 校验错误）→ 「注册」调 `import`。
- **git**：url / ref / subdir / token(password 型) 四个输入 + 「扫描」→ `inspect` →
  多结果时复选列表（默认全不选），每项可改 name → 「导入所选」调 `import`，逐项显示成败。
  - 切到 git 分支时拉取 `capabilities`：`git.available=false` 时显示警告横幅
    「服务器未安装 git：github/gitlab/gitee/bitbucket 仓库仍可导入（归档降级）；其他主机需安装 git」，
    并按 `install.auto_installable` 展示「尝试自动安装」按钮（调 `git-install`，回显结果并刷新
    capabilities）或手动安装命令（`install.hint`，可复制）。
- **url**：单输入 + 同 zip 的预览-确认流。
- 详情面板：解析 `skillDefinition.inlineContent`，展示 `source.kind` 徽标、文件列表；
  git/url 来源且非 DEPRECATED 时显示「从来源重新导入」按钮 → `POST /reimport`。
- 组件规模控制：来源表单抽成 `frontend/src/pages/registry/SkillSourceForm.tsx` 子组件，
  避免 Registry.tsx 再膨胀（现 546 行）。

## 4. 权衡与已排除方案

- **AWS 原生 URL sync**：AGENT_SKILLS 不支持（官方文档），排除。
- **GitPython/dulwich**：引依赖不如 `git` CLI 子进程（容器/开发机均有 git），排除。
- **归档 zip 下载作为 git 的主路径**：只覆盖已知托管平台，不通用，不作主路径；
  但作为 **git 缺失时的降级路径** 保留（见 2.1 降级链）——覆盖主流平台且不要求改动系统。
- **staging 用 S3 预签名直传**：对本项目（单机 demo/lab）过度设计，排除；服务端 multipart 简单可控。
- **前端两步 vs 一步提交**：zip 理论上可一步提交，但 git 的多 skill 发现必须两步；
  统一走 inspect→import 两步，前后端只维护一条交互模型。

## 5. 兼容性与回滚

- 现有 `POST /records` inline 契约不动，Studio `SampleGallery.approveSkill` 不受影响。
- 新功能全部是新增端点 + 表单新分支；回滚 = revert 提交即可，无数据迁移。
- S3 布局不变（`skills/{name}/`），旧记录可继续被消费端下载。
- 失败清理：管道在 S3 上传后、建记录失败时删除已传前缀（best-effort），避免孤儿对象（AC4）。

## 6. 测试策略

- 后端单测（延续 `tests/test_registry*.py` 的 stub/monkeypatch 风格，不打真 AWS）：
  - `skill_ingest`：zip 正常/剥壳/穿越/软链/zip bomb/无 SKILL.md/超大 SKILL.md；
    git 用本地 bare repo fixture（`git init` + commit）验证 clone/ref/subdir/多 skill 扫描；
    url 用 monkeypatch 的 fetcher。
  - 路由：inspect/import/reimport 的 happy path 与 4xx；staging TTL 过期 410。
- 前端：构建 + lint；交互用现有的 fetch-stub 状态测试模式补 zip/git 分支。
- E2E 手工验收对照 AC1–AC7（真实 AWS registry + S3），复用 `backend/scripts/e2e_registry.py` 扩展。
