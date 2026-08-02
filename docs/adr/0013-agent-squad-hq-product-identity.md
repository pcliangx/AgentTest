# ADR-0013：Agent Squad HQ 产品身份与兼容迁移

- 状态：已接受（Accepted）
- 日期：2026-08-02
- 关联：[ADR-0009](./0009-command-center-workspace-lifecycle.md)、
  [ADR-0011](./0011-ui-first-contract-driven-delivery.md)、
  [PLAN-v0.2](../PLAN-v0.2.md)

## 背景（Context）

项目早期名称仅用于验证多 Provider 通信，不能表达已经冻结的 Project-first 集成工作台
与指挥中心定位。Phase 1 生产 UI 尚未启动，此时统一产品身份可以避免把临时名称写入
新的视觉基线、持久化目录、协议标识、GitHub Issues 和发布产物。

名称变化同时影响 Electron 的应用名与默认 `userData` 路径。直接替换包名会让已有
session、设置、worktree 元数据和 Chromium 数据看起来消失，因此产品显示名和稳定
技术标识必须分离，并提供启动前兼容迁移。

## 决策（Decision）

### 统一身份

- 正式产品名为 **Agent Squad HQ**；`HQ` 是名称的一部分，对外文案不得缩写为
  “Agent Squad”。
- 产品描述为“本地优先的多 Agent 集成工作台与指挥中心”。
- 稳定技术 slug 为 `agent-squad-hq`；TypeScript 名称使用 `AgentSquadHQ`，环境变量
  使用 `AGENT_SQUAD_HQ_*`，App ID 使用 `com.pcliangx.agentsquadhq`。
- npm 私有包名为 `@pcliangx/agent-squad-hq`，GitHub 仓库名为
  `pcliangx/agent-squad-hq`。
- 新 handoff 可选同步路径为 `.agent-squad-hq/handoffs/<agent-name>/`；稳定
  `HandoffId` 仍是身份 truth。

### 本地数据与兼容

- Electron 启动进入 `ready` 之前，将 `userData` 和 `sessionData` 固定到
  `<appData>/agent-squad-hq`，不再由显示名推导。
- 若新目录不存在而旧 `agenttest` 目录存在，先复制到同文件系统临时目录，再原子
  切换为新目录；旧目录保留作为恢复来源。
- linked Git worktrees 不参与目录复制：复制它们会让两份工作目录共享同一 Git
  administrative metadata。旧 worktrees 原地保留供检查或人工恢复，新身份下从已选
  base repository 重新创建；不得借改名静默删除 dirty worktree。
- 若新目录已经存在，绝不以旧数据覆盖；若迁移失败，本次启动继续使用旧目录并明确
  记录警告。
- 新环境变量优先；仅在新变量不存在时兼容 `AGENTTEST_E2E` 与
  `AGENTTEST_BASE_REPO`。移除旧别名必须另行记录并提供发布说明。
- 既有 Git branch、commit、clone 目录和历史 Git 内容不自动改写；只有新建技术标识
  使用 `agent-squad-hq`。

### 文档、UI 与 GitHub

- 当前代码、活动文档、设计原型、开放 Issues 和用户文案统一使用完整名称。
- Git 历史保持不变；兼容代码和本 ADR 可以保留旧标识，以说明迁移来源。
- 仓库改名后更新本地 remote 和规范链接，并复核 GitHub 原生 issue dependencies；
  不重新创建旧仓库名，以免破坏重定向。
- 本次身份迁移是 Phase 1 的前置工作，只更新品牌基线，不重新打开 Design Gate，也不
  自动启动生产 UI。

## 后果（Consequences）

- 新 UI、日志、协议 clientInfo、临时目录、worktree 分支和自动提交身份使用同一技术
  slug，搜索与排障不再混用名称。
- 启动迁移会暂时保留两份本地数据，占用额外磁盘；旧目录清理由 Phase 7 的备份与恢复
  流程处理，不能静默删除。
- “Agent Squad”已有同类产品和开源项目；`HQ` 必须始终保留，公开商业发布前仍需完成
  目标市场商标、域名和应用商店清查。
