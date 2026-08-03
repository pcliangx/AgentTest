import { appendFileSync } from 'node:fs'
import type { Session } from 'electron'

export const UI_SMOKE_NETWORK_FILTER_URLS = [
  'http://*/*',
  'https://*/*',
  'ws://*/*',
  'wss://*/*'
] as const

/**
 * Installs the smoke guard on Electron's session before any renderer is
 * loaded. Cancelling happens before evidence is written, so a diagnostic
 * filesystem failure can never turn into an allowed request.
 */
export function installUiSmokeNetworkGuard(
  electronSession: Session,
  evidencePath: string
): void {
  electronSession.webRequest.onBeforeRequest(
    { urls: [...UI_SMOKE_NETWORK_FILTER_URLS] },
    (details, callback) => {
      callback({ cancel: true })

      const record = JSON.stringify({
        url: details.url,
        resourceType: details.resourceType
      })
      try {
        appendFileSync(evidencePath, `${record}\n`, 'utf8')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(
          `[ui-smoke:network-evidence-error] ${message}`
        )
      }
      console.warn(`[ui-smoke:network-blocked] ${details.url}`)
    }
  )
}
