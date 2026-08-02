# Agent Squad HQ 指挥中心领域词汇

Agent Squad HQ 是一个本地优先、以 Project 为边界的多 Agent 集成工作台与指挥中心。
本词汇表区分外部系统、Provider、运行实例、执行记录和界面容器；代码类型、IPC、
持久化与产品文案应使用相同语义。

## Project 与工作

**Project（项目）**：
用户持续工作的顶层空间，聚合本地目录、Agent、任务、知识、布局、handoff、资源绑定
与审计。Project 可以暂时没有 Git，但创建可运行 Agent 前必须绑定 Git 仓库。
_避免_：Workspace、Task、Repo、某个 Agent

**Project Root（项目根目录）**：
Project 绑定的本地目录。它不是普通可编辑设置；移动后只能通过校验同一 Git 仓库的
“重新定位”操作更新。
_避免_：Agent Worktree

**Project Lifecycle（项目生命周期）**：
Project 是可使用还是已归档的持久状态。运行中、需要处理和局部能力故障不是生命周期。
_避免_：用 Ready、Active 或 Needs Attention 代替归档状态

**Project Availability（项目可用性）**：
Project Root 是否仍可访问的独立状态。缺少 Git、未连接飞书或某个 Provider 不可用
只会降级相关能力，不会让整个 Project 不可用。
_避免_：Agent Availability、Provider Health

**Project Task（本地项目任务）**：
只存在于 Agent Squad HQ 的有边界目标，可显式发布为外部任务。
_避免_：Run、Dispatch

**External Task（外部任务）**：
由飞书等外部系统持有业务字段真相的任务。Agent Squad HQ 只保存稳定引用、版本、派发、
执行结果和验收状态。
_避免_：把本地 Run 状态直接当成飞书任务状态

**Execution Result（执行结果）**：
某个 Dispatch/Run 产生的可检查结果。单个结果完成不等于外部任务最终完成，后者需
用户验收。
_避免_：Agent Instance

**Candidate（候选结果）**：
以后用于比较多个执行结果的上层对象；v0.2 不要求完整 Candidate 工作流。
_避免_：把每个 Agent 本身称为 Candidate

## Agent 与执行

**Agent Provider**：
Agent 的能力来源及协议 adapter，例如 Claude Code、Codex 或 Kimi Code，以稳定
`AgentProviderId` 标识。
_避免_：用 Provider 名称指代运行实例或工作区槽位

**Agent Instance（Agent 实例）**：
用户在一个 Project 内创建并命名的独立工作参与者，以稳定 `AgentInstanceId` 标识；
同一 Provider 可创建多个实例。Provider 创建后不可切换。
_避免_：Pane、Provider、固定 Claude/Codex/Kimi 槽位

**Agent Name（Agent 名称）**：
Project 内大小写不敏感唯一的可见名称和显式路由名称，例如 `cc_data`。重命名不改变
实例身份；旧名称不自动成为 alias。
_避免_：把名称当作持久化主键

**Agent Session（Agent 会话）**：
一个 Agent Instance 持有的连续对话上下文，只记录成功完成的回合。
_避免_：Process、Run、Transcript 文件路径

**Run（运行）**：
用户显式启动的一次结构化执行，以 `RunId` 标识。RunStore 记录输入、事件、权限、
工具、外部 CRUD、usage、退出与失败边界；失败、取消和中断 Run 不写入成功 Session。
_避免_：Session、后台 CLI 进程

**Dispatch（派发）**：
用户把任务或指令交给一个明确 Agent Instance 的记录。同一任务派给多个 Agent 时，
每个目标各有独立 Dispatch、Run、worktree 和执行结果。
_避免_：从外部事件或 assistant 文本自动触发

**Handoff（交接）**：
一个带 provenance 的规范记录，以稳定 `HandoffId` 标识，把目标、摘要、外部引用、
base commit、改动摘要、选定 patch/产物和验证结果交给另一个 Agent。目标 Agent 只在
自己的 worktree 中导入材料。
_避免_：用 Agent Name、Markdown 路径或直接共享 worktree 代表 Handoff

**Terminal Takeover（Terminal 接管）**：
Agent Instance 持有的显式 PTY 模式。它与 structured Run 互斥；关闭 Tab 不关闭 PTY，
显式结束接管才释放实例执行槽。
_避免_：默认 Chat 通道

## 工作区与导航

**Project Surface（项目工作面）**：
Project 一级导航对应的 Overview、Agents、Tasks、Knowledge、Handoffs、Activity 或
Settings。它不等同于 Panel。

**Workspace Layout（工作区布局）**：
Project 内的递归 split tree、Panel 比例、Tab 归属、活动项和焦点。布局是可自动保存
的视图状态，不是 Agent 生命周期。

**Split Node（分割节点）**：
Workspace Layout 的内部节点，记录横向/纵向方向、比例和两个子节点。
_避免_：用固定三栏或二维 grid 代替自由分割模型

**Panel**：
split tree 的叶节点，包含本地 Tab strip，并同时显示一个活动 Tab。Panel 数量不设
硬上限，1–3 个是默认可用密度。
_避免_：Agent、固定 Provider pane

**Agent Tab**：
打开某个 Agent Instance 的唯一工作区入口；同一主窗口中一个实例最多一个 Tab。
关闭 Tab 只关闭视图，不停止 Run、PTY 或删除实例。
_避免_：Agent Instance、镜像视图

**Attention Item（关注事项）**：
权限请求、需输入、失败、完成、handoff 失败、飞书冲突/高风险操作、Provider 不可用
或后台完成等需要观察的可跳转记录。Attention Center 聚合跨 Project 项，但不取代
Project 层级。

## 集成与权限

**External Connection（外部连接）**：
App 全局持有的官方服务连接，以 `ConnectionId` 标识；长期凭据存入系统钥匙串。
Project 可以不引用连接，v0.2 最多引用一个主连接，且不持有秘密。

**Resource Binding（资源绑定）**：
Project 对某个连接下任务清单、知识空间或文档的稳定引用、版本与允许动作范围。

**Embedded Browser（内嵌浏览器）**：
供用户按其飞书账号原有权限浏览和编辑的隔离 WebContents partition。每个
External Connection 使用自己的浏览器身份，Cookie 不提供给 Agent 或 CLI。
_避免_：Connector、Agent 身份

**Connector / CLI Capability（连接器能力）**：
Agent 根据当前 Run 指令请求、由受控连接器代为执行飞书官方 CLI/OpenAPI
的窄化能力。Agent 不拥有连接身份；有效范围是 Project Resource Binding、
当前 Run 授权与连接器实际能力的交集。
_避免_：认证后的原始 CLI、复用浏览器 Cookie、长期 Token 注入环境变量

**Permission Policy（权限策略）**：
Provider、主机、sandbox 和 connector 可以真正强制执行的有效策略。无法执行所选限制
时默认阻止 Run，不能用提示词把宽权限描述成已隔离。

**Permission Request（权限请求）**：
Run 中由协议归一化产生的待审批动作，可拒绝、允许一次或允许当前 Run；永久授权只能
在 Settings 中修改。超时默认拒绝。

**Run Configuration Snapshot（Run 配置快照）**：
Run 开始时记录的脱敏有效配置、权限与资源范围。Settings 的暂存修改只有点击“应用”
后才影响下一次 Run，不能静默改变活动 Run。

**Audit Record（审计记录）**：
对 Run、权限、工具、外部 CRUD、确认、生命周期、合并和失败边界的不可混淆记录。
审计记录不是 Session transcript 的替代物。
