# 建立 UI Contract 与 MockScenarioAdapter

Type: task
Status: ready-for-agent

## 范围

在 renderer 与 preload/main 之间定义版本化 ViewModel/Command/Event ports，实现纯内存
MockScenarioAdapter，覆盖 spec 列出的全部状态。使用 branded IDs，不引入真实副作用。

## 验收

- contract tests 同时约束 mock 和未来真实 adapter。
- UI 不使用 Provider 名称、数组下标、TabId 或 PanelId 代替 AgentInstanceId。
- mock 不包含 ProjectStore、Git、进程、凭据或外部 CRUD。
