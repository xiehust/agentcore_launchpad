# Implementation Plan — user simulation dataset type

纯前端:`frontend/src/pages/EvaluationDatasets.tsx` + en/zh locale。后端零改动。

## Checklist

1. [x] **draft 模型与转换**:`SimScenarioDraft`(scenario_id/scenario_description/context/goal/
   traits 行数组/input/max_turns/assertions)+ `toSimDrafts`/`toSimItems`(devguide 形状,
   可选字段非空才输出,max_turns≠10 才输出且为 number)+ `emptySimScenario`/`SIM_SAMPLE`。
2. [x] **编辑器状态**:`scenarioType`("predefined"|"simulated",新建可切、编辑由 kind 派生)、
   `simScenarios` 状态;selKey hydration effect 同步重置/回显(kind=simulated → toSimDrafts);
   混合数据集守卫(simulated 但含非 actor 项 → note + 隐藏保存)。
3. [x] **UI**:类型 selchips(仅新建 form 模式)、sim 场景卡片编辑器(traits 增删行、
   max_turns number、assertions 复用)、类型感知 Prefill、actor-model 运行提示 note、
   how.s1 文案补 simulation。
4. [x] **save()**:simulated 分支走 toSimItems;创建/编辑路径与现状一致。
5. [x] **i18n**:en/zh-CN 新键同步。
6. [x] **质量检查**:`cd frontend && npm run build`、eslint 该文件、locale parity 脚本。
7. [x] **浏览器验证(AC1-AC6)**:真实后端建 sim 数据集→New Run 联动 ACTOR MODEL→编辑回显→
   保存→(可选真实 sync 验 SIMULATED_V1)→删除清理;混合守卫用手工 PUT 构造;截图存证。
8. [x] **收尾**:spec 补充、commit。

## Validation Commands

```bash
cd frontend && npm run build
cd frontend && npx eslint src/pages/EvaluationDatasets.tsx
python3 - <<'EOF'
import json
en=json.load(open('frontend/src/locales/en/common.json'))
zh=json.load(open('frontend/src/locales/zh-CN/common.json'))
def keys(d,p=''):
    for k,v in d.items():
        if isinstance(v,dict): yield from keys(v,f'{p}{k}.')
        else: yield f'{p}{k}'
ke,kz=set(keys(en)),set(keys(zh))
print('en-only:',sorted(ke-kz)); print('zh-only:',sorted(kz-ke))
EOF
```

## Rollback

改动仅 EvaluationDatasets.tsx + 两个 locale 文件;`git checkout -- frontend/` 回滚。
