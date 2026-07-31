import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FakePty {
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  emitData(data: string): void
  emitExit(code?: number): void
}

const fakePtys = vi.hoisted(() => ({ instances: [] as FakePty[] }))

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    let exitHandler: ((event: { exitCode: number }) => void) | null = null
    let dataHandler: ((data: string) => void) | null = null
    const pty: FakePty = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn((handler: (data: string) => void) => {
        dataHandler = handler
      }),
      onExit: vi.fn((handler: (event: { exitCode: number }) => void) => {
        exitHandler = handler
      }),
      emitData(data) {
        dataHandler?.(data)
      },
      emitExit(code = 0) {
        exitHandler?.({ exitCode: code })
      }
    }
    fakePtys.instances.push(pty)
    return pty
  })
}))

import { PtyManager } from './pty-manager'

describe('PtyManager lifecycle', () => {
  beforeEach(() => {
    fakePtys.instances.length = 0
  })

  it('does not let a stale exit callback remove a replacement terminal', () => {
    const onData = vi.fn()
    const onExit = vi.fn()
    const manager = new PtyManager(
      () => '/tmp',
      onData,
      onExit
    )

    manager.ensure('claude')
    manager.dispose('claude')
    manager.ensure('claude')
    fakePtys.instances[0].emitData('stale')
    fakePtys.instances[0].emitExit()

    expect(manager.has('claude')).toBe(true)
    expect(fakePtys.instances).toHaveLength(2)
    expect(onData).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
  })
})
