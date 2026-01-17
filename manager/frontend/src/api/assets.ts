import api from './client'

// Extended timeout for extraction (10 minutes)
const EXTRACT_TIMEOUT = 10 * 60 * 1000

export interface AssetStatus {
  extracted: boolean
  sourceExists: boolean
  sourceFile: string | null
  extractedAt: string | null
  fileCount: number
  needsUpdate: boolean
  totalSize: number
}

export interface AssetFileInfo {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  lastModified: string
  extension?: string
}

export interface AssetTreeNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size: number
  extension?: string
  children?: AssetTreeNode[]
}

export interface SearchResult {
  path: string
  name: string
  type: 'file' | 'directory'
  size: number
  extension?: string
  matchType: 'filename' | 'content'
  contentPreview?: string
}

export interface FileContent {
  path: string
  content: string
  mimeType: string
  size: number
  isBinary: boolean
}

export const assetsApi = {
  async getStatus(): Promise<AssetStatus> {
    const response = await api.get<AssetStatus>('/assets/status')
    return response.data
  },

  async extract(): Promise<{ success: boolean; message: string; fileCount?: number }> {
    const response = await api.post('/assets/extract', {}, {
      timeout: EXTRACT_TIMEOUT,
    })
    return response.data
  },

  async clearCache(): Promise<{ success: boolean; message: string }> {
    const response = await api.delete('/assets/cache')
    return response.data
  },

  async browse(path: string = ''): Promise<{ path: string; items: AssetFileInfo[] }> {
    const response = await api.get('/assets/browse', {
      params: { path },
    })
    return response.data
  },

  async getTree(path: string = '', depth: number = 3): Promise<AssetTreeNode> {
    const response = await api.get<AssetTreeNode>('/assets/tree', {
      params: { path, depth },
    })
    return response.data
  },

  async readFile(path: string): Promise<FileContent> {
    const response = await api.get<FileContent>('/assets/file', {
      params: { path },
    })
    return response.data
  },

  async search(
    query: string,
    options?: {
      searchContent?: boolean
      extensions?: string[]
      limit?: number
    }
  ): Promise<{ query: string; count: number; results: SearchResult[] }> {
    const params: Record<string, string> = { q: query }
    if (options?.searchContent) params.content = 'true'
    if (options?.extensions) params.ext = options.extensions.join(',')
    if (options?.limit) params.limit = String(options.limit)

    const response = await api.get('/assets/search', { params })
    return response.data
  },

  getDownloadUrl(path: string): string {
    return `/api/assets/download/${path}`
  },
}
