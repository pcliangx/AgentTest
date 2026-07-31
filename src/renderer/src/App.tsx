import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  addUserMessage,
  applyAgentEvent,
  emptyPaneState,
  type ChatItem,
  type PaneChatState,
  type StructuredAgentEvent
} from './chat-state'

type Target = 'claude' | 'codex' | 'kimi'
const TARGETS: readonly Target[] = ['claude', 'codex', 'kimi']

type ChatMap = Record<Target, PaneChatState>

interface ChangesView {
  target: Target
  exists: boolean
  files: WorktreeFile[]
  summary: string | null
}

function initialChats(): ChatMap {
  return {
    claude: emptyPaneState(),
    codex: emptyPaneState(),
    kimi: emptyPaneState()
  }
}

// @@ routing (ADR-0004): explicit @@target required; no @@ => not dispatched.
function parseTargets(input: string): { targets: Target[]; text: string; error?: string } {
  const match = input.match(/^(?:@@\w+\s+)+/)
  if (!match) {
    return {
      targets: [],
      text: input,
      error: '必须以 @@target 开头（@@claude / @@codex / @@kimi / @@all）'
    }
  }
  const prefix = match[0]
  const mentions = prefix.match(/@@(\w+)/g)!.map((value) => value.slice(2))
  const text = input.slice(prefix.length)
  const targets = mentions.includes('all')
    ? [...TARGETS]
    : ([
        ...new Set(
          mentions.filter((target) =>
            (TARGETS as readonly string[]).includes(target)
          ) as Target[]
        )
      ] as Target[])
  if (targets.length === 0) return { targets: [], text, error: '没有有效的 @@target' }
  if (!text.trim()) return { targets: [], text, error: '消息不能为空' }
  return { targets, text }
}

function runFailureText(reason: string): string {
  switch (reason) {
    case 'busy':
      return '这个 Agent 正在执行上一条请求'
    case 'terminal-active':
      return '这个 Agent 正处于 Terminal 接管模式，请先切回 Chat'
    case 'unknown-agent':
      return 'Agent 未注册'
    default:
      return 'Agent 进程启动失败'
  }
}

function syntheticError(message: string): StructuredAgentEvent {
  return {
    kind: 'error',
    occurredAt: Date.now(),
    source: 'inferred',
    payload: { message }
  }
}

export default function App() {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [repo, setRepo] = useState<{ name: string } | null>(null)
  const [changes, setChanges] = useState<ChangesView | null>(null)
  const [chats, setChats] = useState<ChatMap>(initialChats)

  useEffect(() => {
    void window.api.getCurrentRepo().then((current) => {
      if (current) setRepo({ name: current.name })
    })
  }, [])

  useEffect(
    () =>
      window.api.onAgentEvent(({ target, event }) => {
        if (!(TARGETS as readonly string[]).includes(target)) return
        setChats((previous) => ({
          ...previous,
          [target]: applyAgentEvent(previous[target as Target], event)
        }))
      }),
    []
  )

  async function pickRepo(): Promise<void> {
    const result = await window.api.pickRepo()
    if (result.ok) {
      setRepo({ name: result.name })
      setChats(initialChats())
      setError(null)
    } else if (result.reason === 'not a git repo') {
      setError('选的目录不是 git 仓库')
    }
  }

  async function showChanges(target: Target): Promise<void> {
    const status = await window.api.worktreeStatus(target)
    setChanges({ target, ...status })
  }

  async function submit(): Promise<void> {
    const parsed = parseTargets(input.trim())
    if (parsed.error || parsed.targets.length === 0) {
      setError(parsed.error ?? '无目标')
      return
    }
    setError(null)
    setChats((previous) => {
      const next = { ...previous }
      for (const target of parsed.targets) {
        next[target] = addUserMessage(next[target], parsed.text)
      }
      return next
    })
    setInput('')

    const results = await Promise.all(
      parsed.targets.map(async (target) => ({
        target,
        result: await window.api.run(target, parsed.text)
      }))
    )
    for (const { target, result } of results) {
      if (result.ok) continue
      setChats((previous) => ({
        ...previous,
        [target]: applyAgentEvent(
          previous[target],
          syntheticError(runFailureText(result.reason))
        )
      }))
    }
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-sm">
        <div className="flex items-center gap-2 text-neutral-400">
          <span className="font-medium text-neutral-100">AgentTest</span>
          <span className="text-neutral-700">·</span>
          <span className={repo ? 'text-neutral-300' : 'text-amber-400'}>
            {repo ? repo.name : '演示模式（空临时仓库）'}
          </span>
          <span className="ml-2 rounded bg-emerald-950 px-2 py-0.5 text-[10px] text-emerald-400">
            structured
          </span>
        </div>
        <button
          className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
          onClick={() => void pickRepo()}
        >
          打开仓库
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-3 gap-1 overflow-hidden p-1">
        {TARGETS.map((target) => (
          <Pane
            key={target}
            target={target}
            chat={chats[target]}
            onCancel={() => void window.api.cancel(target)}
            onShowChanges={() => void showChanges(target)}
          />
        ))}
      </div>

      {error && <div className="bg-red-950/40 px-3 py-1 text-xs text-red-400">{error}</div>}

      <div className="flex gap-2 border-t border-neutral-800 p-2">
        <input
          className="flex-1 rounded bg-neutral-900 px-3 py-2 outline-none placeholder:text-neutral-600 focus:ring-1 focus:ring-blue-600"
          placeholder="@@claude / @@codex / @@kimi / @@all  你的消息（默认走结构化协议）"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />
        <button
          className="rounded bg-blue-600 px-4 hover:bg-blue-500 disabled:opacity-40"
          disabled={!input.trim()}
          onClick={() => void submit()}
        >
          发送
        </button>
      </div>

      {changes && <ChangesModal changes={changes} onClose={() => setChanges(null)} />}
    </div>
  )
}

function Pane({
  target,
  chat,
  onCancel,
  onShowChanges
}: {
  target: Target
  chat: PaneChatState
  onCancel: () => void
  onShowChanges: () => void
}) {
  const [mode, setMode] = useState<'chat' | 'terminal'>('chat')
  const structuredRunActive =
    chat.status === 'running' || chat.status === 'finishing'
  const statusColor =
    structuredRunActive
      ? 'text-amber-400'
      : chat.status === 'done'
        ? 'text-emerald-400'
        : chat.status === 'canceled'
          ? 'text-neutral-400'
        : chat.status === 'error'
          ? 'text-red-400'
          : 'text-neutral-500'

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-800 px-2 py-1 text-xs">
        <div className="flex items-center gap-1">
          <span className="mr-1 text-neutral-300">@@{target}</span>
          <button
            className={`rounded px-2 py-0.5 ${
              mode === 'chat'
                ? 'bg-neutral-700 text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-200'
            }`}
            onClick={() => setMode('chat')}
          >
            Chat
          </button>
          <button
            className={`rounded px-2 py-0.5 ${
              mode === 'terminal'
                ? 'bg-neutral-700 text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-200'
            } disabled:cursor-not-allowed disabled:opacity-30`}
            disabled={structuredRunActive}
            title={
              structuredRunActive
                ? '结构化请求运行中，暂不能接管 Terminal'
                : '打开原生 Agent TUI'
            }
            onClick={() => setMode('terminal')}
          >
            Terminal
          </button>
          <button onClick={onShowChanges} className="ml-1 text-neutral-600 hover:text-neutral-200">
            改动
          </button>
        </div>
        <div className="flex items-center gap-2 font-mono">
          {chat.usage && (
            <span className="text-neutral-400">
              ↑{chat.usage.input} ↓{chat.usage.output}
            </span>
          )}
          {chat.activeTool && <span className="max-w-20 truncate text-neutral-500">{chat.activeTool}</span>}
          <span className={statusColor}>{chat.status}</span>
          {structuredRunActive && (
            <button className="text-red-400 hover:text-red-300" onClick={onCancel}>
              停止
            </button>
          )}
        </div>
      </div>
      {mode === 'chat' ? (
        <StructuredChat items={chat.items} />
      ) : (
        <TerminalTakeover target={target} />
      )}
    </div>
  )
}

function StructuredChat({ items }: { items: readonly ChatItem[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = ref.current
    if (element) element.scrollTop = element.scrollHeight
  }, [items])

  return (
    <div ref={ref} className="min-h-0 flex-1 space-y-2 overflow-auto p-3 text-xs">
      {items.length === 0 && (
        <div className="flex h-full items-center justify-center text-center text-neutral-600">
          <span>
            统一输入栏发送请求
            <br />
            结构化事件会显示在这里
          </span>
        </div>
      )}
      {items.map((item) => (
        <ChatRow key={item.id} item={item} />
      ))}
    </div>
  )
}

function ChatRow({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <div className="ml-8 rounded-lg bg-blue-950/70 px-3 py-2 text-blue-100 whitespace-pre-wrap">
        {item.text}
      </div>
    )
  }
  if (item.kind === 'assistant') {
    return <div className="whitespace-pre-wrap leading-relaxed text-neutral-200">{item.text}</div>
  }
  if (item.kind === 'thinking') {
    return (
      <details className="rounded border border-neutral-800 bg-neutral-950/40 px-2 py-1 text-neutral-500">
        <summary className="cursor-pointer select-none">思考过程</summary>
        <div className="mt-1 whitespace-pre-wrap">{item.text}</div>
      </details>
    )
  }
  if (item.kind === 'tool') {
    const color =
      item.status === 'running'
        ? 'text-amber-400'
        : item.status === 'error'
          ? 'text-red-400'
          : 'text-emerald-400'
    return (
      <div className="rounded border border-neutral-800 bg-neutral-950/50 px-2 py-1.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-neutral-300">{item.title}</span>
          <span className={color}>{item.status}</span>
        </div>
        {item.text && <div className="mt-1 truncate font-mono text-neutral-600">{item.text}</div>}
      </div>
    )
  }
  if (item.kind === 'error') {
    return <div className="rounded bg-red-950/40 px-2 py-1.5 text-red-300">{item.text}</div>
  }
  return <div className="rounded bg-neutral-800/50 px-2 py-1 text-neutral-500">{item.text}</div>
}

function TerminalTakeover({ target }: { target: Target }) {
  const ref = useRef<HTMLDivElement>(null)
  const [openError, setOpenError] = useState<string | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const terminal = new Terminal({
      fontFamily: 'menlo, monospace',
      fontSize: 12,
      theme: { background: '#0a0a0a', foreground: '#e5e5e5' }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(element)
    fit.fit()

    const offData = window.api.onPtyData(({ target: eventTarget, data }) => {
      if (eventTarget === target) terminal.write(data)
    })
    const inputDisposable = terminal.onData((data) => window.api.ptyInput(target, data))
    const resize = () => {
      fit.fit()
      window.api.ptyResize(target, terminal.cols, terminal.rows)
    }
    window.addEventListener('resize', resize)
    void window.api.terminalOpen(target).then((result) => {
      if (result.ok) {
        window.api.ptyResize(target, terminal.cols, terminal.rows)
      } else {
        setOpenError(
          result.reason === 'structured-run-active'
            ? '结构化请求仍在运行，无法接管 Terminal'
            : '原生 Terminal 启动失败'
        )
      }
    })

    return () => {
      void window.api.terminalClose(target)
      offData()
      inputDisposable.dispose()
      window.removeEventListener('resize', resize)
      terminal.dispose()
    }
  }, [target])

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div ref={ref} className="h-full p-1" />
      {openError && (
        <div className="absolute inset-x-2 top-2 rounded bg-red-950/90 px-2 py-1 text-xs text-red-300">
          {openError}
        </div>
      )}
    </div>
  )
}

function applyFailText(reason: string): string {
  switch (reason) {
    case 'dirty-base':
      return '主仓库有未提交改动——先提交或 stash 再试'
    case 'diverged':
      return '主仓库已超前于该 worktree 起点（agent 跑完后主仓库有新提交）——需手动合并'
    case 'no-changes':
      return '没有改动可合并'
    case 'no-worktree':
      return '没有工作目录'
    default:
      return `git 操作失败（${reason}）`
  }
}

function ChangesModal({ changes, onClose }: { changes: ChangesView; onClose: () => void }) {
  const [applyMsg, setApplyMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const canApply = changes.exists && changes.files.length > 0

  async function apply(): Promise<void> {
    if (
      !window.confirm(
        `把 @@${changes.target} 的改动 fast-forward 合并到主仓库当前分支？\n（仅快进；主仓库须干净，否则不会改动。）`
      )
    ) {
      return
    }
    setBusy(true)
    const result = await window.api.worktreeApply(changes.target)
    setBusy(false)
    setApplyMsg(
      result.ok
        ? `✓ 已合并到主仓库（branch: ${result.branch}）`
        : `✗ ${applyFailText(result.reason)}`
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-neutral-900 p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm text-neutral-200">@@{changes.target} 的改动</h2>
          <div className="flex gap-2">
            <button
              className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
              disabled={!changes.exists || busy}
              onClick={() => void window.api.worktreeOpen(changes.target)}
            >
              在 Finder 打开
            </button>
            <button
              className="rounded bg-blue-700 px-3 py-1 text-xs text-neutral-100 hover:bg-blue-600 disabled:opacity-40"
              disabled={!canApply || busy}
              onClick={() => void apply()}
            >
              {busy ? '合并中…' : '合并到主仓库'}
            </button>
            <button
              className="rounded bg-neutral-800 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        </div>

        {applyMsg && (
          <div className="mb-3 rounded bg-neutral-800 px-3 py-2 text-xs text-neutral-200">
            {applyMsg}
          </div>
        )}

        <div className="overflow-auto">
          {!changes.exists ? (
            <p className="text-sm text-neutral-500">这个 agent 还没有工作目录——先发一条消息让它启动。</p>
          ) : changes.files.length === 0 ? (
            <p className="text-sm text-neutral-500">无改动（工作区干净）。</p>
          ) : (
            <>
              {changes.summary && (
                <p className="mb-2 font-mono text-xs text-emerald-400">{changes.summary}</p>
              )}
              <ul className="space-y-1 font-mono text-xs">
                {changes.files.map((file, index) => (
                  <li key={index} className="flex gap-2">
                    <span className="w-8 shrink-0 text-amber-400">{file.flag.trim() || '?'}</span>
                    <span className="text-neutral-300">{file.path}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
