# ADR-0004：`@@` 显式路由，无隐式广播

- 状态：部分被 [ADR-0009](./0009-command-center-workspace-lifecycle.md) 取代
- 日期：2026-07-31
- 关联：[PLAN-v0.1](../PLAN-v0.1.md)

## 背景（Context）

"统一给 agent 发消息"语义有歧义：是"一条消息同时发给所有 agent（广播）"，还是"统一界面、每次指定一个 agent（单发）"？经讨论定为模式 3（两者都要）。同时，agent 自身使用单 `@`（文件引用 / 提及），若路由也用 `@` 会与之冲突。

## 决策（Decision）

- 目标前缀统一用 **`@@`**（双 at）：`@@claude` / `@@codex` / `@@kimi` / `@@all`。
- **必须显式 `@@`**：没有 `@@` 的输入**不派发**，要求补目标。**无隐式广播。**
- 多个 `@@` = 目标并集（如 `@@codex @@kimi`）。
- `@@all` = 广播全部三家。

## 后果（Consequences）

- **正面**：语义无歧义、不会误投；`@@` 与 agent 自身的 `@` 不冲突。
- **负面 / 代价**：不能"裸输入直接广播"——广播必须显式写 `@@all`（这是为安全与明确性刻意选择的摩擦）。

## v0.2 修订

- Agent Tab composer 已由当前 `AgentInstanceId` 明确限定唯一目标，可以直接发送；
- Overview、Task、Handoff 和命令面板等无单一上下文入口，必须通过
  Agent Picker、可见目标 chips 或 `@@<agent-name>` 明确目标；
- `@@all` 展开当前 Project 的具体实例列表并再次确认，不再表示固定三家
  Provider；
- assistant 输出中的 `@@` 永不触发派发。
