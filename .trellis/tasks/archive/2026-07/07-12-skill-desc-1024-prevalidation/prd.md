# Pre-validate skill frontmatter description ≤1024 (AWS cap)

## Goal

2026-07-12 实测发现（导入 anthropics/skills claude-api，description 1068 字符）：AWS 在
CreateRegistryRecord 时解析 skillMd frontmatter 并强制 `description` ≤ **1024 字符**，
超限报 `ValidationException` —— 且发生在 S3 上传之后（管道清理正确但白传一轮）。
Launchpad 层加前置校验：inspect 阶段即报错，零 S3 写入。用户已确认修复（"ok"）。

## Requirements

- `skill_ingest.bundle_errors` 增加校验：frontmatter `description` > 1024 字符 →
  明确错误信息（提及 AWS 上限与实际长度）。共享常量 `SKILL_DESCRIPTION_MAX_CHARS = 1024`。
- 效果：git 多选扫描中超限行标 invalid（不可选，行内显示原因）；单 skill zip/url inspect
  422；register/update 路径在任何 S3 写入前 422。

## Acceptance Criteria

- [x] AC1: 单测——1025 字符 description → invalid + 错误信息；恰好 1024 → valid。
- [x] AC2: 真实 inspect anthropics/skills subdir=skills/claude-api → 该行 valid:false、
      errors 含 1024 说明、S3 无写入。
- [x] AC3: pytest + ruff 全绿；现有测试不回归。

## Notes

轻量任务：改动集中于一个校验函数 + 单测，主会话直接实现（不派子代理——改动位置与上下文
已在本会话完全掌握，派发开销大于收益）。
