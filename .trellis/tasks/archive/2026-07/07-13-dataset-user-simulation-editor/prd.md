# Dataset editor: user simulation scenario type

## Goal

数据集创建/编辑器目前只支持多轮 turns 场景(predefined/legacy),缺少 devguide
[user-simulation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/user-simulation.html)
定义的 **user simulation(simulated persona)** 场景类型。补上:创建表单可选 USER SIMULATION
类型并编排 actor_profile 场景;编辑已有 simulated 数据集时表单能正确回显与保存
(当前 `toDrafts` 不认 `actor_profile`,回显为空,保存会被后端 `dataset.kind_immutable` 400 挡下)。

**纯前端改动** — 后端已完整支持(`_validate_items` 校验 actor_profile.context/goal + input +
scenario_id 唯一;`_infer_kind`→simulated;sync 用 SIMULATED_V1 schema;运行时 actor_model_id
必填已有 UI)。

## Devguide schema(已核对官方文档)

Simulated scenario 字段(用 `actor_profile`+`input` 取代 `turns`):

| 字段 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `scenario_id` | 是 | — | 唯一 id |
| `scenario_description` | 否 | "" | 场景元描述 |
| `actor_profile.context` | 是 | — | actor 背景 |
| `actor_profile.goal` | 是 | — | actor 目标(达成即 stop) |
| `actor_profile.traits` | 否 | {} | key-value 特征(expertise/tone/patience…) |
| `input` | 是 | — | 发给 agent 的第一条消息 |
| `max_turns` | 否 | 10 | ≥1,安全上限 |
| `assertions` | 否 | — | 自然语言断言(simulated 的唯一 ground truth) |

**不支持** `turns`、per-turn `expected_response`、`expected_trajectory`(对话流不可预知)。

## Requirements

- R1 **类型选择(仅新建)**:form 模式下新增场景类型 selchips —
  MULTI-TURN(现状,默认)| USER SIMULATION。编辑时类型由 `editingKind` 决定不可切换
  (kind 服务端不可变);import 模式不受影响(后端自动推断)。
- R2 **simulation 场景编辑器**:每个场景卡片含 scenario_id、scenario_description(可选)、
  actor CONTEXT(textarea,必填)、GOAL(textarea,必填)、TRAITS key-value 行(增删)、
  INPUT 首条消息(必填)、MAX TURNS(number,min 1,默认 10)、ASSERTIONS 列表(现有交互复用)。
  增删场景按钮与现有卡片一致。**无 turns/expected_response/expected_trajectory 字段。**
- R3 **round-trip**:`toSimDrafts(items)` 回显 actor_profile 项(traits 对象→行);
  `toSimItems(drafts)` 产出 devguide 形状 —— 可选字段仅在非空时输出
  (scenario_description/traits/assertions;max_turns 仅非默认 10 时输出,输出为 number)。
  编辑 simulated 数据集→保存→再回显,内容不变(后端 kind 校验通过)。
- R4 **混合数据集守卫**:kind=simulated 但 items 中存在无 actor_profile 的项
  (只可能来自 import)→ 表单编辑器降级为提示 note(建议用导入重建),隐藏保存按钮,
  避免静默丢数据。
- R5 **Prefill 类型感知**:USER SIMULATION 下 PREFILL 填充官方文档改编的双场景 persona 样例
  (含 traits/max_turns/assertions,风格与既有样例一致,可带双语注释)。
- R6 **提示**:sim 编辑器内 note 说明「运行时需选 ACTOR MODEL(LLM 扮演用户,goal 达成或
  max_turns 停止);assertions 即 ground truth」。how 面板 s1 文案补充 simulation 一笔(en+zh)。
- R7 **i18n**:新增键 en/zh-CN 同步(类型 chips、sim 字段标签、traits 增删、hint、混合守卫文案)。
- R8 **不改后端**;不改表格列(KIND 列已显示 simulated);运行页 actor model 选择已存在,不动。

## Acceptance Criteria

- [x] AC1 新建:选 USER SIMULATION → 编排 ≥1 个 persona 场景 → CREATE 成功,
  列表 KIND=simulated,New Run 中选中它会出现 ACTOR MODEL 下拉(既有逻辑,验证联动)。
- [x] AC2 编辑:打开 kind=simulated 的数据集 → 字段完整回显 → 修改后 SAVE 成功
  (不再触发 kind_immutable),再选中回显为修改后内容。
- [x] AC3 产出 items 与 devguide schema 逐字段一致(actor_profile 嵌套、可选字段省略语义、
  max_turns number);sync-to-aws 后 schemaType=SIMULATED_V1(fetch-stub 或真实 sync 验证)。
- [x] AC4 类型切换只在新建可见;编辑 predefined/legacy 数据集时行为与现状完全一致(回归)。
- [x] AC5 混合数据集(手工构造)→ 守卫 note,无保存入口。
- [x] AC6 build + eslint + locale 键对齐通过;浏览器截图:类型选择、sim 编辑器、编辑回显。

## Notes

- 参照:`frontend/src/pages/EvaluationDatasets.tsx`(上一任务已重构为 experiment 式交互;
  hydration 走 selKey+selRef 模式 —— 新增 sim 状态必须同样在该 effect 中重置)。
- 已知边界(不处理):`_has_ground_truth` 把 assertions 算作 GT → simulated 数据集会点亮
  GT chip 并解锁 Trajectory* evaluator(实际必 0 分)——后端既有行为,超出本任务范围。
- 本地已有 simulated 样例:cloud `HR_simulated_personas_sample`(只读);本地库若无,
  可用 prefill 新建后验证编辑回显。
