import api from './client'

export interface ExtractionProgress {
  started: string
  filesExtracted: number
  currentFile: string
  status: 'running' | 'completed' | 'failed'
  error?: string
}

export interface AssetStatus {
  extracted: boolean
  sourceExists: boolean
  sourceFile: string | null
  sourceSize: number
  extractedAt: string | null
  fileCount: number
  needsUpdate: boolean
  totalSize: number
  extracting: boolean
  extractProgress: ExtractionProgress | null
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

  async extract(): Promise<{ success: boolean; message?: string; error?: string }> {
    const response = await api.post('/assets/extract', {})
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
      useRegex?: boolean
      useGlob?: boolean
    }
  ): Promise<{ query: string; count: number; results: SearchResult[]; mode: string }> {
    const params: Record<string, string> = { q: query }
    if (options?.searchContent) params.content = 'true'
    if (options?.extensions) params.ext = options.extensions.join(',')
    if (options?.limit) params.limit = String(options.limit)
    if (options?.useRegex) params.regex = 'true'
    if (options?.useGlob) params.glob = 'true'

    const response = await api.get('/assets/search', { params })
    return response.data
  },

  getDownloadUrl(path: string): string {
    return `/api/assets/download/${path}`
  },
}
