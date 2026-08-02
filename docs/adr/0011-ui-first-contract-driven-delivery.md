# ADR-0011：设计冻结后先交付生产 UI 与契约化 Mock

- 状态：已接受（Accepted）
- 日期：2026-08-02
- 关联：[ADR-0008](./0008-project-first-agent-instances.md)、
  [ADR-0009](./0009-command-center-workspace-lifecycle.md)、
  [ADR-0010](./0010-feishu-integration-trust-boundaries.md)、
  [ADR-0012](./0012-enforced-execution-and-brokered-capabilities.md)、
  [PLAN-v0.2](../PLAN-v0.2.md)

## 背景（Context）

指挥中心的信息层级、自由分屏、运行态势和安全反馈是产品价值本身。若先完成所有
ProjectStore、runtime 和飞书集成，再开始生产 UI，领域实现容易固化旧三 pane 心智；
若先写一套使用 `localStorage`、Provider 名称和伪业务逻辑的“完整 UI”，后续又会因
真实状态与权限边界重写。

## 决策（Decision）

UI/UX 设计基线与状态契约冻结后，先于 Project-first 内核实现一个**生产级 UI 与
交互基线**：

- 使用仓库正式 renderer 技术栈、设计 token、组件和路由；
- 实现 Project 主导航、Overview、Agent Directory、自由 split tree、Panel/Tab
  拖动、Focus/Analysis、Tasks、Knowledge、Handoffs、Activity、Attention Center
  和 Project Settings 的生产结构；
- 覆盖 empty、loading、ready、queued、running、needs-input、permission-requested、
  failed、interrupted、conflict、offline、unavailable 和 archived 等关键状态；
- UI 只依赖版本化的 TypeScript `ViewModel`、`Command`、`Event` 与 port 接口；
  mock adapter 驱动场景，状态只用于开发和测试；
- split tree、drag/drop、键盘、焦点、最小尺寸和可访问性属于真实 UI 能力，必须在
  此阶段实现并测试；
- 建立组件、交互和视觉回归验收，1280×800 是最低桌面基线。

此阶段明确不实现：真实 Agent 子进程、PTY、worktree、ProjectStore 数据迁移、飞书
登录/CRUD、凭据、权限放宽或外部副作用。飞书 Knowledge 只实现浏览器容器与状态；
安全 partition 和真实导航在集成阶段接入。

renderer 不得：

- 使用 Provider 名称、数组下标、TabId 或 PanelId 代替 AgentInstanceId；
- 把 `localStorage` 当作正式 Project/Layout truth；
- 解析 assistant 文本触发派发；
- 实现只有 main/connector 才能验证的权限与生命周期规则；
- 直接复制 `docs/design/` 的 throwaway HTML 作为生产组件。

UI 基线验收后，再按契约实现 Project-first 内核并替换 mock adapter。真实 store、IPC
和 runtime 的接入必须逐个纵向切片进行，不能在最后一次性“大接线”。

## 后果（Consequences）

- 设计冻结必须先给出 ID、状态、命令、事件、错误和权限反馈的最小类型合同。
- UI 可以更早接受视觉与交互验证，同时迫使领域层围绕真实用户动作设计。
- mock 与真实 adapter 必须通过相同 contract tests；mock 不能发展成第二套业务规则。
- 原型与生产 UI 的边界更严格：原型用于选择，生产 UI 需重新实现并承担测试、错误
  处理和可访问性责任。
