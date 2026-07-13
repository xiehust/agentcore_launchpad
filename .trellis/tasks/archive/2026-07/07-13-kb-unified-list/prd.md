# Unified KB list: surface non-managed account KBs read-only

## Goal

KB 列表展示 AWS 账号内**全部类型**的 Knowledge Base(不再只过滤 MANAGED),把控制台/其他应用创建的经典 VECTOR 等 KB 纳入统一浏览、检索验证与同步监控。

## Product decisions (river, 2026-07-13)

- 非 MANAGED KB 权限 = **只读 + Playground + 手动 Sync**:不可删 KB、不可增删数据源、不可改描述(非 Launchpad 资源,防误伤)。
- 挂载 picker 维持 MANAGED-only(AWS 硬约束:gateway connector 仅支持 Managed KB),非 MANAGED 行明示原因。
- 直接在 main 的新分支 `feat/kb-unified-list` 实施(无 worktree)。

## Requirements

1. **列表**:全类型 KB + TYPE 徽章(MANAGED/VECTOR/KENDRA/SQL);非 MANAGED 显示"不可挂载"提示;`attached_agents` 仅对 MANAGED 有意义。
2. **详情(非 MANAGED)**:概览(只读)、数据源列表(解析经典配置:s3Configuration/bucketArn、web/confluence/sharepoint/salesforce 显示来源标签)、ingestion 历史 + Sync now、文档列表(能解析出 S3 源的尽力支持)、Playground(VECTOR/KENDRA 走 `vectorSearchConfiguration`;SQL 型不支持 Retrieve → UI 禁用并说明)。
3. **能力门控**:后端所有 mutation 端点对非 MANAGED 保持拒绝(`_require_managed` 语义不变,但 GET detail/query/sync/documents 放行);前端按 `kb_type`/`read_only` 隐藏编辑/删除/增删数据源控件。
4. **CreateAgent picker**:仅列 MANAGED+ACTIVE(新增 `?type=` 过滤或前端过滤,防止 VECTOR 混入)。
5. i18n en/zh-CN 全覆盖。

## Constraints

- 账号现有 VECTOR KB:restaurant-assistant(HRZGIQ6MVD)、multimodal(B980XK3IO4)——用作真实验证对象,**绝不删除/修改**。
- Retrieve API:managed → `managedSearchConfiguration`;vector/kendra → `vectorSearchConfiguration`;SQL 无 Retrieve。
- 经典 S3 数据源的 bucket 字段是 **bucketArn**(非 bucketName)。

## Acceptance Criteria

- [ ] 列表出现 restaurant-assistant/multimodal(VECTOR 徽章、不可挂载提示),aurora-deck-docs 不受影响。
- [ ] VECTOR KB 详情:数据源/ingestion 历史可见;Playground 试查返回真实 chunks;Sync now 可用;编辑/删除/增删数据源控件不出现。
- [ ] 对非 MANAGED 的 DELETE/PATCH/数据源增删 API 直接 404/拒绝(回归 + 新测试)。
- [ ] CreateAgent picker 只显示 MANAGED KB。
- [ ] 全部 gates:pytest、ruff、tsc、i18n parity。
