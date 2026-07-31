# ADR-0005：（未来）模型二 duplex 升级路径

- 状态：未来 / Proposed（未生效；待模型二启动时正式接受）
- 日期：2026-07-31
- 关联：[PLAN-v0.1](../PLAN-v0.1.md)、[ADR-0001](./0001-v0.1-oneshot-resume-model.md)、[agent-adapter-architecture §12/§15](../../agent-adapter-architecture.md)

## 背景（Context）

v0.1 采用模型一（[ADR-0001](./0001-v0.1-oneshot-resume-model.md)），不支持 mid-run steer / 中断、每条消息有冷启动。当对比体验需要回合 / 工具级实时控制、或需要低延迟 follow-up 时，需升级到模型二（长驻双向进程）。

## 决策（Decision，待启动时生效）

按风险递增顺序逐 adapter 上 duplex，**先 probe 再进产品**（architecture 文档 §15 阶段 3）：

1. **Claude Code**：经 Agent SDK（`@anthropic-ai/claude-agent-sdk`）走 stream-json 双向——最低风险起点。
2. **Kimi**：走 ACP（Agent Client Protocol over stdio）——开放标准。
3. **Codex**：走 `app-server`——当前 experimental，待稳定后再上。

升级以同一 `AgentAdapter` seam 下的第二种 channel 形式接入，不改 router / run-manager 的 agent 特例。

## 后果（Consequences）

- **正面**：解锁 mid-run steer / 中断、低延迟 follow-up、更精细的回合 / 工具控制。
- **负面 / 代价**：需实现 3 套不同的双向协议驱动 + 长驻进程生命周期管理；Codex 受 experimental 协议稳定性制约。
