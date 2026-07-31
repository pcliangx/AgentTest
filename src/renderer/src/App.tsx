import { useEffect, useState } from 'react'

type Target = 'claude' | 'codex' | 'kimi'
const TARGETS: readonly Target[] = ['claude', 'codex', 'kimi']

interface ParseResult {
  targets: Target[]
  text: string
  error?: string
}

// @@ routing (ADR-0004): targets must be explicit; no @@ => not dispatched.
function parseTargets(input: string): ParseResult {
  const match = input.match(/^(?:@@\w+\s+)+/)
  if (!match) {
    return { targets: [], text: input, error: '必须以 @@target 开头（如 @@claude / @@all）' }
  }
  const prefix = match[0]
  const mentions = prefix.match(/@@(\w+)/g)!.map((s) => s.slice(2))
  const text = input.slice(prefix.length)

  let targets: Target[]
  if (mentions.includes('all')) {
    targets = [...TARGETS]
  } else {
    targets = [...new Set(mentions.filter((t) => (TARGETS as readonly string[]).includes(t)) as Target[])]
  }
  if (targets.length === 0) return { targets: [], text, error: '没有有效的 @@target' }
  return { targets, text }
}

export default function App() {
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [events, setEvents] = useState<Record<Target, AgentEventView[]>>({
    claude: [],
    codex: [],
    kimi: []
  })

  useEffect(() => {
    const off = window.api.onEvent(({ target, event }) => {
      setEvents((prev) => ({ ...prev, [target]: [...prev[target as Target], event] }))
    })
    return off
  }, [])

  function submit(): void {
    const { targets, text, error: parseError } = parseTargets(input.trim())
    if (parseError || targets.length === 0) {
      setError(parseError ?? '无目标')
      return
    }
    setError(null)
    setEvents((prev) => {
      const next = { ...prev }
      targets.forEach((t) => (next[t] = []))
      return next
    })
    targets.forEach((t) => window.api.run(t, text))
    setInput('')
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-4 py-2 text-sm text-neutral-400">
        AgentTest · Phase 0（dummy spawn · IPC 全链路验证）
      </header>

      <div className="grid flex-1 grid-cols-3 gap-2 overflow-hidden p-2">
        {TARGETS.map((t) => (
          <Pane key={t} target={t} events={events[t]} />
        ))}
      </div>

      {error && <div className="bg-red-950/40 px-3 py-1 text-xs text-red-400">{error}</div>}

      <div className="flex gap-2 border-t border-neutral-800 p-2">
        <input
          className="flex-1 rounded bg-neutral-900 px-3 py-2 outline-none placeholder:text-neutral-600 focus:ring-1 focus:ring-blue-600"
          placeholder="@@claude / @@codex / @@kimi / @@all  你的消息（无 @@ 不派发）"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <button className="rounded bg-blue-600 px-4 hover:bg-blue-500" onClick={submit}>
          发送
        </button>
      </div>
    </div>
  )
}

function Pane({ target, events }: { target: Target; events: AgentEventView[] }) {
  return (
    <div className="flex flex-col overflow-hidden rounded bg-neutral-900">
      <div className="border-b border-neutral-800 px-3 py-1 text-xs text-neutral-400">@@{target}</div>
      <div className="flex-1 space-y-1 overflow-auto p-2 font-mono text-xs">
        {events.length === 0 ? (
          <span className="text-neutral-600">idle</span>
        ) : (
          events.map((e, i) => (
            <div key={i}>
              <span className="text-neutral-500">[{e.kind}]</span> {summarize(e)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function summarize(e: AgentEventView): string {
  const p = (e.payload ?? {}) as Record<string, unknown>
  switch (e.kind) {
    case 'assistant-text':
      return String(p.text ?? '')
    case 'tool-start':
      return `${p.tool}(${p.arg ?? ''})`
    case 'tool-end':
      return `${p.tool} → ${p.status}`
    case 'usage':
      return `tokens=${p.tokens}`
    case 'turn-complete':
      return '✓ turn complete'
    case 'process-exited':
      return `exit code=${p.code}`
    default:
      return JSON.stringify(p)
  }
}
