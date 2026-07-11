# Registry skill multi-source ingestion (zip/git/url)

## Goal

Registry 页（`/registry`）当前添加 Agent Skill 只支持粘贴单个 SKILL.md 文本，不满足真实使用场景。
本任务让 skill 注册支持多样化来源 —— **上传 ZIP 包、从 Git 仓库导入、URL 拉取** —— 并让多文件
skill bundle（SKILL.md + scripts/references 等支撑文件）完整落到 S3，供 agent 打包消费。

## Background / Constraints（已核实的事实）

- AWS Registry API（`CreateRegistryRecord`，`descriptorType: AGENT_SKILLS`）**只支持 inline 内容**：
  `skillMd.inlineContent`（必填，≤102,400 字符）+ `skillDefinition.inlineContent`（选填，≤100KB）。
- 官方文档明确：URL 同步（`synchronizationType: URL`）**只对 MCP / A2A 记录开放，AGENT_SKILLS 不支持**。
  因此所有来源多样性必须在 Launchpad 层实现，最终统一收敛为 inline 描述符 + S3 文件束。
- 消费端已支持多文件：`zip_runtime.py` 的 `_download_skill_prefix` / `bundle_skills_into`
  会下载整个 `s3://{bucket}/skills/{name}/` 前缀（50MB/skill 上限），部署侧零改动。
- 现有 bug 顺带修复：`RegisterRequest.skill_md` 允许 200,000 字符，超过 AWS 102,400 上限会在
  AWS 侧失败；本任务收紧为 100KB。

## Requirements

### R1 — ZIP 上传（P0）
- Registry 注册表单的 skill 分支支持上传 `.zip` 文件（multipart）。
- ZIP 内容为一个 skill bundle：根目录（或唯一顶级目录，自动剥壳）含 `SKILL.md`，可带任意支撑文件。
- 后端解压、校验后将**全部文件**上传到 `s3://{artifacts_bucket}/skills/{name}/`，
  `skillDefinition.files` 为真实文件列表（替换现在硬编码的 `["SKILL.md"]`）。

### R2 — Git 导入（P1）
- 支持填写 git HTTPS URL + 可选 ref（branch/tag）+ 可选子目录，后端浅克隆获取。
- 仓库内可能有多个 skill（monorepo，如 anthropics/skills）：扫描 `**/SKILL.md`，
  发现多个时前端展示列表供勾选，支持批量注册。
- 私有仓库支持可选 token（仅内存使用，不落日志、不持久化）。

#### R2.1 — git 环境检测与降级（P1）
- 后端必须在使用前检测 `git` CLI 是否可用，并通过 capabilities 接口暴露给前端。
- git 缺失时按序降级：
  1. 可识别托管平台（github.com / gitlab.com / gitee.com / bitbucket.org）→
     自动改走 HTTPS 归档 zip 下载（无需 git，功能不受影响）；
  2. 其他 git 主机 → 前端展示明确警告 + 提供「尝试自动安装」动作：后端检测包管理器
     （apt/yum/apk/brew）与权限（root 或免密 sudo），具备条件则 best-effort 自动安装并重新探测；
  3. 无权限自动安装时 → 返回平台对应的手动安装命令，提醒用户在服务器上安装。
- 自动安装是显式用户动作触发（非后台静默执行），结果（成功/失败+原因）回显给用户。

### R3 — URL 拉取（P2）
- 支持直接给一个 URL：指向 raw `SKILL.md` 或 `.zip` 归档，后端下载后走同一管道。

### R4 — 统一管道与校验（贯穿）
- 四种来源（inline/zip/git/url）收敛为同一个 `SkillBundle` 抽象 + 同一条
  「校验 → S3 上传 → 建记录」管道；inline 现有行为保持兼容。
- 校验规则（所有来源共享）：
  - 恰好一个 `SKILL.md`（单 skill 语境下）；frontmatter 可解析出 name/description/version；
  - `SKILL.md` ≤ 100KB（AWS 上限）；bundle 总量 ≤ 50MB（对齐消费端）；文件数 ≤ 200；
  - ZIP 安全：防 zip bomb（解压时累计未压缩大小）、拒绝路径穿越（`..`/绝对路径）与符号链接；
  - name 冲突返回 409（沿用 `_require_new_name`）。
- 溯源：`skillDefinition.inlineContent` JSON 增加 `source` 字段
  （`{kind, url?, ref?, subdir?, imported_at}`），记录详情页展示来源。

### R5 — 前端 UX（贯穿）
- 注册抽屉 skill 分支加来源分段控件：粘贴 SKILL.md ｜ 上传 ZIP ｜ 从 Git 导入 ｜ URL。
- ZIP/Git/URL 来源先经 inspect 预览（解析出的 name/description/文件树），
  name/description 自动带出且可编辑，确认后提交。
- 记录详情展示来源徽标与文件列表。

### R6 — 重新导入（P2，可选收尾）
- git/url 来源的记录提供「从来源重新导入」动作：重跑管道、清理旧 S3 前缀后重传、
  走 `upsert_record` update 分支 bump `recordVersion`。

## Out of Scope

- AWS 原生 URL 同步（AGENT_SKILLS 不支持，已排除）。
- SSH git、submodule、git-LFS。
- Registry 记录审批流程改动（沿用现有 DRAFT→submit→approve）。
- Studio 侧 skill 创建入口改动（SampleGallery 继续走 inline 路径）。

## Acceptance Criteria

- [x] AC1: 在 `/registry` 上传一个含 `SKILL.md + scripts/helper.py + references/doc.md` 的 zip，
      注册成功；S3 `skills/{name}/` 下三个文件齐全；记录 `skillDefinition.files` 列出全部三个文件。
- [x] AC2: 该 skill 审批后在 Studio attach 给 agent 并打包，部署包 `skills/{name}/` 含全部文件
      （消费端零改动验证）。
- [x] AC3: 给一个含多个 skill 的公开 git 仓库 URL，扫描后能列出全部 skill，勾选其中两个批量注册成功。
- [x] AC4: 恶意 zip（路径穿越 / 超 50MB 解压 / 无 SKILL.md）被拒绝，返回明确 4xx 错误信息，无残留 S3 对象。
- [x] AC5: SKILL.md 超过 100KB 时（含 inline 路径）在 Launchpad 层直接 4xx，不打到 AWS。
- [x] AC6: inline 粘贴路径行为不回归（现有测试 `test_registry*.py` 全绿）。
- [x] AC7: URL 指向 raw SKILL.md 与指向 zip 归档均可注册成功。
- [x] AC8: 后端 `pytest` 与前端构建/lint 通过。
- [x] AC9: 模拟 git 缺失（PATH 中无 git）：github.com 仓库仍可经归档降级导入成功；
      非托管平台 URL 返回含安装指引的明确错误；capabilities 接口正确上报 `git_available: false`，
      前端 git 分支展示警告横幅与「尝试自动安装」入口。
