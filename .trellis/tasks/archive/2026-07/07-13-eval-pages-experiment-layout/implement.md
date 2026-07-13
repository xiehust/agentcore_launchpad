# Implementation Plan — Evaluators/Datasets Experiment-style interaction

前置:参照 `frontend/src/pages/EvaluationExperiment.tsx` 的 表格 + `?exp=` 选中 + 详情/how 双栏模式。
纯前端改动,不动后端与 Evaluation.tsx 的 `?view=` 分发。

## Checklist

1. [x] **EvaluationEvaluators.tsx 重构**
   - `useSearchParams` 读写 `ev` 参数(保留 `view=evaluators`);selected = find(ev) ?? custom[0] ?? null。
   - 顶部 Panel(brk, pad=false)表格:NAME/LEVEL/SOURCE/GT/STATUS,行 testid `evaluator-row-<id>`,
     `+ 新建`(`new-evaluator-btn`)→ `ev=new`。
   - 下方 eval-grid:左 = 新建表单 | custom 编辑表单(Delete 在面板头 end)| builtin 只读详情
     (GET detail,失败降级);右 = how 说明面板。
   - 行切换时重置 draft/formError(useEffect on selected id)。
2. [x] **EvaluationDatasets.tsx 重构**
   - `ds` 参数;cloud-only 行 `ds=cloud:<id>`;selected = find(ds) ?? local[0] ?? null。
   - 顶部合并表格:NAME/ITEMS/KIND/GT/CLOUD;cloud-only 行 ☁ 前缀。
   - 左面板:本地 = 场景编辑器 + Sync/Delete(面板头 end,sync 保留 `sync-<name>` testid);
     cloud-only = 只读详情 + Delete;`ds=new` = form/import 双模式新建表单。
   - 行切换重置编辑器状态。
3. [x] **i18n**:en + zh-CN 同步新增表头/how 面板/只读详情键(`evalPage.evaluators.*`、`evalPage.datasets.*`)。
4. [x] **质量检查**
   - `cd frontend && npx tsc -b && npx vite build`(或 `npm run build`)。
   - `npx eslint src/pages/EvaluationEvaluators.tsx src/pages/EvaluationDatasets.tsx`。
   - locale 键一致性:en/zh-CN diff 检查无缺键。
5. [x] **浏览器验证(AC7)**(截图:design/screenshots/eval-pages/ ×8;真实后端走通 evaluator create/save/delete、dataset form+import 创建/保存/删除、真实 sync→云副本 ACTIVE→UI 云删除、AC5 草稿泄漏、深链+后退)
   - 确认 vite 端口(5173/5174 浮动,见 memory),agent-browser 打开两个子页面。
   - 走查:行选中高亮、URL 参数、新建/编辑/只读三态、后退回退;截图存证。
6. [x] **收尾**:spec 更新(新增 launchpad/evaluation-subpage-interaction.md + 索引行)、commit。

## Validation Commands

```bash
cd frontend && npm run build
cd frontend && npx eslint src/pages/EvaluationEvaluators.tsx src/pages/EvaluationDatasets.tsx
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

单次改动全部在 frontend 两个页面 + locale 文件;`git checkout -- frontend/` 即可回滚。
