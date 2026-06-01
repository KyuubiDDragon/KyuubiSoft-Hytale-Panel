import api from './client'

// ============================================================
// Types
// ============================================================

export interface FileRoot {
  id: string
  path: string
  rw: boolean
  label: string
  permission: 'files.read' | 'files.write'
}

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  mtime: string
  mtimeMs: number
  isReadOnly: boolean
}

export interface ListResponse {
  root: { id: string; path: string; rw: boolean }
  path: string
  entries: FileEntry[]
}

export interface ReadResponse {
  rootId: string
  path: string
  content: string
  encoding: 'utf-8' | 'base64'
  size: number
  mtime: string
  mtimeMs: number
  truncated: boolean
  isBinary: boolean
}

export interface WriteResponse {
  ok: boolean
  size: number
  mtime: string
  mtimeMs: number
}

export interface ApiError {
  error: string
  code?: string
  detail?: string
}

// ============================================================
// API client
// ============================================================

export const filesApi = {
  async listRoots(): Promise<FileRoot[]> {
    const res = await api.get<{ roots: FileRoot[] }>('/files/roots')
    return res.data.roots
  },

  async list(rootId: string, path = ''): Promise<ListResponse> {
    const res = await api.get<ListResponse>('/files/list', {
      params: { rootId, path },
    })
    return res.data
  },

  async read(rootId: string, path: string): Promise<ReadResponse> {
    const res = await api.get<ReadResponse>('/files/read', {
      params: { rootId, path },
    })
    return res.data
  },

  async write(params: {
    rootId: string
    path: string
    content: string
    encoding?: 'utf-8' | 'base64'
    ifMatchMtime?: number
  }): Promise<WriteResponse> {
    const res = await api.put<WriteResponse>('/files/write', params)
    return res.data
  },

  async upload(rootId: string, path: string, file: File): Promise<WriteResponse & { name: string }> {
    const form = new FormData()
    form.append('rootId', rootId)
    form.append('path', path)
    form.append('file', file)
    const res = await api.post<WriteResponse & { name: string }>('/files/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return res.data
  },

  async remove(rootId: string, path: string, confirmToken: string): Promise<void> {
    await api.delete('/files', { data: { rootId, path, confirmToken } })
  },

  async move(rootId: string, from: string, to: string): Promise<void> {
    await api.post('/files/move', { rootId, from, to })
  },

  getDownloadUrl(rootId: string, path: string): string {
    const params = new URLSearchParams({ rootId, path })
    return `/api/files/download?${params.toString()}`
  },
}

// ============================================================
// Helpers
// ============================================================

export function detectLanguage(filename: string): string {
  const lower = filename.toLowerCase()
  const ext = lower.includes('.') ? lower.substring(lower.lastIndexOf('.')) : ''
  switch (ext) {
    case '.json':
      return 'json'
    case '.yml':
    case '.yaml':
      return 'yaml'
    case '.properties':
    case '.ini':
    case '.cfg':
    case '.conf':
      return 'ini'
    case '.lua':
      return 'lua'
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript'
    case '.ts':
      return 'typescript'
    case '.md':
    case '.markdown':
      return 'markdown'
    case '.xml':
      return 'xml'
    case '.html':
    case '.htm':
      return 'html'
    case '.css':
      return 'css'
    case '.sh':
    case '.bash':
      return 'shell'
    case '.py':
      return 'python'
    case '.toml':
      return 'ini'
    default:
      return 'plaintext'
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
