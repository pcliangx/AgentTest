import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  APP_DISPLAY_NAME,
  APP_ID,
  prepareApplicationDataDirectory
} from './app-identity'
import { disposeServices, initServices, registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null

app.setName(APP_DISPLAY_NAME)
app.setAppUserModelId(APP_ID)

const applicationData = prepareApplicationDataDirectory(app.getPath('appData'))
app.setPath('userData', applicationData.path)
app.setPath('sessionData', applicationData.path)

if (applicationData.status === 'migrated') {
  console.info('Agent Squad HQ copied legacy application data into the stable data directory.')
} else if (applicationData.status === 'legacy-fallback') {
  console.warn('Agent Squad HQ could not migrate legacy application data and will use it in place.')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: APP_DISPLAY_NAME,
    width: 1280,
    height: 840,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // electron-vite dev injects ELECTRON_RENDERER_URL; prod loads the built index.html.
  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  initServices(applicationData.path)
  registerIpc(ipcMain)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void disposeServices()
})
