# AGENTS.md

本项目正交接给 Codex 继续开发。**请先读 [`docs/HANDOFF.md`](./docs/HANDOFF.md)** —— 它包含完整的项目说明、当前状态、架构、命令、关键约定、已知坑和下一步建议。

要点速览：

- **是什么**：Electron 壳，嵌入 Claude Code / Codex / Kimi Code 三个 agent CLI；`@@` 路由默认走结构化 stdio（Claude stream-json / Codex JSONL / Kimi ACP）；每 agent 一个隔离 worktree；PTY 仅用于显式 Terminal 接管；可查看/合并 worktree 改动。
- **跑起来**：`npm install --legacy-peer-deps` → `npm run rebuild:native`（node-pty 原生编译）→ `npm run dev`。重装 node_modules 后**必须**重跑 `rebuild:native`。
- **验证**：`npm run typecheck && npm test && npm run build`（提交前必跑）；真实 CLI 验证用 `AGENTTEST_E2E=1`。
- **关键约束**：registry/router 禁 `switch(agentId)`；子进程用 `spawn` / `execFileSync` + 参数数组且禁 shell；结构化 Chat 与同 agent 的 Terminal PTY 互斥；面向用户文案用中文、代码用英文。
- **当前决策**：[`ADR-0007`](./docs/adr/0007-structured-chat-pty-terminal.md)；以 `git rev-parse HEAD` 查看最新提交。

详见 `docs/HANDOFF.md`。
