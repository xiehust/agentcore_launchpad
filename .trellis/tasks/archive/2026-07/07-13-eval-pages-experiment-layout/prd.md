# Evaluators/Datasets sub-pages adopt Experiment-style interaction

## Goal

把 Evaluation 模块中 EVALUATORS(`?view=evaluators`)和 DATASETS(`?view=datasets`)两个子页面的
编辑布局改成与 EXPERIMENT(`?view=experiment`)一致的页面交互:

- 顶部全宽表格 Panel 列出所有条目,行点击选中(选中行高亮),`+ 新建` 主按钮在表头 `end` 区。
- 选中状态写入 URL 查询参数(可链接、浏览器后退可回退),`=new` 打开新建表单。
- 表格下方 `eval-grid` 两栏:左侧为选中条目的详情/编辑面板,右侧为 "how it works" 说明面板。
- 行内不再放操作按钮(Edit/Delete/Sync),操作全部移入下方详情面板(与 EXPERIMENT 的
  cleanup/promote 在详情内一致)。

## Requirements

### R1 — EVALUATORS 页面(EvaluationEvaluators.tsx)

- R1.1 顶部表格列出 builtin + custom 全部 evaluator。列:NAME / LEVEL / SOURCE / GT / STATUS。
- R1.2 行点击 → `?view=evaluators&ev=<id>`;`ev=new` → 新建表单;无参数默认选中第一个
  custom evaluator(与 EXPERIMENT 的 `?? experiments[0]` 语义对齐),没有 custom 时落到新建表单。
- R1.3 选中 custom → 左侧面板加载编辑表单(现有 GET detail → draft 逻辑保留),面板头 `end` 放
  删除按钮(保留 ConfirmDialog);Save 走现有 PUT。
- R1.4 选中 builtin → 左侧面板只读详情(通过现有 `GET /api/eval/evaluators/{id}` 拉取
  instructions/rating_scale 展示;拉取失败时降级为列表行信息),明确标注 read-only,不可保存/删除
  (后端 PUT 对 Builtin.* 返回 400,前端不应提供入口)。
- R1.5 新建表单保留现有全部字段与校验(name 正则、placeholder 必含、scale ≥2 完整)、Prefill 样例按钮。
- R1.6 右侧说明面板:仿 EXPERIMENT/NewRun 的 `how` 面板(编号步骤 + note),新增 i18n 键。

### R2 — DATASETS 页面(EvaluationDatasets.tsx)

- R2.1 顶部单一表格合并本地数据集与 cloud-only 数据集。列:NAME / ITEMS / KIND / GT / CLOUD。
  cloud-only 行名称带 ☁ 前缀(与 runs 表的 scopeLabel 约定一致),KIND 显示去掉
  `AGENTCORE_EVALUATION_` 前缀的 schemaType,CLOUD 列复用现有 cloudChip / 状态 Chip。
- R2.2 行点击 → `?view=datasets&ds=<id>`(cloud-only 行用 `ds=cloud:<datasetId>`,复用既有
  `cloud:` 前缀约定);`ds=new` → 新建表单;无参数默认选中第一个本地数据集,没有则新建表单。
- R2.3 选中本地数据集 → 左侧面板为现有场景编辑器(scenario/turns/assertions/trajectory 全保留),
  面板头 `end` 放 Sync 与 Delete 按钮;sync 失败原因(`cloud.failure_reason` / syncError)在面板内展示。
- R2.4 选中 cloud-only 行 → 只读详情(schemaType/exampleCount/status/updatedAt)+ Delete 按钮
  (保留 ConfirmDialog)。
- R2.5 新建表单保留 form/import 双模式、导入预览与错误提示、Prefill 样例;import 模式仅新建可用
  (现状保持)。
- R2.6 右侧说明面板:同 R1.6。

### R3 — 通用约束

- R3.1 选中行高亮样式与 EXPERIMENT 一致(`rgba(255,176,0,.045)`)。
- R3.2 切换选中行时,编辑草稿状态必须重置(仿 EXPERIMENT 的 per-row state reset useEffect),
  不得把上一行的草稿泄漏到下一行。
- R3.3 `setSearchParams` 必须保留 `view=` 参数,返回按钮(◂ back)行为不变。
- R3.4 现有 CRUD 行为不变:创建/编辑/删除 evaluator;创建/编辑/删除/同步 dataset;删除 cloud
  dataset。所有 toast、错误提示、ConfirmDialog 保留。
- R3.5 i18n:新增键同时提供 en 与 zh-CN;表头尽量复用已有键(如 `evalPage.datasets.gt`),
  新增表格列/how 面板键放在 `evalPage.evaluators.*` / `evalPage.datasets.*` 下。
- R3.6 data-testid:保留 Evaluation.tsx 仪表盘上的 `datasets-btn` / `evaluators-btn`;
  sync 按钮保留 `sync-<name>` testid(位置移入详情面板);新增行级 testid
  (`evaluator-row-<id>` / `dataset-row-<id>`)与新建按钮 testid(`new-evaluator-btn` / `new-dataset-btn`)。
- R3.7 不改后端;不改 Evaluation.tsx 的路由分发(仍是 `?view=` 三分支)。

## Acceptance Criteria

- [ ] AC1 两个子页面顶部均为全宽表格 Panel,行点击选中并写 URL 参数,`+ 新建` 在表头,与
  EXPERIMENT 交互一致。
- [ ] AC2 直接打开 `/?view=evaluators&ev=<custom-id>`(或 `&ev=new`)、
  `/?view=datasets&ds=<id>`(或 `ds=cloud:<id>` / `ds=new`)能直达对应详情/表单;浏览器后退
  逐级回退。
- [ ] AC3 evaluator:新建、编辑保存、删除各走通一遍(fetch-stub 或真实后端),builtin 只读无
  保存/删除入口。
- [ ] AC4 dataset:新建(form + import)、编辑保存、sync、本地删除、cloud 删除各走通一遍;
  sync 失败原因可见。
- [ ] AC5 切换选中行后表单内容为新行内容(无草稿泄漏)。
- [ ] AC6 `npm run build`(tsc + vite)与 eslint 通过;en/zh-CN 两份 locale 无缺键
  (页面无 raw key 泄漏)。
- [ ] AC7 浏览器截图证据:两个页面的表格+详情布局、选中态、新建态(vite 端口按 memory 先确认
  5173/5174)。

## Notes

- 参照实现:`frontend/src/pages/EvaluationExperiment.tsx`(表格 + `?exp=` 选中 + 详情/how 双栏)。
- 后端事实:`GET /api/eval/evaluators/{id}` 对 Builtin.* 可用(直通 GetEvaluator);PUT 对
  Builtin.* 返回 400 `evaluator.builtin_immutable`。
- 仓库内无引用 `edit-<id>` testid 的自动化脚本(已 grep),移除安全。
