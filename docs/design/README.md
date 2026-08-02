# Agent Squad HQ UI 原型

> **THROWAWAY PROTOTYPE**：本目录只用于验证界面结构与交互，不是生产代码，不能直接复制进 renderer。

## 本轮问题

在已确认的 Project-first、显式执行、自由分屏与飞书信任边界下，Agent Squad HQ 作为
“集成工作台 / 指挥中心”应该如何组织导航、运行态势、Agent 工作区和 Project
设置？

## 文件

| 文件 | 用途 | 状态 |
| --- | --- | --- |
| `project-command-center-desktop-a.html` | 用户提供的原始指挥中心设计 | 历史输入，保留不改，不代表现行契约 |
| `project-integrations-settings-desktop-a.html` | 用户提供的原始设置设计 | 历史输入，保留不改，不代表现行契约 |
| `project-command-center-desktop-b.html` | B 版指挥中心三种结构变体 | 已评审，作为冻结组合的交互参考 |
| `project-integrations-settings-desktop-b.html` | B 版设置三种结构变体 | 已评审，作为冻结组合的交互参考 |

B 版通过 URL 参数切换三种结构，底部浮动条和键盘 `←` / `→` 也可以切换：

- `?variant=A`：稳定双侧栏 / 层级配置台；
- `?variant=B`：运行雷达 / 策略矩阵；
- `?variant=C`：沉浸画布 / 安全审阅。

### 已冻结组合

- 指挥中心以 **A 双侧栏指挥台**作为常态骨架：固定 Project 导航和上下文目录最符合
  “指挥中心”心智；把 **B 运行雷达**收为可展开的全局态势/Attention 侧栏；把
  **C 浮动 Agent Directory**只用于 Focus 或窄窗口 palette。
- Project Settings 以 **A 层级配置台**作为常规编辑入口；把 **B 策略矩阵**作为
  “比较实例有效配置”的专用视图；把 **C 安全审阅**作为运行前 readiness 摘要，
  不取代完整 Settings 导航。

用户已于 2026-08-02 接受该组合并关闭 Design Gate。这个组合只定义一套主信息架构，
B/C 是 A 的辅助观察方式，不是三套并列产品。生产实现必须按
[`UX-v0.2`](../UX-v0.2.md) 和 Phase 1 spec 重新实现。

### 专家评审后修正

- Project lifecycle、root availability、Git readiness、activity 与 Attention 改为正交状态；
- Project 飞书主连接改为可选 `0..1`，浏览器 partition 按 `ConnectionId` 隔离；
- Agent 只请求窄化能力，由 main 进程 Connector 代执行官方 CLI，不向 Agent 暴露受管
  profile、凭据或高风险确认 token；
- Running Agent 的新指令进入当前等待 Run 或下一 Run 队列，不创建第二 active Run；
- Dispatch 增加 Agent Picker、目标 chips、资源/队列预览和显式确认；
- Global Attention 可从全部 Project surface 和 Settings 打开；
- Settings 使用按 owner ID 隔离的 draft/applied 状态，Discard 回滚，Apply 才生效；
- Tab、divider 与跨 Panel 移动补充键盘路径；4+ Panel 在空间不足时显式滚动。

使用 Electron 在 1280×800 下对两页 A/B/C 共六个变体执行了自动交互冒烟，覆盖上述
关键路径并通过。该结果不替代生产 UI 的视觉回归、可访问性测试或 GUI 人工验收。

直接在 macOS 打开：

```bash
open docs/design/project-command-center-desktop-b.html
open docs/design/project-integrations-settings-desktop-b.html
```

原型状态只存在内存中，刷新即重置。所有 Agent、飞书、权限、写入、应用和删除动作
都是模拟；原型不会连接真实 CLI、凭据、ProjectStore 或飞书。

## 生产实现验收重点

1. 主导航是否清楚表达 Overview、Agents、Tasks、Knowledge、Handoffs、Activity、
   Settings 的 Project 层级；
2. Agent Directory、Attention Center 与工作区之间的视觉优先级是否合理；
3. Tab 跨 Panel 拖动、拖到边缘创建分屏、拖分隔条和 Focus 是否容易发现；
4. Tasks 与 Knowledge 是否像指挥中心的核心工作面，而不是附属设置；
5. Settings 是否清楚区分自动保存的布局状态与必须“应用”的运行配置；
6. Provider Doctor、有效权限、浏览器身份、CLI 身份和 Project 资源范围是否没有
   被混为一谈。

## 原型边界

生产 UI 按正式状态契约重新实现；这些 HTML 不进入生产构建，也不承担后续数据迁移
或业务逻辑。当前未创建 throwaway 分支、未提交、未启动生产 UI。
