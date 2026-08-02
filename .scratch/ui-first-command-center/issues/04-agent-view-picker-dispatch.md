# 实现 Agent View、Agent Picker 与显式 Dispatch

Type: task
Status: ready-for-agent
Blocked by: 01, 03

## 范围

实现 Agent Directory、Chat/Activity/Changes/Terminal 二级结构、实例 composer、统一 Agent Picker、
目标 chips、Dispatch 预览和队列反馈。

## 验收

- Agent Tab composer 只发当前实例；其他入口必须有可见目标。
- `@@all` 展开具体实例并确认；assistant 输出不触发派发。
- active Run 的新工作显示为回复当前 Run 或下一 Run 队列，不出现第二 active Run。
