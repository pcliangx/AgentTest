export type PaneRunStatus =
  | 'idle'
  | 'running'
  | 'finishing'
  | 'done'
  | 'canceled'
  | 'error'
export type ChatItemKind = 'user' | 'assistant' | 'thinking' | 'tool' | 'notice' | 'error'

export interface ChatItem {
  readonly id: string
  readonly kind: ChatItemKind
  readonly text: string
  readonly toolId?: string
  readonly title?: string
  readonly status?: 'running' | 'ok' | 'error'
}

export interface PaneChatState {
  readonly status: PaneRunStatus
  readonly items: readonly ChatItem[]
  readonly usage?: { readonly input: number; readonly output: number }
  readonly activeTool?: string
}

export interface StructuredAgentEvent {
  readonly kind: string
  readonly occurredAt: number
  readonly source: string
  readonly payload: unknown
}

function payload(event: StructuredAgentEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object'
    ? (event.payload as Record<string, unknown>)
    : {}
}

function itemId(event: StructuredAgentEvent, index: number): string {
  return `${event.occurredAt}:${event.kind}:${index}`
}

export function emptyPaneState(): PaneChatState {
  return { status: 'idle', items: [] }
}

export function addUserMessage(state: PaneChatState, text: string): PaneChatState {
  return {
    ...state,
    status: 'running',
    activeTool: undefined,
    items: [
      ...state.items,
      {
        id: `user:${Date.now()}:${state.items.length}`,
        kind: 'user',
        text
      }
    ]
  }
}

function appendText(
  state: PaneChatState,
  event: StructuredAgentEvent,
  kind: 'assistant' | 'thinking',
  text: string
): PaneChatState {
  if (!text) return state
  const last = state.items.at(-1)
  if (last?.kind === kind) {
    return {
      ...state,
      status: 'running',
      items: [...state.items.slice(0, -1), { ...last, text: `${last.text}${text}` }]
    }
  }
  return {
    ...state,
    status: 'running',
    items: [
      ...state.items,
      { id: itemId(event, state.items.length), kind, text }
    ]
  }
}

export function applyAgentEvent(
  state: PaneChatState,
  event: StructuredAgentEvent
): PaneChatState {
  const data = payload(event)

  if (event.kind === 'assistant-text') {
    return appendText(
      state,
      event,
      'assistant',
      typeof data['text'] === 'string' ? data['text'] : ''
    )
  }
  if (event.kind === 'thinking') {
    return appendText(
      state,
      event,
      'thinking',
      typeof data['text'] === 'string' ? data['text'] : ''
    )
  }
  if (event.kind === 'tool-start') {
    const toolId = typeof data['id'] === 'string' ? data['id'] : itemId(event, state.items.length)
    const title = typeof data['tool'] === 'string' ? data['tool'] : 'Tool'
    const argument = typeof data['arg'] === 'string' ? data['arg'] : ''
    return {
      ...state,
      status: 'running',
      activeTool: title,
      items: [
        ...state.items,
        {
          id: itemId(event, state.items.length),
          kind: 'tool',
          toolId,
          title,
          text: argument,
          status: 'running'
        }
      ]
    }
  }
  if (event.kind === 'tool-end') {
    const toolId = typeof data['id'] === 'string' ? data['id'] : null
    const items = state.items.map((item) =>
      item.kind === 'tool' && (!toolId || item.toolId === toolId)
        ? {
            ...item,
            status: data['status'] === 'error' ? ('error' as const) : ('ok' as const)
          }
        : item
    )
    return { ...state, items, activeTool: undefined }
  }
  if (event.kind === 'usage') {
    return {
      ...state,
      usage: {
        input: typeof data['inputTokens'] === 'number' ? data['inputTokens'] : 0,
        output: typeof data['outputTokens'] === 'number' ? data['outputTokens'] : 0
      }
    }
  }
  if (event.kind === 'turn-complete') {
    if (state.status === 'error' || state.status === 'canceled') return state
    return { ...state, status: 'finishing', activeTool: undefined }
  }
  if (event.kind === 'warning') {
    const message =
      typeof data['message'] === 'string'
        ? data['message']
        : typeof data['stderr'] === 'string'
          ? data['stderr']
          : ''
    if (!message.trim()) return state
    return {
      ...state,
      items: [
        ...state.items,
        { id: itemId(event, state.items.length), kind: 'notice', text: message.trim() }
      ]
    }
  }
  if (event.kind === 'error') {
    const message =
      typeof data['message'] === 'string' ? data['message'] : 'Agent 执行失败'
    return {
      ...state,
      status: 'error',
      activeTool: undefined,
      items: [
        ...state.items,
        { id: itemId(event, state.items.length), kind: 'error', text: message }
      ]
    }
  }
  if (event.kind === 'process-exited' && data['canceled'] === true) {
    return { ...state, status: 'canceled', activeTool: undefined }
  }
  if (
    event.kind === 'process-exited' &&
    data['code'] === 0 &&
    state.status === 'finishing'
  ) {
    return { ...state, status: 'done', activeTool: undefined }
  }
  if (event.kind === 'process-exited' && data['code'] !== 0 && state.status !== 'error') {
    return {
      ...state,
      status: 'error',
      activeTool: undefined,
      items: [
        ...state.items,
        {
          id: itemId(event, state.items.length),
          kind: 'error',
          text: `Agent 进程退出（code ${String(data['code'])}）`
        }
      ]
    }
  }
  return state
}
