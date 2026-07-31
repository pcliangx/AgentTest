import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

type Target = 'claude' | 'codex' | 'kimi'
const TARGETS: readonly Target[] = ['claude', 'codex', 'kimi']

interface Meta {
  status: 'idle' | 'running' | 'done'
  in?: number
  out?: number
  tool?: string
}
type MetaMap = Record<Target, Meta>

// @@ routing (ADR-0004): explicit @@target required; no @@ => not dispatched.
function parseTargets(input: string): { targets: Target[]; text: string; error?: string } {
  const match = input.match(/^(?:@@\w+\s+)+/)
  if (!match) {
    return { targets: [], text: input, error: '必须以 @@target 开头（@@claude / @@codex / @@kimi / @@all）' }
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
  const [repo, setRepo] = useState<{ name: string } | null>(null)
  const [meta, setMeta] = useState<MetaMap>({
    claude: { status: 'idle' },
    codex: { status: 'idle' },
    kimi: { status: 'idle' }
  })

  useEffect(() => {
    void window.api.getCurrentRepo().then((r) => {
      if (r) setRepo({ name: r.name })
    })
  }, [])

  // Structured sidecar: tokens / turn status / tool, from the transcript watcher.
  useEffect(() => {
    return window.api.onTranscript(({ target, event }) => {
      setMeta((prev) => {
        const t = target as Target
        const m: Meta = { ...prev[t] }
        const p = (event.payload ?? {}) as Record<string, unknown>
        if (event.kind === 'assistant-text') m.status = 'running'
        else if (event.kind === 'tool-start') {
          m.status = 'running'
          m.tool = typeof p.tool === 'string' ? p.tool : m.tool
        } else if (event.kind === 'usage') {
          if (typeof p.inputTokens === 'number') m.in = p.inputTokens
          if (typeof p.outputTokens === 'number') m.out = p.outputTokens
        } else if (event.kind === 'turn-complete') {
          m.status = 'done'
        }
        return { ...prev, [t]: m }
      })
    })
  }, [])

  async function pickRepo(): Promise<void> {
    const r = await window.api.pickRepo()
    if (r.ok) {
      setRepo({ name: r.name })
      setError(null)
    } else if (r.reason === 'not a git repo') {
      setError('选的目录不是 git 仓库')
    }
  }

  function submit(): void {
    const { targets, text, error: parseError } = parseTargets(input.trim())
    if (parseError || targets.length === 0) {
      setError(parseError ?? '无目标')
      return
    }
    setError(null)
    setMeta((prev) => {
      const next = { ...prev }
      for (const t of targets) next[t] = { ...next[t], status: 'running' }
      return next
    })
    targets.forEach((t) => window.api.run(t, text))
    setInput('')
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2 text-sm">
        <div className="flex items-center gap-2 text-neutral-400">
          <span className="text-neutral-200">AgentTest</span>
          <span className="text-neutral-700">·</span>
          <span className={repo ? 'text-neutral-300' : 'text-amber-400'}>
            {repo ? repo.name : '演示模式（空临时仓库）'}
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
        {TARGETS.map((t) => (
          <Pane key={t} target={t} meta={meta[t]} />
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

function Pane({ target, meta }: { target: Target; meta: Meta }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const term = new Terminal({
      fontFamily: 'menlo, monospace',
      fontSize: 12,
      theme: { background: '#0a0a0a', foreground: '#e5e5e5' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    fit.fit()
    window.api.ptyResize(target, term.cols, term.rows)

    const offData = window.api.onPtyData(({ target: t, data }) => {
      if (t === target) term.write(data)
    })
    const inputDisp = term.onData((data) => window.api.ptyInput(target, data))
    const onResize = () => {
      fit.fit()
      window.api.ptyResize(target, term.cols, term.rows)
    }
    window.addEventListener('resize', onResize)

    return () => {
      offData()
      inputDisp.dispose()
      window.removeEventListener('resize', onResize)
      term.dispose()
    }
  }, [target])

  const statusColor =
    meta.status === 'running' ? 'text-amber-400' : meta.status === 'done' ? 'text-emerald-400' : 'text-neutral-500'

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded bg-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-1 text-xs">
        <span className="text-neutral-400">@@{target}</span>
        <span className={`${statusColor} font-mono`}>
          {meta.status === 'idle' ? (
            'idle'
          ) : (
            <>
              {meta.in !== undefined || meta.out !== undefined ? (
                <span className="text-neutral-300">
                  ↑{meta.in ?? 0} ↓{meta.out ?? 0}
                </span>
              ) : null}
              <span className="ml-2">{meta.status}</span>
              {meta.tool ? <span className="ml-2 text-neutral-500">{meta.tool}</span> : null}
            </>
          )}
        </span>
      </div>
      <div ref={ref} className="min-h-0 flex-1 overflow-hidden p-1" />
    </div>
  )
}
