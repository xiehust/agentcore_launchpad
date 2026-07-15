# 环境搭建 / Setup

English: [setup.md](setup.md)

## 前置条件

- 已在 `us-west-2` 开启 Bedrock AgentCore 预览的 AWS 账号(Runtime、Harness、
  Registry、Gateway、Policy、Evaluation)
- 具备管理员级别权限的凭证(`aws sts get-caller-identity` 可用)
- `uv` ≥ 0.8、Node.js ≥ 20(`npm`)、AWS CDK CLI v2(`npm i -g aws-cdk`)、
  Docker(支持 ARM64,第 5 阶段容器路径需要)
- 每个账号/区域执行一次 CDK bootstrap:`cdk bootstrap aws://<account>/us-west-2`

## 引导(Bootstrap)

```bash
# 1. 安装依赖
cd backend  && uv sync && cd ..
cd frontend && npm install && cd ..
cd infra    && uv sync && cd ..

# 2. 部署共享基础设施 + AgentCore 单例,写出 config/launchpad.yaml
make bootstrap          # = cd backend && uv run python ../scripts/bootstrap.py
```

该引导是**幂等**的:CDK 栈(`launchpad-base`)仅在缺失时部署,AgentCore 注册表
(`launchpad-registry`)/ memory(`launchpad_memory`)只创建**一次**,后续每次运行
都复用。再次运行只会打印 `reused`,不会产生重复资源。

创建内容:

| 资源 | 名称 |
|---|---|
| S3 产物桶 | `launchpad-artifacts-<acct>-<region>` |
| ECR 仓库 | `launchpad-agents` |
| CodeBuild(ARM64) | `launchpad-agent-builder` |
| Cognito 用户池 | `launchpad-users`(+ 组 `platform-admin`、`hr-analyst`,演示用户 `river`/`demo`) |
| IAM 执行角色 | `launchpad-agent-execution-role` |
| AgentCore Registry | `launchpad-registry` |
| AgentCore Memory | `launchpad_memory`(短期事件 + 语义与用户偏好的长期策略) |

演示用户密码由 bootstrap 生成并存入 `config/launchpad.yaml`(**已 gitignore**——
视为本地机密;仓库中提交的是脱敏的 `config/launchpad.example.yaml`)。

## 本地运行

```bash
./start.py          # 后台开发模式
./start.py --prod   # 构建并运行本地生产预览
./stop.sh
```

需要绑定当前终端的前台开发栈时,使用 `make dev`。

## 资源清理

```bash
cd backend
uv run python ../scripts/teardown.py --dry-run   # 列出将被移除的内容
uv run python ../scripts/teardown.py --yes        # 删除(memory → registry → CDK stack)
```

删除是尽力而为、依赖方优先的;S3 桶自动清空,ECR 仓库随栈强制删除。更完整的
清理指南(演示资源 vs 共享基础设施)见 [teardown.zh-CN.md](teardown.zh-CN.md)。
