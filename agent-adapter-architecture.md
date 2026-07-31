# Agents.Fleet 多 Agent 统一调度与 Adapter 架构建议

> 状态：设计参考，非规范性文档  
> 日期：2026-07-27  
> 适用范围：Claude Code、Codex CLI、Kimi Code、Qoder、OpenCode、Pi、ZCode 等异构 Agent 工具的统一接入  
> 规范优先级：如本文与 `docs/specs/`、已接受 ADR 或 `CONTEXT.md` 冲突，以后者为准

## 1. 结论

Agents.Fleet 应定义一个稳定、较小的内部 `AgentAdapter` 接口，并让每个 Adapter 使用目标 Agent 最可靠的原生通信协议：

1. 优先使用结构化、双向的进程协议，例如 JSONL、RPC、ACP、app-server 或工具自身提供的 stream-json 模式。
2. 当结构化协议不可用、不稳定或版本不受支持时，回退到交互式 PTY。
3. GUI 输入框注入、AppleScript、Accessibility API、键盘模拟或 tmux `send-keys` 只作为最后一级兼容方案，不能成为调度内核。
4. Task Orchestrator、Session Runtime 和 Worktree Manager 不得按 Agent 名称分支；它们只依赖统一命令、统一 Observation 和经过 probe 验证的 Capability。
5. 每个 Attempt 默认启动一个独立 Agent 进程，绑定一个 Worktree 和一个 Fleet Session。不要默认让多个任务共享一个全局 Claude、OpenCode、ZCode 或其他 Agent server。
6. Fleet Session ID 与 Agent 自己的 conversation/session ID 必须分开保存。前者表示 Fleet 管理的进程生命周期，后者只用于调用目标 Agent 的原生 resume/fork 能力。

推荐总体结构：

```text
Task
  │
  ▼
Task Orchestrator
  │  只使用 Capability 和统一命令
  ▼
AgentAdapter Registry
  │
  ▼
AgentAdapter
  ├─ Candidate discovery
  ├─ Version/capability probe
  ├─ Launch builder
  ├─ Permission mapping
  ├─ Input encoder
  ├─ Observation decoder
  └─ Native conversation resume
  │
  ▼
Session Runtime
  ├─ Interactive PTY
  └─ Structured duplex stdio（候选扩展，见第 12 节）
  │
  ├─ Durable input intent
  ├─ Raw stream journal
  └─ Process lifecycle
  │
  ▼
Evidence Recorder / Fleet Projection
```

这与 [ADR-0002](adr/0002-agent-adapter-capabilities.md) 的方向一致：差异留在独立 Adapter 内，核心流程按 Capability 运行。

## 2. 要解决的问题

不同 Agent 的表面行为相似：接收任务、执行工具、返回结果、等待补充输入、恢复上下文。但它们的真实接口并不一致：

- 有的提供长驻进程和双向 JSON 流。
- 有的只提供一次性 `exec` 和结构化输出。
- 有的有 ACP、RPC 或 app-server。
- 有的主要通过交互式终端工作。
- 有的只有桌面 App，公开的自动化接口有限。
- session ID 的产生方式、resume 参数、权限模式和中断语义各不相同。
- 同名命令在不同版本中可能改变参数、事件格式和能力。

如果把这些差异直接写进 Task Orchestrator，代码最终会变成：

```ts
if (agentId === "claude") {
  // ...
} else if (agentId === "kimi") {
  // ...
} else if (agentId === "codex") {
  // ...
}
```

这会导致新增或升级一个 Agent 时修改共享调度代码，并把协议解析、权限映射、进程控制和产品状态混在一起。Adapter 的目标就是把这种变化限制在单个深模块中。

## 3. 领域身份与生命周期

建议保持以下身份链：

```text
Task
  └─ Attempt
      ├─ Worktree
      └─ Fleet Session
          └─ Agent Process
              └─ Native Conversation ID（可选）
```

各身份的含义不同：

- **Task**：用户想完成的工作。
- **Attempt**：执行 Task 的一次尝试；retry 或 resume 都创建新的 Attempt。
- **Worktree**：该 Attempt 被允许修改的仓库工作目录。
- **Fleet Session**：Fleet 拥有和观察的一个进程/终端生命周期。
- **Native Conversation ID**：Claude、Kimi、Codex 或其他 Agent 自己维护的上下文标识。

必须遵守：

- 一个新的进程生命周期使用新的 Fleet Session ID。
- Agent 原生 resume 不等于复用旧 Fleet Session；它应创建新的 Attempt 和 Fleet Session，然后把旧的 Native Conversation ID 交给新进程。
- Native Conversation ID 不能被当作 Fleet 的生命周期权威。
- Fleet 不能仅因保存了 session ID 就声称完整上下文一定可恢复；是否可恢复取决于 Agent 版本、本地状态、账号、工作目录、模型服务和原生协议。

建议的数据结构：

```ts
interface NativeConversationRef {
  readonly agentId: string;
  readonly nativeSessionId: string;
  readonly obtainedFrom:
    | "structured-output"
    | "transcript"
    | "hook";
}
```

如果 Adapter 无法可靠取得原生 session ID，就不得声明 `ResumeById` Capability。

## 4. Agent 上下文究竟如何延续

“带上下文”有两种不同机制。

### 4.1 同一进程内的连续对话

如果 Agent 提供长驻 stdin/stdout 协议，Fleet 可以保留同一进程：

```text
Fleet 写入第 1 条消息
  → Agent 返回事件
Fleet 写入 follow-up
  → 同一进程继续处理
```

此时不需要每轮都重新传 session ID，因为 Agent 进程本身仍持有对话状态。Fleet 仍需持久化 Input Intent 和输出证据。

### 4.2 进程退出后的原生恢复

如果进程已经退出，Fleet 启动新进程并显式传入 Agent 原生 session ID：

```text
旧 Fleet Session 已退出
  → Fleet 创建新 Attempt
  → Fleet 创建新 Fleet Session
  → Adapter 构造 resume argv / request
  → Agent 从 nativeSessionId 恢复自己的上下文
```

因此，“每次交互都靠 `<session-id>` 找回上下文”并不总是正确：

- 长驻进程中的 follow-up 通常不需要重新 resume。
- 一次性 CLI 调用或进程重启后，才通常需要原生 session ID。
- 不同工具对“继续最近会话”“按 ID 恢复”“fork 会话”的支持并不相同。

`--output-format stream-json` 一类参数属于具体 Agent CLI，而不是 macOS 参数。它控制 CLI 如何把事件写到标准输出；是否同时支持流式标准输入、session ID、resume 和权限请求，需要逐版本 probe，不能由参数名称推断。

## 5. Adapter 的职责边界

一个 Adapter 应负责：

- 发现候选可执行文件，但在 Repository Trust 生效前不执行它。
- 在中立目录和清理后的环境中 probe 版本与真实能力。
- 验证版本是否落在支持范围。
- 把 Fleet 的权限意图映射为该 Agent 的实际参数和限制。
- 生成结构化 launch/resume specification，不在 `prepare` 中启动进程。
- 把统一输入编码为目标协议的精确 bytes。
- 把原始输出增量解析为统一 Observation。
- 从可信输出、hook 或 transcript 中提取 Native Conversation ID。
- 将协议错误、未知事件、超限帧和不完整数据显式降级或失败。

Adapter 不应负责：

- 创建或选择 Worktree。
- 决定 Task、Attempt 的领域状态。
- 取得或绕过 Control Lease。
- 直接写数据库成为生命周期权威。
- 隐式执行 Git cleanup、reset、checkout 或删除文件。
- 在 `prepare` 阶段运行 Agent、shell 或 Repository 内容。
- 用 Agent 名称改变 Orchestrator 的通用流程。

## 6. 推荐接口

以下接口是后续演进方向，不是对当前 contracts 的直接替换：

```ts
interface AgentAdapter {
  readonly manifest: AgentManifest;

  discoverCandidate(): Promise<CandidateExecutable>;

  probe(input: ProbeInput): Promise<VerifiedAgent>;

  prepare(
    input: StartAgentInput | ResumeAgentInput,
  ): Promise<PreparedAgentSession>;

  createCodec(
    session: PreparedAgentSession,
  ): AgentSessionCodec;
}

interface AgentSessionCodec {
  encode(input: AgentInput): Uint8Array;

  ingest(
    output: Uint8Array,
  ): readonly AgentObservation[];

  finish(
    exit: ProcessExit,
  ): readonly AgentObservation[];
}
```

`prepare` 的输出应该是数据，不是副作用：

```ts
interface PreparedAgentSession {
  readonly executablePath: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly channel: AgentChannel;
  readonly effectiveCapabilities: readonly AgentCapability[];
  readonly permissionMapping: PermissionMapping;
}
```

统一输入可以先保持很小：

```ts
type AgentInput =
  | {
      readonly kind: "message";
      readonly text: string;
      readonly attachments: readonly AgentAttachment[];
      readonly delivery: "follow-up" | "steer";
    }
  | {
      readonly kind: "interrupt-turn";
    };
```

统一 Observation 应表达事实来源：

```ts
interface AgentObservation {
  readonly kind: string;
  readonly occurredAt: number;
  readonly source:
    | "protocol"
    | "pty"
    | "hook"
    | "transcript"
    | "inferred";
  readonly payload: unknown;
}
```

不要试图在第一版把所有 Agent 事件归一为巨大、完美的公共模型。保留少量稳定事件，例如：

- message/assistant output
- tool started/completed
- permission requested
- turn completed
- native conversation identified
- usage observed
- protocol warning/error
- process exited

无法可靠归一的内容可以作为带 provenance 的 Agent-specific evidence 保存，但不能驱动核心生命周期。

## 7. 两类 Session Channel

长期可以考虑在 Session Runtime 内支持两类私有 Channel：

```ts
type AgentChannel =
  | {
      readonly kind: "interactive-pty";
    }
  | {
      readonly kind: "duplex-stdio";
      readonly framing: "jsonl";
    };
```

### 7.1 Structured duplex stdio

适合具有稳定机器协议的 Agent：

- stdin 接收结构化请求。
- stdout 输出结构化事件。
- stderr 单独记录诊断信息。
- 可以可靠识别 turn、tool、permission、usage 和 session ID。
- 不需要解析 ANSI 终端画面来猜测状态。

优点：

- 事件边界明确。
- 自动化测试和故障注入更容易。
- follow-up、steer、interrupt 的语义更可靠。
- Native Conversation ID 和 usage 更容易结构化提取。

风险：

- 协议可能未承诺稳定。
- stdout 可能混入非 JSON 日志。
- 单个超大帧或无限无换行输出会造成内存风险。
- 有些 CLI 的 stream-json 只是输出格式，并不代表 stdin 也是双向协议。

因此必须有增量 decoder、最大帧限制、未知事件策略和版本门禁。

### 7.2 Interactive PTY

适合：

- 只支持交互式终端的 CLI。
- 结构化协议没有通过当前版本验证。
- 用户需要直接接管终端。
- 需要兼容 TUI、确认提示、IME、鼠标或特殊终端模式。

PTY 是通用兼容层，但语义较弱。它能证明 Fleet 读写了终端 bytes，不能证明 Agent 理解、消费或执行了输入。

## 8. 输入、follow-up、steer 与中断

产品层不应只暴露“向终端写一串 bytes”。建议增加高层命令：

```ts
interface SendAgentMessage {
  readonly sessionId: string;
  readonly text: string;
  readonly attachments: readonly AgentAttachment[];
  readonly delivery: "follow-up" | "steer";
}
```

流程：

```text
SendAgentMessage
  → 校验 Session / Attachment / Control Lease
  → durable Input Intent
  → Adapter.encode(...)
  → Session owner 写入 PTY 或 stdio
  → durable Dispatched Observation
```

其中：

- `follow-up` 表示在 Agent 可以接收下一条消息时继续。
- `steer` 表示尝试影响仍在运行的当前 turn。
- `interrupt-turn` 表示终止当前 turn，不等同于终止整个 Session。
- 只有 Adapter 明确声明相应 Capability 时，UI 才能提供 steer 或 turn interrupt。
- 底层 `WriteSessionInput` 仍可保留给终端接管，但不能替代高层 Agent 消息语义。

所有路径都必须先持久化 Input Intent。`Dispatched` 只表示 bytes 已交给 Session owner，不表示 Agent 已读取或完成操作。

## 9. Capability 设计

当前 Capability 包含：

- `Discovery`
- `Hook`
- `Transcript`
- `Resume`
- `PermissionMapping`

后续如需支持结构化调度，建议增加行为能力，而不是增加 Agent 名称：

```ts
type AgentCapability =
  | "StructuredObservation"
  | "DuplexMessage"
  | "Steer"
  | "InterruptTurn"
  | "ResumeById"
  | "ForkConversation"
  | "PermissionRequestObservation"
  | "UsageObservation";
```

Capability 必须区分声明值和验证值：

```text
manifest.declaredCapabilities
  → version/capability probe
  → probeResult.effectiveCapabilities
  → immutable launch snapshot
  → core behavior
```

核心流程只能使用本次 launch 固化的 `effectiveCapabilities`。不能因为某个 Agent “通常支持”某能力，就对未知版本静默开启。

`Full` / `Launch-level` 仅用于 UI 汇总，不应成为行为开关。

## 10. 各工具的接入策略

下表是设计路线，不是当前版本兼容性声明。每个具体命令、参数、事件 schema 和 resume 方式都必须由 Adapter 的受支持版本范围与 fixture 证明。

| 工具 | 优先通道 | 回退通道 | Adapter 重点 |
| --- | --- | --- | --- |
| Claude Code | 经验证的 stream-json 双向进程 | PTY | 区分输出格式与真正的双向输入；提取原生 session ID；映射权限模式 |
| Codex CLI | 经验证的 app-server/结构化协议 | `exec --json` 或 PTY | app-server 版本门禁；turn/approval 事件；resume/fork 语义 |
| OpenCode | 每 Attempt 一个 ACP 进程 | JSON 输出或 PTY | ACP 生命周期、请求关联、permission 事件 |
| Pi | 每 Attempt 一个 RPC 进程 | JSON 输出或 PTY | RPC request ID、流式事件、进程退出恢复 |
| Kimi Code | 经验证的结构化输入输出与显式 session ID | PTY | session 创建/恢复、stream-json schema、权限与中断 |
| Qoder | 经验证的 stream-json/input-format 与 resume | PTY | CLI 与 App 能力不要混淆；版本探测 |
| ZCode | 经验证的 App bundled server/headless CLI | PTY；GUI 注入为最后手段 | 安装位置、签名和 bundled runtime identity；GUI 自动化不作为强保证 |

这里的“优先”只表示架构选择顺序：

1. 当前安装版本的稳定公开协议。
2. 可以通过固定版本、fixture 和兼容性测试约束的结构化协议。
3. PTY。
4. GUI/Accessibility 注入。

如果 Agent 已经在某个独立终端窗口或桌面 App 中打开，Fleet 理论上可以通过以下方式注入内容：

- 对受 Fleet 管理的 PTY 写入 bytes。
- 对 tmux session 使用其控制接口。
- 使用 macOS Accessibility API 定位输入控件。
- 使用 AppleScript 或键盘事件。

但只有第一种在 Fleet 自己拥有 Session 时具有较强的身份和生命周期保证。GUI 注入容易遇到焦点错误、权限弹窗、输入法、界面升级、内容误投和无法确认消费等问题，最多作为人工辅助功能。

## 11. 进程隔离策略

默认采用：

```text
一个 Attempt
  → 一个独立 Worktree
  → 一个独立 Agent 进程
  → 一个独立 Fleet Session
```

即使某个 Agent 支持全局 server，也不应默认让所有任务共享同一 server。独立进程有以下好处：

- 生命周期所有权清楚。
- cwd、环境变量和权限映射可以按 Attempt 固化。
- 不同 Worktree 的输入输出不会串线。
- stop、cancel、terminate 的影响范围可解释。
- 崩溃、升级和资源限制更容易归因。
- 测试可以证明 at-most-once launch 和零跨 Session 串线。

只有在协议明确支持隔离 workspace/conversation、鉴权边界可验证、server 崩溃影响可接受并完成专门 ADR 后，才考虑共享 server。

## 12. 与当前 v1 规范的冲突点

当前 [CONTEXT.md](../CONTEXT.md) 将 `Session` 定义为可 attach 的 PTY 生命周期，[runtime contracts](specs/runtime-contracts-v1.md) 也明确要求 Session Runtime 使用 `node-pty` 持有 Agent 进程。

因此，本文提出的 `duplex-stdio` 不是当前 v1 已批准能力。若决定实施，应先选择以下方案之一并写 ADR：

### 方案 A：继续保持 v1 全部走 PTY

- Adapter 只负责 argv、环境、权限映射、Hook 和 Transcript。
- 即使 CLI 能输出 JSON，也通过 PTY 启动并把结构化事件作为旁路或从原始流中解析。
- 优点是保持现有 Session、attach、Control Lease、Snapshot 和终端 UI 契约。
- 缺点是 stdout/stderr 合流、终端控制字符和交互提示可能削弱协议可靠性。

### 方案 B：把 Session 抽象为 Managed Session

```text
Managed Session
  ├─ Terminal Session / PTY
  └─ Structured Agent Session / duplex stdio
```

- 两类 Session 共用身份、生命周期、Input Intent、durability、attachment 和 control fencing。
- PTY 专有能力，如 resize、终端 Snapshot、xterm 渲染，仅属于 Terminal Session。
- 结构化 Session 使用事件 journal 和结构化 projection。
- 需要修订 `CONTEXT.md`、ADR、runtime contracts、命令矩阵、存储和验收测试。

在上述决策完成前，不应直接修改现有 `Session` 含义或绕过 `node-pty` 契约。

## 13. 包结构建议

v1 使用静态内置 registry，不加载第三方 Adapter：

```text
packages/agent-adapters/
  src/
    registry.ts
    shared/
      bounded-observation.ts
      jsonl-decoder.ts
      version-range.ts
    claude-code/
      adapter.ts
      codec.ts
      launch.ts
      manifest.ts
      transcript.ts
      fixtures/
    codex/
    kimi/
    opencode/
    pi/
    qoder/
    zcode/
```

`registry.ts` 只做组合：

```ts
export const builtInAdapters: readonly AgentAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  opencodeAdapter,
];
```

它不应包含协议行为，也不应形成新的集中式 `switch (agentId)`。

共享目录只放真正跨 Adapter 稳定的机制，例如：

- 有大小上限的 JSONL decoder
- semver/version range 检查
- 通用 Observation 限额
- 契约 fixture runner

参数名、事件类型、resume 规则、transcript 路径和权限映射仍应留在各自 Adapter 中。

## 14. 契约测试

每个真实 Adapter 必须通过同一套共享 fixture。最低测试集合：

1. 未知版本和不支持版本被明确拒绝。
2. `discoverCandidate` 在 Trust 前不执行 Agent、Git、shell 或 Repository 内容。
3. `prepare` 只返回结构化数据，不启动进程。
4. Manual、Balanced、YOLO 三种用户意图都产生显式 Permission Mapping。
5. start 与 resume 的 argv、env、cwd、channel 完全可快照验证。
6. 能从受支持事件中提取 Native Conversation ID。
7. decoder 可以处理任意 byte chunk 切分，而不假设一读一行。
8. 损坏 JSON、超大帧、NUL、非法 UTF-8、stdout 噪声和半帧退出都有确定行为。
9. Hook、Transcript 缺失、超时或解析失败只降低观察能力，不改写进程生命周期。
10. `encode` 对同一高层输入产生确定的协议 bytes。
11. 未声明 `Steer`、`InterruptTurn` 或 `ResumeById` 时，核心返回稳定的 `CapabilityUnavailable`。
12. 新增第二个 Adapter 不修改 Task Orchestrator、Session Runtime 或 Worktree Manager 的 Agent 特例。
13. 从 PTY 文本推断出的事实始终标记为 `inferred`。
14. 输入先形成 durable Input Intent，再由 Session owner 写入。
15. Native Conversation ID 与 Fleet Session ID 不会相互替代或复用。

此外，每个 Adapter 应保留来自受支持版本的脱敏协议 fixture，版本升级时用 fixture diff 识别 schema 漂移。

## 15. 推荐实施顺序

### 阶段 1：用第一个 Adapter 固化最小接口

- 完成 Host Environment discovery/probe 边界。
- 以 Claude Code Adapter 作为第一份真实实现。
- 只承诺已经验证的版本和 Capability。
- 建立完整共享 fixture。

第一份实现只能形成候选接口，不要过早抽象所有工具的共同点。

### 阶段 2：用第二个 Adapter 验证 Seam

- 以 Codex Adapter 验证同一接口。
- 如果必须修改 Orchestrator 或 Session Runtime 的 Agent 名称分支，优先修正 Adapter 接口。
- 固化 declared/effective Capability 的唯一来源。

这一步对应 [runtime contracts](specs/runtime-contracts-v1.md) 中“第二个真实 Adapter 证明 Seam”的要求。

### 阶段 3：决定结构化 Session 是否进入产品

- 先做一次小型技术 probe，验证一个长驻 stream-json/RPC Agent。
- 比较纯 PTY 与 duplex stdio 在 durability、attach、permission、interrupt 和 user takeover 上的差异。
- 根据结果保留 PTY-only v1，或提交 Managed Session ADR 和规范变更。

### 阶段 4：接入协议较明确的工具

- OpenCode ACP
- Pi RPC
- Kimi Code
- Qoder

每次只增加一个 Adapter，并复用共享契约测试。

### 阶段 5：最后处理 GUI/App 型工具

- 对 ZCode 等工具先探测 App bundle 是否包含可稳定调用的 headless/server 入口。
- 固定 bundle identity、版本和签名范围。
- 只有没有稳定机器接口时才提供 PTY 或 GUI 辅助模式。
- GUI 注入能力在 UI 中应标为低保证，不能伪装成可靠的 structured control。

## 16. 不建议的做法

- 不把 MCP 作为 Fleet 调度 Agent 的统一传输层。MCP 更适合 Agent 调工具；Agent 自身的 ACP、RPC、stream-json 或 app-server 应作为 Adapter 内部 driver。
- 不把所有 Agent 统一成一条 shell command string；使用结构化 executable、argv、env 和 cwd。
- 不用“看到提示符”推断 turn 一定结束。
- 不自动向不确定的旧会话重放 Input Intent。
- 不把 `Dispatched` 命名为 `Delivered` 或解释为 Agent 已消费。
- 不根据 Agent 品牌默认开启 Capability。
- 不允许 Adapter 直接修改 Orchestrator 状态或绕过 Launch Confirmation。
- 不默认共享全局 Agent server。
- 不通过前台窗口标题或焦点猜测目标 Session。
- 不在 v1 动态加载第三方 Adapter。

## 17. 需要形成 ADR 的决策

在进入实现前，至少应显式决定：

1. v1 是否继续把所有 Agent 放在 PTY 中运行。
2. 是否引入 `Managed Session`，以及 structured stdio 是否拥有 Attachment、Control Lease 和 durable stream。
3. 高层 `SendAgentMessage` 与底层 `WriteSessionInput` 的命令边界。
4. Native Conversation ID 的存储、敏感性、过期和恢复规则。
5. structured event journal 与现有 PTY chunk store 的关系。
6. user takeover 对 structured process 的含义：继续结构化控制、打开镜像终端，还是必须降级/重启为 PTY。
7. Adapter 支持版本的发布、回滚和兼容性矩阵。

## 18. 仓库内相关材料

- [领域词汇表](../CONTEXT.md)
- [Agent Adapter ADR](adr/0002-agent-adapter-capabilities.md)
- [Runtime Contracts v1](specs/runtime-contracts-v1.md)
- [产品规格 v1](specs/v1.md)
- [当前 AgentAdapter 接口](../packages/contracts/src/modules/agent-adapter.ts)
- [当前 Capability 与 Permission Mapping](../packages/contracts/src/adapter.ts)

本文适合作为 Adapter 设计、技术 probe 和后续 ADR 的讨论底稿；它本身不修改现行产品承诺。
