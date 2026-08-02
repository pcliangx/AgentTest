# Agent Squad HQ v0.2 UI/UX 设计说明

> 状态：设计基线已冻结，Design Gate 已关闭；生产 UI 尚未启动
>
> 更新日期：2026-08-02
>
> 关联：[PLAN-v0.2](./PLAN-v0.2.md) ·
> [ADR-0008](./adr/0008-project-first-agent-instances.md) ·
> [ADR-0009](./adr/0009-command-center-workspace-lifecycle.md) ·
> [ADR-0010](./adr/0010-feishu-integration-trust-boundaries.md) ·
> [ADR-0011](./adr/0011-ui-first-contract-driven-delivery.md) ·
> [ADR-0012](./adr/0012-enforced-execution-and-brokered-capabilities.md) ·
> [ADR-0013](./adr/0013-agent-squad-hq-product-identity.md) ·
> [领域词汇表](../CONTEXT.md)

## 1. 产品体验目标

Agent Squad HQ 不是三个固定 Provider pane，也不是无人值守的 Agent swarm。它是一个
**以 Project 为顶层的集成工作台与指挥中心**：用户在一个主窗口中创建、命名、配置、
观察和指挥多个 Agent，同时查看飞书任务、知识、权限请求、文件改动与 handoff。

正确心智模型：

```text
Agent Squad HQ
├─ Global Attention Center
├─ Global Connections / Provider Health
└─ Project
   ├─ Overview
   ├─ N Agent Instances
   │  ├─ Session / Run / PTY
   │  └─ Independent Worktree
   ├─ Tasks / Dispatches / Execution Results
   ├─ Knowledge / Resource Bindings
   ├─ Handoffs / Activity
   ├─ Workspace Layout (Split Tree → Panels → Tabs)
   └─ Project Settings
```

体验必须让用户始终回答五个问题：

1. 我现在在哪个 Project、哪个工作面和哪个 Agent？
2. 哪些 Agent 正在运行、排队或等待我？
3. 当前动作会影响视图、Run、worktree、飞书，还是永久数据？
4. Agent 当前被授权访问什么，哪些动作仍需我确认？
5. 我关闭、切换、退出或交接后，工作怎样被可靠恢复？

## 2. 已确认的产品原则

1. Project 是唯一顶层工作空间，Task 和 Agent 都属于 Project。
2. Agent Provider 与 Agent Instance 分离；同一 Provider 可创建多个命名实例。
3. Agent Instance、Run、Session、PTY、worktree、Tab 和 Panel 是不同对象。
4. 创建 Agent、切换 Project、外部任务变化和应用恢复都不会自动启动 Run。
5. 一个 Agent Instance 在单一主窗口中最多有一个打开 Tab。
6. Workspace 使用自由 split tree；Panel 数量不设硬上限，1–3 个是默认密度。
7. 关闭 Tab 不停止 Agent；关闭窗口不停止后台 Run；显式退出必须处理 handoff。
8. 用户在内嵌浏览器中按飞书原权限编辑；Agent 只按当前指令请求由受控
   Connector 代执行的官方 CLI CRUD 能力。
9. 浏览器身份、CLI 身份、Project 资源范围和 Run 授权严格分离。
10. 无法真正强制执行的权限不能显示为已启用；所选限制不可执行时默认阻止 Run。
11. 飞书是任务业务字段和知识内容的 truth；Agent Squad HQ 是派发、执行、结果、验证、
    handoff 与审计的 truth。
12. 危险操作必须明确、可预览、可审计；不可逆和高风险动作的二次确认不可绕过。

## 3. 对象关系与稳定身份

```text
Project 1 ── owns ── N Agent Instances
Agent Instance N ── uses ── 1 Agent Provider
Agent Instance 1 ── owns ── 1 Session + N Runs + 0..1 PTY
Agent Instance 1 ── owns ── 1 isolated Worktree (when writable)

Project 1 ── restores ── 1 Workspace Layout
Workspace Layout 1 ── root ── 0..1 Split Tree
Split Tree leaf ── references ── 1 Panel
Panel 1 ── contains ── N Agent Tabs
Agent Tab 1 ── opens ── 1 Agent Instance

External Task 1 ── receives ── N Dispatches
Dispatch 1 ── targets ── 1 Agent Instance
Dispatch 1 ── produces ── 0..N Runs + 0..1 Execution Result

Project N ── references ── 0..1 primary External Connection (v0.2)
Project 1 ── owns ── N Resource Bindings
```

UI、URL、IPC 和持久化内部使用稳定 `ProjectId`、`AgentInstanceId`、`RunId`、
`DispatchId`、`HandoffId` 与 `ConnectionId`。Agent Name 只负责显示和用户路由；
Provider 名称、数组下标、TabId、PanelId 和路径都不能代替实例身份。

## 4. 单窗口信息架构

v0.2 只有一个主窗口，不支持把 Tab 拖成系统窗口。登录和危险确认可以使用模态窗口。

### 4.1 全局层

- Project switcher 与最近项目；
- Global Attention Center；
- 跨 Project 运行、排队、完成与 Provider health；
- 全局飞书连接和全局设置；
- 关闭窗口、重新打开和显式退出入口。

### 4.2 Project 一级导航

顺序固定：

1. **Overview**：项目态势、最近活动、边界与待处理摘要；
2. **Agents**：Agent Directory 与 Panel/Tab 工作区；
3. **Tasks**：飞书任务、本地 Project Task、派发和执行结果；
4. **Knowledge**：飞书知识空间、文档和隔离浏览器；
5. **Handoffs**：规范交接记录、导入、导出和不完整状态；
6. **Project Activity**：Run、权限、工具、外部 CRUD、合并和生命周期审计；
7. **Settings**：General、Agent Defaults、Agent Instances、Integrations、
   Permissions、Storage。

一级导航下方显示当前工作面的上下文目录，例如 Agent Directory、任务清单、知识空间
或 handoff 列表。统一 Agent Picker 负责目标选择，不能为每个工作面发明不同派发器。

### 4.3 Project 落点

- 新建 Project 后进入 Overview；
- 已使用 Project 恢复上次 surface、split tree、Tab 位置、焦点和过滤器；
- App 重启恢复最后 Project；Project Root 丢失时进入最近项目列表并标记
  `Root unavailable`；未初始化 Git、未连飞书或单个 Provider 故障只降级相关能力；
- 切换 Project 保存当前视图，后台 Run 默认继续，不弹“停止后切换”阻断框；
- 全局运行状态和 Attention Item 始终可见，另提供“停止当前 Project 全部 Run”。

## 5. 已冻结的视觉组合

原型位于 [`docs/design`](./design/README.md)，只使用内存模拟状态，不连接真实 Agent、
飞书或 ProjectStore。原 A 版保留为历史输入；B 版通过 `?variant=A|B|C` 提供三个
结构差异明显的选择。

### 指挥中心

- **A — 双侧栏指挥台**：固定 Project 导航、上下文目录和工作区同时可见；
- **B — 运行雷达**：主画布优先，右侧常驻运行与注意态势；
- **C — 沉浸画布**：工作区最大化，Agent Directory 使用浮动 palette。

### Project Settings

- **A — 层级配置台**：设置目录、表单和待应用摘要并列；
- **B — 策略矩阵**：横向比较多个实例的有效配置与 Provider 能力；
- **C — 安全审阅**：围绕“下一次 Run 能否安全启动”组织设置。

2026-08-02 已冻结为以下唯一组合：

- 指挥中心以 **A 双侧栏指挥台**为常态骨架，**B 运行雷达**降为可展开的全局
  Attention/态势抽屉，**C 浮动 Agent Directory**仅用于 Focus 或窄窗口 palette；
- Settings 以 **A 层级配置台**为唯一完整编辑器，**B 策略矩阵**是实例有效配置比较
  视图，**C 安全审阅**是下一次 Run readiness 摘要。

B/C 不维护第二套导航或编辑逻辑。选中方案只作为生产 UI 输入；throwaway HTML 不能
直接迁入 renderer。后续视觉微调不得推翻本文件的领域、生命周期与安全原则。

## 6. Agents 工作面

### 6.1 Agent Directory

目录展示 Project 的全部 Agent Instance，不只展示已打开 Tab：

- 按名称、Provider、状态和最近活动搜索/过滤；
- 明确区分未打开、已打开、当前可见、运行、排队、需输入、失败、Terminal、
  Unavailable 和 Archived；
- 点击实例时，已有 Tab 则聚焦，否则在当前 focused Panel 打开；
- 可显式选择“当前 Panel”“新 Panel”或“后台打开”；
- 支持重命名、生成 handoff、停止、归档、导出和永久删除；
- Unavailable 实例只读显示历史、handoff、任务和文件变更，并提供“修复 Provider”。

Agent Name 是主标题，Provider 只作次级标签。名称在 Project 内大小写不敏感唯一。
重命名后新名称立即成为路由；旧名称输入只提示“已重命名为…”，不发送、不自动建立
alias。历史记录仍显示当时名称快照和稳定 ID。

### 6.2 New Agent

```text
New Agent
→ 只显示 Provider Doctor 完全通过的 Provider
→ 输入 Project 内唯一 Agent Name
→ 选择可继承的模型/打开位置/worktree 初始值
→ 预览实例级配置（不复制秘密）
→ 创建 Ready 实例与独立 worktree/session/runtime 槽位
→ 按选择打开 Tab 或留在后台
```

创建不启动 Run。用户发送首条消息或显式派发后才运行。Provider 创建后不可切换；
换 Provider 要新建目标实例、生成 handoff，再保留或归档旧实例。

### 6.3 Agent Tab 与 Agent View

Tab 至少显示 Agent Name、Provider 次级标识、运行状态、未读/需处理标记和关闭按钮。
Tab 内统一二级导航：

- **Chat**：结构化对话、明确目标的实例 composer；
- **Activity**：thinking、tool、usage、权限与 Run 生命周期；
- **Changes**：实例 worktree diff、验证、base drift 与合并入口；
- **Terminal**：显式 PTY 接管。

Agent Tab composer 只发送给当前实例。发送按钮的文案或 tooltip 必须表达“启动/继续
当前 Agent Run”，不能暗示广播。Terminal 处于活动状态时禁止 structured Run；
关闭 Tab 不关闭 PTY，重新打开恢复缓冲与尺寸。当实例已有 active Run 时，新指令
必须明确表示为“回复当前待输入 Run”或“加入该实例下一 Run 队列”，不得表现
为第二个同时活动 Run。

## 7. 自由 Split、Panel 与 Tab

### 7.1 布局语义

Workspace 使用递归 split tree，不使用固定三栏和二维 grid 作为 truth：

```text
Split(horizontal, 61%)
├─ Panel A
└─ Split(vertical, 52%)
   ├─ Panel B
   └─ Panel C
```

用户可以：

- 把 Tab 拖到其他 Panel 中部完成移动；
- 把 Tab 拖到 Panel 四个边缘创建对应方向分屏；
- 拖动分隔条自由调整比例；
- 从当前 Panel 显式向右或向下分割；
- 临时 Focus 一个 Panel，之后无损恢复原 split tree；
- 应用 Split 或 Analysis 预设作为布局快捷方式，而非新的布局模型。

### 7.2 不变量

1. 一个 Agent Instance 在整个主窗口中最多一个打开 Tab。
2. 一个 Tab 同时只属于一个 Panel，拖动只移动、不复制。
3. Panel 的 Tab strip 只显示属于该 Panel 的 Tabs。
4. 关闭 Tab 不停止 Run、PTY 或 Session。
5. 关闭最后一个 Tab 后移除空 Panel并让相邻节点填充；所有 Tab 均关闭时显示空工作区。
6. 关闭包含多个 Tab 的 Panel 前，先选择目标 Panel，不能隐式停止或删除 Agent。
7. Panel 数量为 N；1–3 是默认与验收密度，4+ 只提示，不阻断。
8. 每个 Panel 有最小尺寸；窗口不足时必须显式滚动、折叠或展示溢出，不压缩到不可用。
9. 1280×800 下应能管理至少 8 个 Agent，并清晰同时观察 3 个 Panel。
10. Layout reducer 不调用 Agent runtime、PTY、Git 或删除逻辑。

## 8. Overview、Tasks 与 Knowledge

### 8.1 Project Overview

Overview 展示：

- Agent 总数、运行数、排队数和 Needs Attention 数；
- 最近 Run、权限、外部 CRUD、handoff 和完成事件；
- Project root/Git、飞书主连接、资源范围、worktree 与 dirty handoff 摘要；
- “进入 Agent 工作区”“派发给 Agent”“处理 Attention”等一级动作。

Overview 不是每次进入 Project 的强制落点，也不替代具体工作面。

### 8.2 Tasks

飞书任务业务字段以飞书为 truth。Agent Squad HQ 显示 external ID、版本、同步状态、
Dispatch、独立执行结果和最终验收状态。

```text
选择任务
→ 点击“派发给 Agent”
→ Agent Picker 选择一个或多个具体实例
→ 展开 @@all 时显示明确目标列表
→ 预览指令、资源范围和队列位置
→ 用户确认
→ 每个目标创建独立 Dispatch/Run/worktree/result
→ 用户检查结果
→ 用户决定是否更新飞书任务业务状态
```

同一任务可以并行派给多个 Agent。某个 Run 成功只表示该 Dispatch 完成；飞书任务
最终完成必须由用户验收。v0.2 使用“执行结果”视图，不要求完整 Candidate 比较器。

外部任务更新只刷新投影或创建 Attention Item，绝不自动启动 Agent。Agent Squad HQ 本地
Task 可存在，发布到飞书必须显式操作并预览目标连接与清单。

### 8.3 Knowledge

Knowledge 主区域包含受控浏览器 chrome 和真实飞书页面容器：

- 用户沿用飞书账号权限正常查看和编辑；
- 仅允许受信任飞书域名，外链交给系统浏览器；
- 显示人工浏览器身份、连接状态和当前知识空间；
- Node integration 禁用，每个 ConnectionId 使用独立持久 partition，并与
  Agent/Connector 身份完全隔离；
- 离线缓存只读、带版本，并明确标记缓存时间；
- Agent CLI 写入成功后刷新页面投影/索引；失败则保留拟议修改和失败原因。

页面文案不得声称人工浏览器与 Connector “共享授权”或“共享 Cookie”。
可以提示两者身份一致或不一致，但要分别展示。Agent 只看到窄化 capability，
不看到凭据、profile 或原始 CLI argv。

## 9. 显式派发与多 Agent 协作

主要入口是统一 Agent Picker/chips：

- Agent Tab composer：只发送给当前 Agent；
- Overview、Task、Handoff 和命令面板：“派发给 Agent”；
- `@@<agent-name>`：高级语法，解析为可见 chips；
- `@@all`：展开当前 Project 的明确实例列表并确认；
- assistant 普通文本中的 `@@`：仅作为文本，不触发命令。

跨 Agent handoff 只允许同一 Project 直接执行。跨 Project 必须导出 packet、显示包含
内容并显式导入，生成新 Handoff 及 provenance；不能携带源凭据、session 或 worktree。

目标 Agent 不直接挂载或写入源 worktree。packet 可包含目标、摘要、任务/知识引用、
base commit、文件改动摘要、选定 diff/patch/产物和验证结果。

Handoff 的 canonical record 位于 ProjectStore，并以 `HandoffId` 引用。Markdown 可
查看、复制和导出；默认存于 Git 之外，用户显式开启后才同步到
`.agent-squad-hq/handoffs/<agent-name>/`。

## 10. Attention Center 与权限中心

Global Attention Center 聚合：

- permission-requested；
- needs-input、failed、interrupted、completed；
- handoff 生成失败或不完整；
- 飞书版本冲突、高风险 CRUD 和未同步修改；
- Project offline、Provider unavailable；
- 后台 Project 完成与系统通知。

点击 Item 深链到 Project、Agent、Run、Task、Knowledge 或 Handoff。处理后从待办列表
移除，但保留在 Project Activity/Audit；Attention Center 不成为新的顶层数据 truth。

Run 权限请求统一显示真实目标、范围、原因和有效策略，动作只有：拒绝、允许一次、
允许当前 Run。永久授权必须进入 Settings；超时默认拒绝。App 自己的飞书删除、批量、
成员和权限确认保持为独立的高风险确认，不能被 Agent 权限批准替代。

## 11. Project Settings

Settings 在同一主窗口内，保留 Project 导航和 Attention；支持返回先前 Agent Tab。
分区固定为：

1. **General**：名称、root、Git、落点、归档与永久删除；
2. **Agent Defaults**：Provider、模型、打开位置和 worktree 初始值；
3. **Agent Instances**：逐实例身份、模型、推理、Terminal、worktree、代理、环境和生命周期；
4. **Integrations**：主连接、资源绑定、浏览器身份与 CLI 身份；
5. **Permissions**：Provider/主机实际可执行的权限、确认与请求策略；
6. **Storage**：本地数据、滚动快照、导出、导入与恢复。

### 11.1 继承规则

可从 Project Defaults 继承：Provider 首选项、默认模型、创建后打开位置、worktree 模式。

不可继承：代理、凭据、Token、自定义环境变量和敏感值。实例间“复制配置”必须先预览
字段并排除秘密。Provider 不可变；模型可在 Provider 内调整。

### 11.2 生效规则

以下状态自动保存：

- split tree、比例、Tab 位置、活动 Tab、焦点；
- 当前 surface、过滤器、输入草稿；
- 已读/未读和 Inspector 展开状态。

以下设置先暂存，必须点击“应用”：

- Agent 名称、模型、权限、代理和环境变量；
- Project 资源范围和飞书同步方向；
- 并发、优先级策略和预算。

页面始终展示待应用摘要。点击应用后，Agent Name 和路由元数据立即生效；模型、权限、
代理、环境、资源范围和并发等运行配置只影响下一次 Run。当前 Run 使用启动时的脱敏
配置快照，不静默重启或改变权限。

### 11.3 有效权限

界面只展示能够由 adapter、protocol、sandbox、主机或 connector 真正强制的能力。
`worktree` 不得被描述成完整 sandbox。若用户要求的限制无法执行，默认阻止 Run；
用户必须显式改为受支持的更宽模式并再次确认，宽模式持续可见且进入审计。
Provider 原生 bypass/auto-approve 不能标记为“已强制”；最小 PermissionBroker
未就绪时，v0.2 真实 Run 不可启动。

## 12. 生命周期与恢复

### 12.1 Agent

```text
Create → Ready → Queued → Starting → Running → Finishing → Ready
                    ├─ Needs permission / Needs input
                    ├─ Failed / Cancelled / Interrupted
                    └─ Terminal takeover（与 structured Run 互斥）

Ready/... → Archived → Restored
Archived → Permanently deleted（危险确认）
Any retained state → Unavailable → Recovered in place
```

仅成功完成回合写入 SessionStore。失败、取消和中断仍完整写入 RunStore，允许查看和
重试，但不能承诺从失败点原生 resume。

### 12.2 Project

Project 不使用单一状态枚举混合下列维度：

- **Lifecycle**：`Active` 或 `Archived`；归档后禁止新 Run/外部写入，数据可恢复；
- **Root availability**：`Available` 或 `Unavailable`；只在 Project Root 丢失或不可访问时
  使用 `Unavailable`；
- **Repository readiness**：`Ready` 或 `Not ready`；非 Git Project 仍可用 Tasks/
  Knowledge，但不能创建可运行 Agent；
- **Activity**：`Idle` 或 `Active`，由 active Run/PTY 派生；
- **Attention**：独立计数/列表，可与任何上述状态同时存在。

单个 Provider、Agent Instance 或可选飞书连接不可用只会降级对应能力并创建
Attention Item，不会改变 Project Root availability。

Project 归档前需等待或停止活动 Run 并生成 handoff。永久删除只处理本地数据，不删除
飞书资源或全局连接；脏 worktree 必须选择保留、导出 patch 或明确丢弃。

### 12.3 关闭窗口与退出应用

- 关闭主窗口：应用继续运行，后台 Run/PTY 继续，系统通知可用；
- 重新打开：恢复同一窗口、Project、surface 和布局；
- 显式退出：处理活动 Run，然后为 handoff-dirty Agent 生成最终 handoff；
- handoff 超时/失败：应用生成确定性快照，标记“不完整”，仍允许强制退出；
- crash/强制退出：Run 标记 `Interrupted`，不能伪装为成功；
- Electron main 退出后不得遗留未管理子进程，v0.2 不引入 daemon。

## 13. Worktree、漂移与合并 UX

每个可写 Agent 默认使用独立 worktree，永不共享可写 cwd。共享只读目录只有 Provider
和主机能真正强制时才可选；提示词中的“不要写”不能标为只读。

```text
Changes → 查看 diff 与 validation
→ 检查 base drift
├─ 无 drift：二次确认 → ff-only 合并
└─ 有 drift：Needs rebase，base 保持不变
   → 在实例 worktree 显式更新
   → Agent 或用户在隔离 worktree 解决冲突
   → 重跑验证
   → 再次二次确认 → ff-only 合并
```

不允许静默 rebase、自动解决 conflict 或 force merge。

## 14. 确认层级

不可关闭的二次确认：

- 合并 worktree 到 base；
- 永久删除 session、handoff、worktree 或 Project；
- 丢弃脏改动；
- 飞书删除、批量、成员和权限变化；
- 凭据显示、导出或转移；
- force、overwrite 和其他不可逆动作。

可由 Project 配置的确认：停止/重启、飞书普通创建/单条更新、非敏感网络或外部工具。

无需确认：关闭 Tab、读取数据、在独立 worktree 中的普通写入。无需确认不等于无需
审计；所有 Run、外部 CRUD 和权限动作仍进入 Activity/RunStore。

## 15. 可访问性、尺寸与反馈

- 状态不能只依赖颜色，必须同时提供文本、图标或可访问名称；
- Tab、Panel、Agent Picker、Attention 和设置导航支持键盘与清晰焦点；
- 拖放必须提供菜单/快捷键等非指针替代操作；
- 1280×800 为最低验收尺寸，Panel 最小宽高与溢出策略必须可测试；
- 危险动作与日常动作不能共享无说明图标；
- 后台完成、权限请求、冲突和失败提供系统通知，但通知内容默认避免敏感正文；
- Loading、empty、offline、unavailable、queued 和 interrupted 都有独立可操作文案。

## 16. 设计门禁与验收

### 已确认

- [x] Project-first 与 N 个命名 Agent Instance；
- [x] 集成工作台/指挥中心定位，Tasks 与 Knowledge 进入 v0.2；
- [x] 单主窗口和固定 Project 一级导航；
- [x] 自由 split tree、N Panel、Panel 内多 Tab、实例 Tab 唯一；
- [x] 显式执行、后台 Project、关闭窗口与退出 handoff；
- [x] Provider Doctor、实例不可用、归档与永久删除；
- [x] 独立 worktree、权限强制、漂移与 ff-only 合并；
- [x] 飞书浏览器/CLI 身份隔离、Project scope、CRUD 与冲突规则；
- [x] 自动保存与显式应用边界；
- [x] 设计冻结后先实现生产 UI 与 mock 契约。

### 视觉冻结

- [x] 指挥中心选择 A 主骨架 + B 态势抽屉 + C Focus/窄窗口 palette；
- [x] Settings 选择 A 完整编辑器 + B 比较视图 + C readiness 摘要；
- [x] 1280×800 自动 Electron 冒烟确认 3 Panel、4+ Panel 溢出、Attention、Dispatch、
  Settings draft/apply/discard 与六个变体可操作；
- [x] 选型和最小 UI contract 已记录到
  [Phase 1 spec](../.scratch/ui-first-command-center/spec.md) 与 tickets；
- [x] 用户于 2026-08-02 明确接受推荐，Design Gate 关闭。

下一阶段是生产 UI 与契约化 Mock，但本轮尚未启动。Phase 1 仍不实现真实
ProjectStore、Agent runtime、PermissionBroker、飞书登录/CRUD 或其他外部副作用。
