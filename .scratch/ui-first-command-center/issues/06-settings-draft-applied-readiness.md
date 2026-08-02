# 实现 Settings draft/applied 与 Readiness 视图

Type: task
Status: ready-for-agent
Blocked by: 01, 02

## 范围

以 A 为唯一完整设置编辑器，实现 General、Defaults、Instances、Integrations、Permissions、
Storage；增加 B 策略比较和 C readiness 摘要。

## 验收

- 草稿 key 为 owner ID + field path；多实例同名字段不串线。
- Discard 恢复 applied；Apply 更新 appliedVersion，当前 Run 不变。
- Provider 不可用时不能创建/配置；原有实例只读恢复。
- 飞书主连接支持 `0..1`；浏览器与 Connector 身份、scope 和不可绕过确认分开。
