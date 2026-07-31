import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

interface SettingsData {
  baseRepo?: string
}

/** Persisted app settings (currently: the chosen base repo for worktrees). */
export class SettingsStore {
  private data: SettingsData = {}

  constructor(private readonly file: string) {
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8')) as SettingsData
    } catch {
      // missing or corrupt -> start empty
    }
  }

  get baseRepo(): string | undefined {
    return this.data.baseRepo
  }

  setBaseRepo(path: string | undefined): void {
    this.data.baseRepo = path
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    } catch {
      // best-effort persistence
    }
  }
}
