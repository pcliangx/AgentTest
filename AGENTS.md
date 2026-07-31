# AGENTS.md

本项目正交接给 Codex 继续开发。**请先读 [`docs/HANDOFF.md`](./docs/HANDOFF.md)** —— 它包含完整的项目说明、当前状态、架构、命令、关键约定、已知坑和下一步建议。

要点速览：

- **是什么**：Electron 壳，嵌入 Claude Code / Codex / Kimi Code 三个 agent CLI；`@@` 路由；每 agent 一个常驻 PTY（原生 TUI）+ 隔离 worktree；claude 有 transcript 结构化旁路；可查看/合并 worktree 改动。
- **跑起来**：`npm install --legacy-peer-deps` → `npm run rebuild:native`（node-pty 原生编译）→ `npm run dev`。重装 node_modules 后**必须**重跑 `rebuild:native`。
- **验证**：`npm run typecheck && npm test && npm run build`（提交前必跑）；真实 CLI 验证用 `AGENTTEST_E2E=1`。
- **关键约束**：registry/router 禁 `switch(agentId)`；子进程用 `execFileSync`+参数数组（无 shell）；结构化 adapter 代码休眠但保留；面向用户文案用中文、代码用英文。
- **当前最新提交**：`a2b02bb`（main，已推送）。

详见 `docs/HANDOFF.md`。
