import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installUiSmokeNetworkGuard,
  UI_SMOKE_NETWORK_FILTER_URLS
} from './ui-smoke-network-guard'

type BeforeRequestListener = (
  details: { url: string; resourceType: string },
  callback: (response: { cancel: boolean }) => void
) => void

function capturingSession(): {
  readonly session: Session
  readonly listener: () => BeforeRequestListener
  readonly filter: () => unknown
} {
  let capturedListener: BeforeRequestListener | undefined
  let capturedFilter: unknown
  const session = {
    webRequest: {
      onBeforeRequest(filter: unknown, listener: BeforeRequestListener) {
        capturedFilter = filter
        capturedListener = listener
      }
    }
  } as unknown as Session

  return {
    session,
    listener: () => {
      if (!capturedListener) throw new Error('network guard was not installed')
      return capturedListener
    },
    filter: () => capturedFilter
  }
}

describe('UI smoke network guard', () => {
  afterEach(() => vi.restoreAllMocks())

  it('blocks and records HTTP and WebSocket requests', () => {
    const evidenceDirectory = mkdtempSync(
      join(tmpdir(), 'agent-squad-hq-ui-network-guard-')
    )
    const evidencePath = join(evidenceDirectory, 'blocked-network.jsonl')
    const fake = capturingSession()

    try {
      installUiSmokeNetworkGuard(fake.session, evidencePath)
      expect(fake.filter()).toEqual({ urls: UI_SMOKE_NETWORK_FILTER_URLS })

      const urls = [
        'http://ui-smoke.invalid/http',
        'https://ui-smoke.invalid/https',
        'ws://ui-smoke.invalid/ws',
        'wss://ui-smoke.invalid/wss'
      ]
      for (const url of urls) {
        let response: { cancel: boolean } | undefined
        fake.listener()(
          { url, resourceType: 'other' },
          (result) => (response = result)
        )
        expect(response).toEqual({ cancel: true })
      }

      const records = readFileSync(evidencePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { url: string })
      expect(records.map((record) => record.url)).toEqual(urls)
    } finally {
      rmSync(evidenceDirectory, { recursive: true, force: true })
    }
  })

  it('still blocks when diagnostic evidence cannot be written', () => {
    const fake = capturingSession()
    const evidenceDirectory = mkdtempSync(
      join(tmpdir(), 'agent-squad-hq-ui-network-guard-failure-')
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      installUiSmokeNetworkGuard(
        fake.session,
        join(evidenceDirectory, 'missing', 'blocked-network.jsonl')
      )

      let response: { cancel: boolean } | undefined
      expect(() =>
        fake.listener()(
          { url: 'https://ui-smoke.invalid/fail-closed', resourceType: 'xhr' },
          (result) => (response = result)
        )
      ).not.toThrow()
      expect(response).toEqual({ cancel: true })
    } finally {
      rmSync(evidenceDirectory, { recursive: true, force: true })
    }
  })
})
