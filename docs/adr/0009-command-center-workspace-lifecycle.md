# ADR-0009：指挥中心工作区与显式执行生命周期

- 状态：已接受（Accepted）
- 日期：2026-08-02
- 关联：[ADR-0007](./0007-structured-chat-pty-terminal.md)、
  [ADR-0008](./0008-project-first-agent-instances.md)、
  [ADR-0012](./0012-enforced-execution-and-brokered-capabilities.md)、
  [UX-v0.2](../UX-v0.2.md)、[PLAN-v0.2](../PLAN-v0.2.md)

## 背景（Context）

ADR-0008 已确定 Project-first、N 个命名 Agent Instance 以及 Tab/Panel 工作区，
但没有定义集成工作台的信息架构、自由分屏模型、后台运行、退出、归档、handoff、
队列和配置生效边界。原 A 版原型还把三 Panel 当作近似上限，并在 Project 切换时
要求用户决定是否停止运行，这与“指挥中心持续观察多个 Project”的目标不一致。

## 决策（Decision）

### 指挥中心信息架构

Agent Squad HQ 使用单一主窗口。Project 内固定一级导航为：

1. Project Overview；
2. Agents；
3. Tasks；
4. Knowledge；
5. Handoffs；
6. Project Activity；
7. Project Settings。

全局层提供 Project 切换、Attention Center、Provider health 和全局设置。一级导航
下方可以出现与当前 surface 对应的上下文目录，例如 Agent Directory、任务清单、
知识空间和 handoff 列表。Project Settings 仍在主窗口内；只有登录和危险确认使用
模态窗口。

新 Project 进入 Overview；使用过的 Project 恢复上次 surface、Panel/Tab 布局与
焦点。应用重启恢复最后 Project；路径不可用时回退到最近项目列表。

### Workspace Layout

Workspace Layout 的 truth 是可递归的 split tree：内部节点记录横向或纵向分割及
比例，叶节点引用 Panel。Panel 包含本地 Tab strip、活动 Tab 和可拖动分隔条。

- 支持 N 个 Panel；1–3 个是默认密度和发布验收基线，不是硬上限；
- 第 4 个及更多 Panel 只显示非阻断提示；
- Panel 有最小尺寸，空间不足时使用滚动、折叠或明确的溢出处理；
- Focus 是临时最大化；Split 是快捷操作；Analysis 是“一主两辅”预设；
- Tab 可拖到任意 Panel，或拖到边缘创建新分屏；
- 一个 Agent Instance 在整个主窗口中最多一个打开的 Tab，拖动表示移动而非复制；
- 关闭最后一个 Tab 后移除空 Panel；整个工作区没有 Tab 时显示空工作区；
- 切换 Project、移动 Tab、分割比例、焦点和 surface 自动保存到 ProjectStore。

镜像视图和多主窗口不属于 v0.2。

### 显式执行与并发

创建 Agent Instance 只生成 `Ready` 实例、独立 worktree/session/runtime 槽位并按
用户选择打开 Tab，不自动启动 Run。只有以下用户动作可启动 Run：

- Agent Tab 中发送消息；
- Overview、Task 或命令面板中的“派发给 Agent”；
- 用户确认后的 Handoff 导入与执行。

用户动作是必要条件但不是充分条件；真实 Run 还必须通过 ADR-0012 定义的 Provider
Doctor 与最小 PermissionBroker 门禁。

外部任务或知识变化、assistant 普通文本、应用恢复和数据导入都不能自动启动 Agent。
`@@` 仅作为高级用户输入语法，解析后必须转换为可见目标 chips；`@@all` 展开为当前
Project 的明确实例列表并确认。assistant 输出中的 `@@` 永不触发派发。

同一 Agent Instance 最多一个 structured Run。Project 默认最多 3 个、全局默认
最多 6 个活动 Run；超出后进入可见队列，支持重排、取消和优先级。Terminal PTY
占用该实例的执行槽并与 structured Run 互斥。调整并发或预算需显式应用并显示资源/
成本提示。

### 后台、退出与 handoff

- 切换 Project 不停止后台 Run，也不弹阻断确认；全局 Attention Center 显示运行与
  待处理状态。用户可以显式停止当前 Project 的全部 Run。
- 关闭主窗口不停止 Run；应用继续驻留并发送系统通知。v0.2 不引入独立 daemon，
  Electron main 退出时不能遗留未管理子进程。
- 显式“退出 Agent Squad HQ”时，活动 Run 先由用户选择等待或停止，然后对所有
  handoff-dirty Agent 请求最终结构化 handoff。超时或失败时，应用根据最后成功回合、
  当前任务、文件改动、验证结果和失败原因生成确定性快照并标记“不完整”；保留强制
  退出入口。
- Handoff 的规范记录位于 ProjectStore，以
  `(projectId, agentInstanceId, handoffId)` 标识；Markdown 只是查看、复制、导出或
  可选 repo 同步格式。默认保存在 Git 之外；用户显式开启后可同步到
  `.agent-squad-hq/handoffs/<agent-name>/`，但引用仍使用稳定 handoffId。
- 只有发生成功回合、脏 worktree、运行/失败/中断/待确认、未同步任务或人工标记的
  Agent 才是 handoff-dirty；其他实例复用上一次 handoff。

关闭 Agent Tab 不结束 PTY。PTY 属于实例，重新打开 Tab 恢复终端缓冲和尺寸；只有
显式“结束 Terminal 接管”才释放实例执行槽。

### 归档、删除与不可用

Agent 和 Project 都采用先归档、后永久删除：

- 归档前处理活动 Run 并生成 handoff，之后禁止新 Run 和外部写入；
- 归档保留 session、Run、handoff、task binding、worktree 和历史，可恢复；
- 永久删除必须展示影响并二次确认；脏 worktree 必须选择保留、导出 patch 或丢弃；
- Project 永久删除只处理 Agent Squad HQ 本地数据，不级联删除飞书资源或全局连接；
- 默认不设置自动过期清理。

Provider 在实例创建后不可变。更换 Provider 必须创建新实例并 handoff。Provider
Doctor 未完全通过时不能创建或配置该 Provider 的新实例；已有实例变为
`Unavailable`，保留只读历史，可修复后原位恢复，不能自动替换或清空。

Project 可以在非 Git 目录中管理任务、知识和 Project 上下文，但首次创建可运行
Agent 前必须显式初始化 Git 或选择 Git 仓库；v0.2 不提供复制目录作为写入隔离的
降级方案。Project root 不是普通可编辑字段，只能在无活动 Run 且验证为同一 Git
仓库后显式重新定位。

### 自动保存与显式应用

以下 UI 状态自动保存：split tree、比例、Tab 位置与焦点、当前 surface、过滤器、
输入草稿、已读状态和 Inspector 展开状态。

以下配置必须先暂存，再由用户点击“应用”：Agent 名称、模型、权限、代理、环境变量、
Project 资源授权、飞书同步方向、并发和预算。应用后，Agent 名称与路由元数据立即
生效；模型、权限、环境等运行配置只影响下一次 Run。活动 Run 不会被静默重启或改变
配置。每个 Run 保存脱敏的有效配置快照。

## 后果（Consequences）

- renderer 必须把 Layout reducer、业务状态和 runtime 生命周期分离；布局命令不能
  隐式调用 stop/delete。
- ProjectStore 需要版本化保存 split tree、Tab 唯一性、surface、配置草稿和应用
  版本；RunStore 需要队列、失败/取消/中断和有效配置快照。
- Electron 生命周期必须区分 close-window 与 quit-app，并统一管理结构化进程、PTY、
  handoff 和 crash recovery。
- Attention Center 成为跨 Project 的操作入口，但不取代 Project 层级。
- 自由布局、后台运行和退出 handoff 增加状态空间，必须用纯状态转换、迁移测试和
  Electron GUI checklist 验证。
