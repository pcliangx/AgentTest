# AgentTest 工作台

AgentTest 是一个以项目为边界、由用户组织多个本地编码 Agent 协作的桌面工作台。
本词汇表定义产品对象，避免把 CLI 厂商、Agent 实例和界面容器混为一谈。

## 项目与工作

**项目（Project）**：
用户持续工作的顶层空间，聚合项目资料、Agent 实例、会话与工作区布局。
_避免_：把 Task 或某个 Agent 当作顶层空间

**任务（Task）**：
项目内一个有边界的目标，可交给一个或多个 Agent 实例完成；任务不是工作台顶层。
_避免_：Workspace、Project

**候选结果（Candidate）**：
某个 Agent 实例针对任务产出的可检查结果。
_避免_：把 Agent 实例本身称为 Candidate

## Agent

**Agent Provider**：
Agent 的能力来源，例如 Claude Code、Codex 或 Kimi Code。
_避免_：用 Provider 名称指代某个运行中的 Agent

**Agent 实例（Agent Instance）**：
用户在一个项目内创建并命名的独立工作参与者；同一 Provider 可以创建多个实例。
_避免_：Pane、Provider、固定的 Claude/Codex/Kimi 槽位

**Agent 名称（Agent Name）**：
Agent 实例在所属项目内唯一、由用户定义的可见名称，例如 `cc_data`。
_避免_：把 Provider 名称当作实例名称

**Agent 会话（Agent Session）**：
由一个 Agent 实例持有的连续对话上下文；它不等同于一次临时 CLI 进程。
_避免_：Process、Run

**Handoff**：
用户显式地把一个 Agent 实例的上下文和结果交给另一个 Agent 实例继续处理。
_避免_：从普通回复文本自动触发的隐式派发

## 工作区

**Agent Tab**：
工作区中打开某个 Agent 实例的入口；关闭 Tab 只关闭视图，不删除 Agent 实例。
_避免_：Agent Instance

**Panel**：
同时显示一个活动 Agent Tab 的可见区域；一个 Panel 可以包含多个 Tab。
_避免_：把 Panel 当作 Agent

**工作区布局（Workspace Layout）**：
一个项目内 Panel 的排列，以及 Agent Tab 在 Panel 间的归属和活动状态。
_避免_：Agent 状态
