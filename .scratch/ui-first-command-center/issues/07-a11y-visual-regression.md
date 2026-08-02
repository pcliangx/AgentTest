# 完成可访问性与视觉回归门禁

Type: task
Status: ready-for-agent
Blocked by: 02, 03, 04, 05, 06

## 范围

建立组件、键盘、焦点、状态文本、尺寸和视觉回归验收。

## 验收

- 拖放、divider、Tab、Agent Picker、Attention 和 Settings 有非指针路径。
- 状态不只依赖颜色，焦点顺序可预测，模态窗口焦点受控。
- 1280×800 及主要更大尺寸的视觉回归通过。
- `npm run typecheck && npm test && npm run build` 和 `git diff --check` 通过。
