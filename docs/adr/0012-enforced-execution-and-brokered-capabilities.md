# ADR-0012：强制执行门禁与受控外部能力

- 状态：已接受（Accepted）
- 日期：2026-08-02
- 取代：[ADR-0003](./0003-yolo-auto-approve-per-worktree.md)
- 关联：[ADR-0007](./0007-structured-chat-pty-terminal.md)、
  [ADR-0009](./0009-command-center-workspace-lifecycle.md)、
  [ADR-0010](./0010-feishu-integration-trust-boundaries.md)、
  [PLAN-v0.2](../PLAN-v0.2.md)

## 背景（Context）

v0.1 为了让非交互 CLI 能够执行工具，对三家 Provider 开启了 bypass 或
auto-approve。worktree 只能隔离默认写入位置，不能限制主机文件、网络、凭据或
外部 CLI。若在这一基础上直接向 Agent 暴露已认证的飞书 CLI，Project scope、
高风险确认和审计都可被绕过。

## 决策（Decision）

### Run 强制门禁

Project-first 的真实 Run 启动前必须同时通过 Provider Doctor 和最小
PermissionBroker：

- Doctor 声明 Provider、protocol、sandbox 与 host 真正可执行的能力；
- Broker 计算有效策略，不支持用户所选限制时直接阻止 Run；
- Provider 原生 permission request 必须归一化到 Permission Center，不得自动
  选择允许项作为最终决策；
- 一次或当前 Run 的放行不能取代 App 不可绕过的高风险确认。

当前 v0.1 的 bypass/auto-approve 是待迁移的实现事实，不能在 v0.2 UI 中
标记为“已强制”。

### 飞书能力代执行

Agent 不直接持有 Agent Squad HQ 管理的飞书长期凭据、profile、Cookie 或已认证
原始 CLI 上下文。Agent 只能向 main 侧 FeishuConnector 发出类型化的窄化
请求；Connector 使用官方 CLI/OpenAPI 代为执行，并在执行前校验：

```text
ConnectionId + Project Resource Binding + Run instruction
+ action + target version + confirmation token
```

- Connector 子进程使用参数数组和 `shell: false`，不提供任意 argv/raw API 透传；
- 每个 ConnectionId 使用独立的凭据及 CLI 配置上下文；
- Agent 执行环境不得读取 Connector profile 或 App 凭据；仅从 `PATH` 移除命令
  不算隔离；
- 若 Provider/host 无法阻止 Agent 使用 Agent Squad HQ 管理的身份绕过 Connector，
  该 Run 不能获得飞书 Connector 能力；
- 删除、批量、成员、权限和凭据操作的 confirmation token 只能由 App 确认流
  生成，Agent 或 CLI 不能自行构造。

## 后果（Consequences）

- 最小 PermissionBroker 是真实 AgentRuntime 的前置依赖，不能排在真实执行之后；
- 产品可以说“Agent 使用官方飞书 CLI 能力”，但不能说 Agent 获得了用户的
  原始 CLI 身份；
- contract tests 需要覆盖默认拒绝、不可执行策略、无范围请求、跨连接串线、
  高风险 token 伪造和原始 CLI 旁路。
