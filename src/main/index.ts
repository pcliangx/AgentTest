import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  APP_DISPLAY_NAME,
  APP_ID,
  prepareApplicationDataDirectory
} from './app-identity'
import { resolveUiSmokeMode } from './ui-smoke-mode'

let mainWindow: BrowserWindow | null = null
let services: typeof import('./ipc') | undefined

app.setName(APP_DISPLAY_NAME)
app.setAppUserModelId(APP_ID)

const uiSmokeMode = resolveUiSmokeMode(process.env)
const applicationData = uiSmokeMode.enabled
  ? { path: uiSmokeMode.userDataPath, status: 'current' as const }
  : prepareApplicationDataDirectory(app.getPath('appData'))
app.setPath('userData', applicationData.path)
app.setPath('sessionData', applicationData.path)

if (applicationData.status === 'migrated') {
  console.info('Agent Squad HQ copied legacy application data into the stable data directory.')
} else if (applicationData.status === 'legacy-fallback') {
  console.warn('Agent Squad HQ could not migrate legacy application data and will use it in place.')
}

function createWindow(): void {
  const viewport = uiSmokeMode.enabled
    ? uiSmokeMode.scenario.viewport
    : { width: 1280, height: 840 }
  mainWindow = new BrowserWindow({
    title: APP_DISPLAY_NAME,
    width: viewport.width,
    height: viewport.height,
    useContentSize: uiSmokeMode.enabled,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  if (uiSmokeMode.enabled) {
    mainWindow.webContents.on('console-message', (details) => {
      console.info(`[ui-smoke:renderer:${details.level}] ${details.message}`)
    })
    mainWindow.webContents.once('did-finish-load', () => {
      console.info(
        'Agent Squad HQ UI smoke mode: real main services are disabled.'
      )
    })
  }

  // electron-vite dev injects ELECTRON_RENDERER_URL; prod loads the built index.html.
  const developmentRendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (developmentRendererUrl && !uiSmokeMode.enabled) {
    void mainWindow.loadURL(developmentRendererUrl)
  } else {
    void mainWindow.loadFile(
      join(__dirname, '../renderer/index.html'),
      uiSmokeMode.enabled
        ? { query: { scenario: uiSmokeMode.scenario.id } }
        : undefined
    )
  }
}

app.whenReady().then(async () => {
  if (!uiSmokeMode.enabled) {
    services = await import('./ipc')
    services.initServices(applicationData.path)
    services.registerIpc(ipcMain)
  }
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void services?.disposeServices()
})
