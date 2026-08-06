# Agent Squad HQ — UI/UX 评审 + OpenDesign 对标报告

> 2026-08-06，基于 `main` 全套视觉截图（01-home ~ 15-switch-bar-global）+
> OpenDesign 源码 (`b323a28`) + 已有调研文档。

---

## 第一部分：当前 UI/UX 评审

### 1. 架构层级评分

| 维度 | 评分 | 说明 |
|---|---|---|
| **信息架构** | ★★★★ | 双层左导航（App 级 + 项目级）清晰；首页/切换条分工合理 |
| **视觉一致性** | ★★★ | #65 令牌统一，但大量面像「表单+表格」，缺少呼吸感和层次 |
| **交互密度** | ★★ | 组件密集、字号偏小（9-11px 居多），信息多但可读性差 |
| **核心价值表达** | ★★ | 看不到 Agent 在做什么——所有内容是静态 mock 文案 |
| **情感设计** | ★ | 零动效、零空态插画、零品牌叙事——像一个后台管理系统 |

### 2. 逐面问题

#### 首页（01-home）
- **品牌区太弱**：HQ 文字 + 一行 tagline，没有 hero 视觉、没有引导动作的层次感
- **快速建项目卡太朴素**：两个 input + 一个按钮，没有区分主次、没有示例项目引导
- **最近项目列表平淡**：纯文字行 + 时间戳，没有项目缩略/活动摘要/快速操作

#### 工作区（03-agents）
- **这是最核心的问题**：Panel 内容区只有静态文案（「暂无对话记录」），看不出这是一个 AI 编码工作台
- **对话区是纯文本堆**：没有 markdown 渲染、没有代码高亮、没有 tool call 卡片、没有流式动画
- **Tab 标签信息密集**：mono 字体 9px + Provider·状态挤在一行，辨识度低
- **Agent Directory 占 244px 但内容空洞**：列表项只有文字，没有最近活动/任务摘要

#### 设置（08-settings）
- **像系统设置而非产品设置**：大量表单字段堆叠，没有分段引导
- **模型与提供商（#80）是进步**：但卡片设计仍偏功能化，缺少视觉吸引力

#### Provider 健康（10-provider-health）
- **只有两行文字**：「可用」「已阻断」，没有指标、趋势、诊断详情

#### Dispatch Picker（13-dispatch-picker）
- **对话框设计合理**但目标列表缺少 Provider 图标品牌感（已修复 #79）和实时状态反馈

### 3. 全局问题

| # | 问题 | 影响 |
|---|---|---|
| G1 | **没有真实 Agent 交互**——整个应用是 mock 外壳，核心价值（AI 编码）完全不可感知 | 致命 |
| G2 | **字号体系太小**——正文 10-11px、辅助文字 9px，在 HiDPI 屏上极难读 | 高 |
| G3 | **缺乏视觉层次**——几乎所有元素是同一灰度平面，缺少阴影/间距/分隔区分 | 中 |
| G4 | **零微交互**——没有 hover 动效、没有 loading 状态动画、没有 transition（除按钮外） | 中 |
| G5 | **空态设计缺失**——多处用纯文字「暂无 XX」，没有引导插画或行动建议 | 低 |
| G6 | **品牌感为零**——从截图看，不像是 2026 年的 AI 产品，像 2018 年的后台管理面板 | 高 |

---

## 第二部分：OpenDesign 对标

### 对标维度总览

| 维度 | Agent Squad HQ | OpenDesign | 差距 |
|---|---|---|---|
| **Agent 对话渲染** | 纯文本堆 | markdown + 代码高亮 + tool call 卡片 + streaming + 反馈 | 🔴 极大 |
| **Provider 图标** | 原创 SVG 几何标记 | 官方品牌 SVG（claude.svg 等真实商标） | 🟡 中 |
| **模型选择** | Settings 下拉框 | InlineModelSwitcher（顶栏 chip + 搜索式 picker） | 🔴 大 |
| **CLI 通信** | MockScenarioAdapter 全假 | daemon spawn + structured stdio（stream-json / JSONL / ACP）→ SSE | 🔴 极大 |
| **工具调用展示** | mono 文字 chip | ToolCard（分类渲染、todo 卡、文件操作摘要） | 🔴 大 |
| **项目首页** | 文字列表 | 项目封面图 + 协作状态 + 快速入口 | 🟡 中 |
| **布局架构** | 固定三栏 + 82px 图标轨 | Composer + ChatPane 浮层 + 可拖拽面板 | 🟡 中 |
| **动效/品牌** | 无 | Liquid Glass + 动态网格背景 + 品牌色系 | 🔴 大 |
| **Terminal 集成** | 契约存在但 mock | node-pty + xterm + SSE 完整链路 | 🔴 极大 |

### 关定差距逐项展开

#### 1. Agent 对话渲染（最大差距）

**OpenDesign** 的 `AssistantMessage.tsx`（~500 行）实现了：
- Markdown 渲染（`renderMarkdown`）+ 代码语法高亮
- Tool call 分类卡片（`ToolCard`）：todo 卡、文件操作摘要（`FileOpsSummary`）、问题表单（`QuestionFormView`）
- 流式 partial delta（text/thinking/tool-input 逐字呈现）
- 消息反馈（rating + reason）
- 下一步建议（`NextStepActions`）
- OdCard（产品内嵌交互卡片）

**Agent Squad HQ** 的 `ChatState` 只有：
- `chatEntries` 纯文本迭代 + mono tool chip
- 无 markdown、无高亮、无流式、无反馈

#### 2. CLI 通信架构

**OpenDesign** 的 daemon 已实现完整生产链路：
```
Web → POST /api/runs → daemon spawn CLI → structured stdio →
normalized events → SSE → React ChatPane
```
- Claude Code: `stream-json` over pipes，支持 partial messages
- Codex: `exec --json` JSONL
- Kimi: ACP JSON-RPC over stdio
- 每条消息独立进程，靠 session id resume

**Agent Squad HQ** 只有 MockScenarioAdapter——零真实通信。

#### 3. 模型选择体验

**OpenDesign** 的 `InlineModelSwitcher`（~1000 行）：
- 顶栏常驻 chip，一键切换模型
- 搜索式 picker（`SearchableModelSelect`），支持 CLI + BYOK 模型
- 实时显示当前 agent + model + balance 状态
- AMR（自动模型路由）集成

**Agent Squad HQ** 只在 Settings 表单和 New Agent 对话框里有下拉框。

#### 4. 品牌图标

**OpenDesign** 在 `public/agent-icons/` 存有官方品牌 SVG（`claude.svg` 是 Anthropic 原始 orange asterisk path，`codex.svg`、`kimi.svg` 等 30+ 个），通过 `modelProviderIconSrc()` 按 model id 映射。

**Agent Squad HQ** 用原创几何近似（#79），辨识度低于官方图标但避免了商标问题。颜色值一致（Claude `#d97757`）。

---

## 第三部分：建议的优先级路线

### P0 — 让产品「活」起来（核心价值可见）

1. **接入真实 CLI 通信**（参考 OpenDesign daemon 架构）
   - 从 `child_process.spawn` + structured stdio 开始
   - 先做 Claude Code `stream-json`，再扩 Codex / Kimi
   - 这是从「mock 外壳」到「真实 AI 工作台」的分水岭

2. **升级对话渲染**——markdown + 代码高亮 + tool call 卡片
   - 引入 `react-markdown` + `rehype-highlight`
   - Tool call 分类卡片（文件操作/todo/diff 预览）

3. **流式输出**——让用户看到 Agent 正在「思考」和「工作」

### P1 — 视觉品质提升

4. **字号放大 + 间距呼吸**——正文 12-13px，辅助 11px，行高 1.5
5. **品牌动效**——Liquid Glass / 渐变 / loading skeleton
6. **首页重做**——hero 区域 + 项目卡片（缩略 + 活动摘要 + 快速操作）
7. **空态插画 + 引导**——替换纯文字「暂无 XX」

### P2 — 功能对齐

8. **InlineModelSwitcher**——顶栏模型快速切换
9. **Terminal 集成**——node-pty + xterm（OpenDesign 已有完整参考）
10. **项目封面 / 协作状态**
