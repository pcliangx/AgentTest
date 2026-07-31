import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

type Target = 'claude' | 'codex' | 'kimi'
const TARGETS: readonly Target[] = ['claude', 'codex', 'kimi']

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

  function submit(): void {
    const { targets, text, error: parseError } = parseTargets(input.trim())
    if (parseError || targets.length === 0) {
      setError(parseError ?? '无目标')
      return
    }
    setError(null)
    targets.forEach((t) => window.api.run(t, text))
    setInput('')
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-4 py-2 text-sm text-neutral-400">
        AgentTest · PTY 原生 TUI · 输入栏用 <code className="text-neutral-200">@@</code> 路由，或直接在终端里打字
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-3 gap-1 overflow-hidden p-1">
        {TARGETS.map((t) => (
          <Pane key={t} target={t} />
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

function Pane({ target }: { target: Target }) {
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

  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded bg-neutral-900">
      <div className="border-b border-neutral-800 px-3 py-1 text-xs text-neutral-400">@@{target}</div>
      <div ref={ref} className="min-h-0 flex-1 overflow-hidden p-1" />
    </div>
  )
}
