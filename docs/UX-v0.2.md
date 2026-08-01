# AgentTest v0.2 UI/UX 设计说明

> 状态：Project-first 方向设计中；生产功能开发暂停
>
> 关联：[PLAN-v0.2](./PLAN-v0.2.md) ·
> [ADR-0008](./adr/0008-project-first-agent-instances.md) ·
> [领域词汇表](../CONTEXT.md)
>
> 设计门禁：用户确认 Project、Agent Tab 与 Panel 的管理方式后，才恢复生产开发。

## 1. 本轮设计问题

AgentTest 不是三个固定 Agent pane，也不是以 Task 为顶层的候选比较器。正确的用户
心智模型是：

```text
用户
└─ Project
   ├─ Agent Instance: cc_data      → Claude Code
   ├─ Agent Instance: cc_sql       → Claude Code
   ├─ Agent Instance: cx_anti      → Codex
   ├─ Agent Instance: cx_forecast  → Codex
   └─ Agent Instance: kimi_Visual  → Kimi Code
```

本轮原型回答：

> 用户如何在一个 Project 中创建、命名、打开和同时观察任意数量的 Agent
> Instance，并用 Tab 与 Panel 管理有限的屏幕空间？

原型只验证信息架构和工作区操作，不连接真实 Agent、PTY、worktree 或 Git。

## 2. 核心对象关系

```text
Project 1 ── owns ── N Agent Instances
Agent Instance N ── uses ── 1 Agent Provider
Project 1 ── restores ── 1 Workspace Layout
Workspace Layout 1 ── contains ── N Panels
Panel 1 ── contains ── N Agent Tabs
Panel 1 ── displays ── 1 active Agent Tab
Agent Tab 1 ── opens ── 1 Agent Instance
```

关键约束：

- Provider 是 Claude Code、Codex、Kimi Code 等能力来源，不是工作区槽位；
- 同一 Provider 可创建多个 Agent Instance；
- Agent Name 在所属 Project 内唯一，是用户看到和路由时使用的名称；
- Agent Instance 持久存在，不依赖 Tab 是否打开或 CLI 进程是否正在运行；
- 一个 Agent Instance 在基线设计中最多打开一个 Tab；再次打开时定位已有 Tab；
- Tab 可在 Panel 之间移动；Panel 可横向或纵向拆分；
- 关闭 Tab 只隐藏视图，停止 Agent 只停止运行，删除 Agent 才移除实例和相关数据。

## 3. 示例项目

所有原型使用同一组数据，避免视觉风格掩盖结构问题。

### Project

- 名称：销售数据分析
- 工作目录：`~/Projects/sales-analysis`
- 当前布局：分析工作台
- Agent 数量：5

### Agent Instances

| Agent Name | Provider | 状态 | 当前工作 |
| --- | --- | --- | --- |
| `cc_data` | Claude Code | 运行中 | 清洗 Q2 销售流水 |
| `cc_sql` | Claude Code | 就绪 | 等待 SQL schema 指令 |
| `cx_anti` | Codex | 需要输入 | 检查异常值处理策略 |
| `cx_forecast` | Codex | 已完成 | 生成季度预测模型 |
| `kimi_Visual` | Kimi Code | 运行中 | 绘制区域销售趋势 |

可见布局：

```text
Panel 1: [cc_data] [cc_sql]       → cc_data active
Panel 2: [cx_anti] [cx_forecast]  → cx_anti active
Panel 3: [kimi_Visual]            → kimi_Visual active
```

## 4. 信息架构

```text
Projects
└─ Project
   ├─ Project Overview
   ├─ Agent Directory
   │  └─ Agent Instance
   │     ├─ Chat
   │     ├─ Activity / Tools
   │     ├─ Changes
   │     └─ Terminal
   ├─ Workspace
   │  ├─ Layouts
   │  ├─ Panels
   │  └─ Agent Tabs
   ├─ Handoffs
   └─ Project Settings
```

### 全局层

- Project 切换器；
- 新建、打开、归档 Project；
- CLI Provider 健康状态；
- 全局设置。

### Project 层

- Project 名称、目录、Git 状态；
- Agent Directory 与“新建 Agent”；
- 当前 Workspace Layout；
- Project 范围的路由和 Handoff 历史。

### Agent 层

- Agent Name 与 Provider；
- 会话、状态和当前活动；
- Chat / Activity / Changes / Terminal 视图；
- 重命名、停止、重启、关闭 Tab、删除 Agent。

## 5. 页面与组件

### 5.1 Project Home

用户启动 App 后首先看到 Project，而不是三个 Agent：

- 最近 Project；
- 每个 Project 的 Agent 数、运行数、需处理数和最后打开时间；
- 创建 Project / 打开已有目录；
- Provider Doctor 摘要。

进入 Project 后恢复它上次保存的 Tabs、Panels 和活动 Agent。

### 5.2 New Agent

“新建 Agent”是 Project 内一级动作，流程为：

```text
选择 Provider
→ 输入项目内唯一 Agent Name
→ 可选模型/启动配置
→ 选择打开位置（当前 Panel / 新 Panel / 后台）
→ 创建并启动
```

名称示例使用工作职责而非厂商，例如 `cc_data`、`cx_anti`、`kimi_Visual`。如果
重名，创建前直接提示，不在创建后自动追加不可预测的编号。

### 5.3 Agent Directory

目录包含 Project 的全部 Agent Instance，不只包含已打开 Tab：

- 支持按名称、Provider、状态过滤；
- 点击实例：若已有 Tab 则聚焦，否则在当前 Panel 打开；
- 明确区分“未打开”“已打开”“当前可见”；
- 支持重命名、打开到新 Panel、停止和删除。

### 5.4 Agent Tab

Tab 至少显示：

- Agent Name；
- Provider 辅助标识；
- 运行/需输入/失败等状态；
- 未读或需要用户处理提示；
- 关闭按钮。

Tab 不用 Provider 名称代替 Agent Name。多个同类实例必须能一眼区分。

### 5.5 Panel

Panel 包含本地 Tab strip、一个活动 Agent 视图和 Panel 操作：

- 在右侧拆分、在下方拆分；
- 移动当前 Tab 到其他 Panel；
- 关闭 Panel；
- 最大化当前 Panel；
- 返回之前的布局。

关闭带多个 Tab 的 Panel 时，必须先选择把 Tabs 移到哪个 Panel；不能隐式停止或
删除 Agent。

### 5.6 Agent View

每个 Agent Tab 内部使用一致的二级导航：

- Chat：结构化对话与输入；
- Activity：thinking、tool、usage、运行状态；
- Changes：worktree diff、验证与应用入口；
- Terminal：显式 PTY 接管。

输入栏属于 Agent，不设置一个含义模糊的全局输入栏。Project 级多目标派发若保留，
使用独立的 Composer，并明确显示目标实例，例如 `@@cc_data @@cx_anti`。

## 6. 关键流程

### Flow A：创建项目与多个 Agent

```text
新建 Project“销售数据分析”
→ 选择工作目录
→ 新建 Claude Code Agent，命名 cc_data
→ 新建 Codex Agent，命名 cx_anti
→ 新建 Kimi Code Agent，命名 kimi_Visual
→ 三个实例出现在 Agent Directory
```

### Flow B：用 Tab 工作

```text
点击 cc_data
→ 在当前 Panel 打开 cc_data Tab
→ 点击 cx_anti
→ 同一 Panel 新增 Tab 并切换
→ 再点 cc_data
→ 聚焦已有 Tab，不创建重复视图
```

### Flow C：用 Panel 同时观察

```text
在 cx_anti Tab 选择“拆分到右侧”
→ 创建 Panel 2 并移动 cx_anti
→ 从 Agent Directory 把 kimi_Visual 打开到下方 Panel
→ 同时看到三个 Agent
```

### Flow D：关闭、停止与删除

```text
关闭 cc_data Tab
→ 会话仍保留在 Agent Directory
→ 重新打开后恢复原上下文

停止 cc_data
→ Tab 仍打开并显示 stopped

删除 cc_data
→ 展示会话/worktree 影响
→ 二次确认后才删除实例
```

### Flow E：跨 Agent 协作

```text
在 cc_data 中选择“交给另一个 Agent”
→ 目标选择 cx_anti
→ 检查 Handoff 内容
→ cx_anti Tab 显示待处理标记
→ 用户打开或聚焦 cx_anti
```

Handoff 在实例之间发生，不在 Provider 之间发生。

## 7. 状态模型

### Project

- Ready：可进入；
- Active：至少一个 Agent 运行；
- Needs attention：至少一个 Agent 等待输入或失败；
- Offline：目录不可用；
- Archived：用户归档。

### Agent Instance

- Created：已创建，尚未启动；
- Starting；
- Ready：会话可用、当前没有运行；
- Running；
- Needs input；
- Stopping；
- Stopped；
- Failed；
- Unavailable：Provider 或工作目录不可用。

### Agent Tab

- Closed：实例存在但没有 Tab；
- Open：存在于某个 Panel；
- Active：当前 Panel 正在展示；
- Attention：有未读结果、权限请求或错误。

### Panel

- Normal；
- Focused；
- Maximized；
- Empty：只作为拖放目标短暂存在，不长期保存。

颜色只用于辅助，名称、文本状态和动作必须同时存在。

## 8. Tab 与 Panel 交互规则

1. 点击 Agent Directory 的实例时优先聚焦已有 Tab。
2. 新 Tab 默认进入当前 Focused Panel。
3. 拖动 Tab 到 Panel 中部表示移动；拖到边缘表示新建分屏。
4. Panel 的 Tab strip 只显示属于该 Panel 的 Tabs。
5. 关闭 Tab 不停止 Agent；停止 Agent 不关闭 Tab。
6. 关闭最后一个 Tab 后自动移除空 Panel，并让相邻 Panel 填充空间。
7. 切换 Project 时保存当前 Layout，目标 Project 恢复自己的 Layout。
8. Agent Name 在 UI 中为主标题，Provider 只作图标或次级标签。
9. 危险的“删除 Agent”和日常的“关闭 Tab”不能放在同一个无说明的图标动作中。
10. 1280×800 下默认最多同时展示三个 Panel；更多 Agent 通过 Tabs 管理。

## 9. 设计门禁

UI/UX 设计在外部完成。恢复生产开发前必须确认：

- [x] 确认 Project 是顶层对象；
- [x] 确认 Project 内可有任意数量、可命名 Agent Instance；
- [x] 区分 Agent Provider 与 Agent Instance；
- [x] 定义 Agent Tab 与 Panel 的基础语义；
- [ ] 确认 Project/Agent Directory、New Agent、Tab 移动与 Panel 拆分流程；
- [ ] 确认关闭 Tab、停止和删除的文案与危险级别；
- [ ] 确认项目切换和布局恢复方式；
- [ ] 将最终选择同步到 PLAN-v0.2。
