# 实现 Workspace Layout、Tab 与 Panel 交互

Type: task
Status: ready-for-agent
Blocked by: 01, 02

## 范围

实现纯 split-tree reducer，包括 Tab 唯一、激活/关闭/跨 Panel 移动、边缘 split、divider、
Focus/Analysis 和布局草稿保存 port。

## 验收

- reducer 有不变量/property tests，不调用 runtime、PTY、Git 或删除逻辑。
- 鼠标与键盘均可切换 Tab、移动 Tab 和调整 divider。
- 1280×800 下 3 Panel 可用；4+ 使用明确滚动/溢出，只非阻断提示。
