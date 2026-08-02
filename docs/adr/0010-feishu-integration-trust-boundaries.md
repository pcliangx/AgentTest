# ADR-0010：飞书集成的信任边界与数据主权

- 状态：已接受（Accepted）
- 日期：2026-08-02
- 关联：[ADR-0009](./0009-command-center-workspace-lifecycle.md)、
  [ADR-0012](./0012-enforced-execution-and-brokered-capabilities.md)、
  [PLAN-v0.2](../PLAN-v0.2.md)、[UX-v0.2](../UX-v0.2.md)

## 背景（Context）

Agent Squad HQ 的产品定位已从纯多 Agent 编码器扩展为集成工作台与指挥中心。飞书任务和
知识库因此进入 v0.2 核心范围。用户需要在内嵌浏览器中按自己原有权限正常编辑，也
需要指令 Agent 使用官方飞书 CLI 做 CRUD；两条路径如果共享 Cookie、凭据或隐式
授权，会造成身份混淆、越权和不可审计写入。

## 决策（Decision）

### 连接所有权与范围

- App 全局可以保存多个飞书连接；长期凭据进入系统钥匙串。
- v0.2 每个 Project 可选择 `0..1` 个主 `connectionId`，并单独保存可访问的
  任务清单、知识空间、文档和操作范围；同一连接可以被多个 Project 复用，
  但资源范围彼此隔离。未连接飞书只会关闭飞书工作面的在线能力，不会使整个
  Project 进入 `Unavailable`。
- 改变 Project 主连接前必须预览失效绑定、未同步修改和权限差异。领域模型保留
  `connectionId`，同一 Project 多租户连接留待以后。
- Agent 和 Run 只能拿到受限的能力上下文，不能把长期 Token 放进项目文件、环境变量、
  transcript、handoff 或 renderer。

### 人工浏览与 Agent CLI 严格分离

内嵌浏览器为每个 `ConnectionId` 使用独立的持久 Electron partition。同一连接
可在多个 Project 复用同一人工会话，不同连接不得共享 Cookie：

- 用户遵循飞书账号原有权限，可在页面中正常编辑；
- 只允许受信任飞书域名，外部链接交给系统浏览器；
- 禁用 Node integration，启用 context isolation，并限制导航、弹窗、下载和权限；
- 浏览器 Cookie 不得读取、抓取、注入或复用于 Agent CLI。

Agent 只请求飞书窄化能力，由 main 侧 FeishuConnector 使用官方 CLI /
OpenAPI 代为执行。连接凭据、profile 和已认证原始 CLI 上下文不交给 Agent，
详见 ADR-0012。产品可以比较人工浏览和 Connector 展示的身份是否一致，
但不能共享身份材料。

### 授权与确认

有效 Agent 权限是以下范围的交集：

```text
Project 资源授权 ∩ 当前 Run 的用户指令 ∩ Connector 实际能力
```

用户指令可授权当前 Run 内明确的读取、创建和单条更新。以下动作永远要求预览和不可
绕过的二次确认：删除、批量修改、成员变化、权限变化、凭据展示/导出/转移、强制或
不可逆覆盖。普通创建和单条更新的额外确认可以由 Project 策略配置，但所有外部写入
都必须进入 Run 审计。

飞书 connector 在执行前再次验证连接、资源范围、目标版本和动作类别，不能只信任
renderer 或 Agent 文本。权限请求超时默认拒绝。外部事件本阶段只产生可见变化或
Attention Item，不能自动启动 Agent。

### 数据主权与冲突

飞书是任务业务字段（标题、描述、负责人、截止时间、状态、评论）和知识内容的权威
来源。Agent Squad HQ 是 Dispatch、Run、Session、worktree、执行结果、validation、
handoff 和审计的权威来源。

- 外部记录以稳定 external ID 和版本关联；同步冲突不能静默覆盖；
- Agent CLI 写入成功后刷新投影与索引；失败时保留拟议修改和失败原因；
- 知识缓存离线时只读且带版本，不把缓存冒充飞书 truth；
- 同一飞书任务可显式派发给多个 Agent，每个目标形成独立 Dispatch、Run、worktree
  和执行结果；单个 Run 完成只表示该 Dispatch 完成，任务最终完成仍需用户验收；
- Agent Squad HQ 可以创建本地 Project Task，之后由用户显式发布到飞书。

## 后果（Consequences）

- v0.2 需要 `ConnectionId`、`ExternalResourceBinding`、`ExternalTaskRef`、
  `KnowledgeRef`、`Dispatch`、版本冲突和外部写入审计等正式领域对象。
- 浏览器容器、CLI connector 和 ProjectStore 必须是三条边界清楚的模块；不得由
  renderer 直接持有凭据或执行任意 OpenAPI。
- 飞书 Tasks 与 Knowledge 是 Project 一级工作面，不再归入 Later；Candidate 完整
  比较仍可延后，v0.2 只需“执行结果 + 用户验收”。
- 安全测试需要覆盖域名导航、按 ConnectionId 的 partition 隔离、Node 禁用、
  凭据脱敏、scope 交集、原始 CLI 旁路、高风险确认和版本冲突。
