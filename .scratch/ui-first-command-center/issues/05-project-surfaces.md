# 实现 Project Overview、Tasks、Knowledge、Handoffs 与 Activity

Type: task
Status: ready-for-agent
Blocked by: 01, 02, 04

## 范围

使用 mock 契约实现五个工作面的完整状态，包括本地 Task、飞书投影、结果验收、
浏览器容器状态、handoff completeness 和审计时间线。

## 验收

- 未连飞书、offline、conflict 与 unavailable 均有独立状态。
- 外部变化只更新投影/Attention，不启动 Agent。
- Knowledge 只是容器与安全反馈，不接真实 partition/导航。
