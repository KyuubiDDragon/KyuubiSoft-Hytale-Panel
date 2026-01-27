import api from './client'

// ============== WHITELIST ==============

export interface WhitelistData {
  enabled: boolean
  list: string[]
}

export const whitelistApi = {
  async get(): Promise<WhitelistData> {
    const response = await api.get<WhitelistData>('/management/whitelist')
    return response.data
  },

  async setEnabled(enabled: boolean): Promise<{ success: boolean; enabled: boolean }> {
    const response = await api.put<{ success: boolean; enabled: boolean }>('/management/whitelist/enabled', { enabled })
    return response.data
  },

  async addPlayer(player: string): Promise<{ success: boolean; list: string[] }> {
    const response = await api.post<{ success: boolean; list: string[] }>('/management/whitelist/add', { player })
    return response.data
  },

  async removePlayer(player: string): Promise<{ success: boolean; list: string[] }> {
    const response = await api.delete<{ success: boolean; list: string[] }>(`/management/whitelist/${encodeURIComponent(player)}`)
    return response.data
  },
}

// ============== BANS ==============

export interface BanEntry {
  player: string
  target?: string // UUID from Hytale
  reason?: string
  bannedAt: string
  bannedBy?: string
}

export const bansApi = {
  async get(): Promise<{ bans: BanEntry[] }> {
    const response = await api.get<{ bans: BanEntry[] }>('/management/bans')
    return response.data
  },

  async add(player: string, reason?: string): Promise<{ success: boolean; bans: BanEntry[] }> {
    const response = await api.post<{ success: boolean; bans: BanEntry[] }>('/management/bans/add', { player, reason })
    return response.data
  },

  async remove(player: string): Promise<{ success: boolean; bans: BanEntry[] }> {
    const response = await api.delete<{ success: boolean; bans: BanEntry[] }>(`/management/bans/${encodeURIComponent(player)}`)
    return response.data
  },
}

// ============== PERMISSIONS ==============

export interface PermissionGroup {
  name: string
  permissions: string[]
  inherits?: string[]
}

export interface PermissionUser {
  uuid: string
  name: string
  groups: string[]
}

export interface PermissionsData {
  users: PermissionUser[]
  groups: PermissionGroup[]
  availablePermissions?: { name: string; description?: string }[]
}

export const permissionsApi = {
  async get(): Promise<PermissionsData> {
    const response = await api.get<PermissionsData>('/management/permissions')
    return response.data
  },

  async addUser(name: string, groups: string[]): Promise<{ success: boolean; users: PermissionUser[] }> {
    const response = await api.post<{ success: boolean; users: PermissionUser[] }>('/management/permissions/users', { name, groups })
    return response.data
  },

  async removeUser(name: string): Promise<{ success: boolean; users: PermissionUser[] }> {
    const response = await api.delete<{ success: boolean; users: PermissionUser[] }>(`/management/permissions/users/${encodeURIComponent(name)}`)
    return response.data
  },

  async addGroup(name: string, permissions: string[], inherits?: string[]): Promise<{ success: boolean; groups: PermissionGroup[] }> {
    const response = await api.post<{ success: boolean; groups: PermissionGroup[] }>('/management/permissions/groups', { name, permissions, inherits })
    return response.data
  },

  async removeGroup(name: string): Promise<{ success: boolean; groups: PermissionGroup[] }> {
    const response = await api.delete<{ success: boolean; groups: PermissionGroup[] }>(`/management/permissions/groups/${encodeURIComponent(name)}`)
    return response.data
  },
}

// ============== WORLDS ==============

export interface WorldFileInfo {
  name: string
  path: string  // relative path within world (e.g., "config.json" or "resources/Time.json")
  size: number
  lastModified: string
}

export interface WorldInfo {
  name: string
  hasConfig: boolean
  files: WorldFileInfo[]  // All editable JSON files in this world
}

export interface WorldClientEffects {
  sunHeightPercent?: number
  sunAngleDegrees?: number
  bloomIntensity?: number
  bloomPower?: number
  sunIntensity?: number
  sunshaftIntensity?: number
  sunshaftScaleFactor?: number
}

export interface WorldConfig {
  name: string
  displayName?: string
  seed?: number
  isTicking: boolean
  isBlockTicking: boolean
  isPvpEnabled: boolean
  isFallDamageEnabled: boolean
  isGameTimePaused: boolean
  gameTime?: string
  isSpawningNPC: boolean
  isAllNPCFrozen: boolean
  isSpawnMarkersEnabled: boolean
  isObjectiveMarkersEnabled: boolean
  isSavingPlayers: boolean
  isSavingChunks: boolean
  saveNewChunks: boolean
  isUnloadingChunks: boolean
  isCompassUpdating: boolean
  gameplayConfig?: string
  deleteOnUniverseStart: boolean
  deleteOnRemove: boolean
  daytimeDurationSecondsOverride?: number | null
  nighttimeDurationSecondsOverride?: number | null
  clientEffects?: WorldClientEffects
  raw?: Record<string, unknown>
}

export interface WorldFileContent {
  worldName: string
  filePath: string
  fileName: string
  content: Record<string, unknown>
  raw: string
}

export const worldsApi = {
  async get(): Promise<{ worlds: WorldInfo[] }> {
    const response = await api.get<{ worlds: WorldInfo[] }>('/management/worlds')
    return response.data
  },

  async getConfig(worldName: string): Promise<WorldConfig> {
    const response = await api.get<WorldConfig>(`/management/worlds/${encodeURIComponent(worldName)}/config`)
    return response.data
  },

  async updateConfig(worldName: string, updates: Partial<WorldConfig>): Promise<{ success: boolean; message?: string }> {
    const response = await api.put<{ success: boolean; message?: string }>(`/management/worlds/${encodeURIComponent(worldName)}/config`, updates)
    return response.data
  },

  // Generic file read/write for any JSON file in a world
  async getFile(worldName: string, filePath: string): Promise<WorldFileContent> {
    const response = await api.get<WorldFileContent>(`/management/worlds/${encodeURIComponent(worldName)}/files/${filePath}`)
    return response.data
  },

  async updateFile(worldName: string, filePath: string, content: Record<string, unknown> | string): Promise<{ success: boolean; message?: string }> {
    const response = await api.put<{ success: boolean; message?: string }>(
      `/management/worlds/${encodeURIComponent(worldName)}/files/${filePath}`,
      { content }
    )
    return response.data
  },
}

// ============== MODS & PLUGINS ==============

export interface ModInfo {
  name: string
  filename: string
  size: number
  lastModified: string
  enabled: boolean
  // Update info (optional - only for mods in registry)
  storeId?: string
  installedVersion?: string
  latestVersion?: string
  hasUpdate?: boolean
}

export interface ConfigFile {
  name: string
  path: string
}

export const modsApi = {
  async get(): Promise<{ mods: ModInfo[]; path: string }> {
    const response = await api.get<{ mods: ModInfo[]; path: string }>('/management/mods')
    return response.data
  },

  async toggle(filename: string): Promise<{ success: boolean }> {
    const response = await api.put<{ success: boolean }>(`/management/mods/${encodeURIComponent(filename)}/toggle`)
    return response.data
  },

  async upload(file: File): Promise<{ success: boolean; filename: string; size: number }> {
    const formData = new FormData()
    formData.append('file', file)
    const response = await api.post<{ success: boolean; filename: string; size: number }>('/management/mods/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return response.data
  },

  async delete(filename: string): Promise<{ success: boolean }> {
    const response = await api.delete<{ success: boolean }>(`/management/mods/${encodeURIComponent(filename)}`)
    return response.data
  },

  async getConfigs(filename: string): Promise<{ configs: ConfigFile[] }> {
    const response = await api.get<{ configs: ConfigFile[] }>(`/management/mods/${encodeURIComponent(filename)}/configs`)
    return response.data
  },
}

export const pluginsApi = {
  async get(): Promise<{ plugins: ModInfo[]; path: string }> {
    const response = await api.get<{ plugins: ModInfo[]; path: string }>('/management/plugins')
    return response.data
  },

  async toggle(filename: string): Promise<{ success: boolean }> {
    const response = await api.put<{ success: boolean }>(`/management/plugins/${encodeURIComponent(filename)}/toggle`)
    return response.data
  },

  async upload(file: File): Promise<{ success: boolean; filename: string; size: number }> {
    const formData = new FormData()
    formData.append('file', file)
    const response = await api.post<{ success: boolean; filename: string; size: number }>('/management/plugins/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return response.data
  },

  async delete(filename: string): Promise<{ success: boolean }> {
    const response = await api.delete<{ success: boolean }>(`/management/plugins/${encodeURIComponent(filename)}`)
    return response.data
  },

  async getConfigs(filename: string): Promise<{ configs: ConfigFile[] }> {
    const response = await api.get<{ configs: ConfigFile[] }>(`/management/plugins/${encodeURIComponent(filename)}/configs`)
    return response.data
  },
}

export const configApi = {
  async read(path: string): Promise<{ content: string; path: string }> {
    const response = await api.get<{ content: string; path: string }>('/management/config/read', { params: { path } })
    return response.data
  },

  async write(path: string, content: string): Promise<{ success: boolean }> {
    const response = await api.put<{ success: boolean }>('/management/config/write', { path, content })
    return response.data
  },
}

// ============== STATS HISTORY ==============

export interface StatsEntry {
  timestamp: string
  cpu: number
  memory: number
  players: number
}

export const statsApi = {
  async getHistory(): Promise<{ history: StatsEntry[] }> {
    const response = await api.get<{ history: StatsEntry[] }>('/management/stats/history')
    return response.data
  },
}

// ============== ACTIVITY LOG ==============

export interface ActivityLogEntry {
  id: string
  timestamp: string
  user: string
  action: string
  target?: string
  details?: string
  category: 'player' | 'server' | 'backup' | 'config' | 'mod' | 'user' | 'system'
  success: boolean
}

export const activityApi = {
  async get(options?: { limit?: number; offset?: number; category?: string; user?: string }): Promise<{ entries: ActivityLogEntry[]; total: number }> {
    const response = await api.get<{ entries: ActivityLogEntry[]; total: number }>('/management/activity', { params: options })
    return response.data
  },

  async clear(): Promise<{ success: boolean }> {
    const response = await api.delete<{ success: boolean }>('/management/activity')
    return response.data
  },
}

// ============== MOD STORE ==============

// Localized string type for multi-language support
export interface LocalizedString {
  de?: string
  en?: string
  pt_br?: string
}

export interface ModStoreEntry {
  id: string
  name: string
  description: string | LocalizedString // Can be string (legacy) or localized
  author: string
  github: string
  category: 'map' | 'utility' | 'gameplay' | 'admin' | 'other'
  installed: boolean
  installedFilename?: string
  installedVersion?: string
  latestVersion?: string
  hasUpdate?: boolean
  configPath?: string
  ports?: { name: string; default: number; env: string }[]
  hints?: LocalizedString
}

export interface ModReleaseInfo {
  version: string
  name: string
  publishedAt: string
  assets: { name: string; size: number }[]
}

export interface InstallResult {
  success: boolean
  error?: string
  filename?: string
  version?: string
  configCreated?: boolean
}

export const modStoreApi = {
  async getAvailable(): Promise<{ mods: ModStoreEntry[] }> {
    const response = await api.get<{ mods: ModStoreEntry[] }>('/management/modstore')
    return response.data
  },

  async getRelease(modId: string): Promise<ModReleaseInfo> {
    const response = await api.get<ModReleaseInfo>(`/management/modstore/${modId}/release`)
    return response.data
  },

  async install(modId: string): Promise<InstallResult> {
    const response = await api.post<InstallResult>(`/management/modstore/${modId}/install`)
    return response.data
  },

  async uninstall(modId: string): Promise<{ success: boolean; error?: string }> {
    const response = await api.delete<{ success: boolean; error?: string }>(`/management/modstore/${modId}/uninstall`)
    return response.data
  },

  async update(modId: string): Promise<InstallResult> {
    const response = await api.post<InstallResult>(`/management/modstore/${modId}/update`)
    return response.data
  },
}

// ============== MODTALE API ==============

export interface ModtaleProject {
  id: string
  title: string
  author: string
  classification: 'PLUGIN' | 'DATA' | 'ART' | 'SAVE' | 'MODPACK'
  description: string
  imageUrl?: string
  downloads: number
  rating: number
  updatedAt: string
  tags: string[]
}

export interface ModtaleVersion {
  id: string
  versionNumber: string
  fileUrl: string
  downloadCount: number
  gameVersions?: string[]
  changelog?: string
  channel?: 'RELEASE' | 'BETA' | 'ALPHA'
}

export interface ModtaleProjectDetails extends ModtaleProject {
  about?: string
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'UNLISTED'
  versions: ModtaleVersion[]
  galleryImages: string[]
  license?: string
  repositoryUrl?: string
}

export interface ModtaleSearchResult {
  content: ModtaleProject[]
  totalPages: number
  totalElements: number
}

export interface ModtaleStatus {
  configured: boolean
  hasApiKey: boolean
  apiAvailable: boolean
  rateLimit?: {
    tier: string
    limit: number
  }
}

export interface ModtaleInstallResult {
  success: boolean
  error?: string
  filename?: string
  version?: string
  projectId?: string
  projectTitle?: string
}

export interface ModtaleInstalledInfo {
  projectId: string
  projectTitle: string
  version: string
  filename: string
  classification: ModtaleClassification
  installedAt: string
}

export type ModtaleSortOption = 'relevance' | 'downloads' | 'updated' | 'newest' | 'rating' | 'favorites'
export type ModtaleClassification = 'PLUGIN' | 'DATA' | 'ART' | 'SAVE' | 'MODPACK'

export const modtaleApi = {
  async getStatus(): Promise<ModtaleStatus> {
    const response = await api.get<ModtaleStatus>('/management/modtale/status')
    return response.data
  },

  async search(options?: {
    search?: string
    page?: number
    size?: number
    sort?: ModtaleSortOption
    classification?: ModtaleClassification
    tags?: string[]
    gameVersion?: string
    author?: string
  }): Promise<ModtaleSearchResult> {
    const params = new URLSearchParams()
    if (options?.search) params.append('search', options.search)
    if (options?.page !== undefined) params.append('page', options.page.toString())
    if (options?.size) params.append('size', options.size.toString())
    if (options?.sort) params.append('sort', options.sort)
    if (options?.classification) params.append('classification', options.classification)
    if (options?.tags?.length) params.append('tags', options.tags.join(','))
    if (options?.gameVersion) params.append('gameVersion', options.gameVersion)
    if (options?.author) params.append('author', options.author)

    const response = await api.get<ModtaleSearchResult>(`/management/modtale/search?${params.toString()}`)
    return response.data
  },

  async getProject(projectId: string): Promise<ModtaleProjectDetails> {
    const response = await api.get<ModtaleProjectDetails>(`/management/modtale/projects/${projectId}`)
    return response.data
  },

  async install(projectId: string, versionId?: string): Promise<ModtaleInstallResult> {
    const response = await api.post<ModtaleInstallResult>('/management/modtale/install', { projectId, versionId })
    return response.data
  },

  async getFeatured(limit?: number): Promise<{ mods: ModtaleProject[] }> {
    const params = limit ? `?limit=${limit}` : ''
    const response = await api.get<{ mods: ModtaleProject[] }>(`/management/modtale/featured${params}`)
    return response.data
  },

  async getRecent(limit?: number): Promise<{ mods: ModtaleProject[] }> {
    const params = limit ? `?limit=${limit}` : ''
    const response = await api.get<{ mods: ModtaleProject[] }>(`/management/modtale/recent${params}`)
    return response.data
  },

  async getTags(): Promise<{ tags: string[] }> {
    const response = await api.get<{ tags: string[] }>('/management/modtale/tags')
    return response.data
  },

  async getClassifications(): Promise<{ classifications: string[] }> {
    const response = await api.get<{ classifications: string[] }>('/management/modtale/classifications')
    return response.data
  },

  async refresh(): Promise<{ success: boolean; message: string }> {
    const response = await api.post<{ success: boolean; message: string }>('/management/modtale/refresh')
    return response.data
  },

  async getInstalled(): Promise<{ installed: Record<string, ModtaleInstalledInfo> }> {
    const response = await api.get<{ installed: Record<string, ModtaleInstalledInfo> }>('/management/modtale/installed')
    return response.data
  },

  async uninstall(projectId: string): Promise<{ success: boolean; error?: string }> {
    const response = await api.delete<{ success: boolean; error?: string }>(`/management/modtale/uninstall/${projectId}`)
    return response.data
  },
}

// ============== STACKMART API ==============

export interface StackMartResource {
  id: string
  name: string
  slug: string
  tagline: string
  category: string
  subcategory?: string
  version: string
  downloads: number
  rating: number
  author: string
  source: string
  sourceUrl: string
  downloadUrl: string
  iconUrl?: string
  bannerUrl?: string
}

export interface StackMartResourceDetails extends StackMartResource {
  description: string
  features: string[]
  screenshots: string[]
  tags?: string[]
  requirements?: string
  changelog?: string
  supportUrl?: string
  documentationUrl?: string
  fileUrl?: string
  fileName?: string
  fileSize?: number
  views?: number
  reviewsCount?: number
  createdAt?: string
  updatedAt?: string
}

export interface StackMartSearchResult {
  resources: StackMartResource[]
  total: number
  page: number
  totalPages: number
  source: string
  apiVersion: string
}

export interface StackMartStatus {
  configured: boolean
  hasApiKey: boolean
  apiAvailable: boolean
  rateLimit: {
    limit: number
  }
}

export interface StackMartInstallResult {
  success: boolean
  error?: string
  filename?: string
  version?: string
  resourceId?: string
  resourceName?: string
}

export interface StackMartInstalledInfo {
  resourceId: string
  resourceName: string
  version: string
  filename: string
  category: string
  installedAt: string
}

export type StackMartSortOption = 'popular' | 'recent' | 'rated'
export type StackMartCategory = 'plugins' | 'mods' | 'scripts' | 'tools'

export const stackmartApi = {
  async getStatus(): Promise<StackMartStatus> {
    const response = await api.get<StackMartStatus>('/management/stackmart/status')
    return response.data
  },

  async search(options?: {
    search?: string
    page?: number
    limit?: number
    sort?: StackMartSortOption
    category?: StackMartCategory
    subcategory?: string
  }): Promise<StackMartSearchResult> {
    const params = new URLSearchParams()
    if (options?.search) params.append('search', options.search)
    if (options?.page !== undefined) params.append('page', options.page.toString())
    if (options?.limit) params.append('limit', options.limit.toString())
    if (options?.sort) params.append('sort', options.sort)
    if (options?.category) params.append('category', options.category)
    if (options?.subcategory) params.append('subcategory', options.subcategory)

    const response = await api.get<StackMartSearchResult>(`/management/stackmart/search?${params.toString()}`)
    return response.data
  },

  async getResource(resourceId: string): Promise<{ resource: StackMartResourceDetails }> {
    const response = await api.get<{ resource: StackMartResourceDetails }>(`/management/stackmart/resources/${resourceId}`)
    return response.data
  },

  async install(resourceId: string): Promise<StackMartInstallResult> {
    const response = await api.post<StackMartInstallResult>('/management/stackmart/install', { resourceId })
    return response.data
  },

  async getPopular(limit?: number): Promise<{ resources: StackMartResource[] }> {
    const params = limit ? `?limit=${limit}` : ''
    const response = await api.get<{ resources: StackMartResource[] }>(`/management/stackmart/popular${params}`)
    return response.data
  },

  async getRecent(limit?: number): Promise<{ resources: StackMartResource[] }> {
    const params = limit ? `?limit=${limit}` : ''
    const response = await api.get<{ resources: StackMartResource[] }>(`/management/stackmart/recent${params}`)
    return response.data
  },

  async getCategories(): Promise<{ categories: string[] }> {
    const response = await api.get<{ categories: string[] }>('/management/stackmart/categories')
    return response.data
  },

  async refresh(): Promise<{ success: boolean; message: string }> {
    const response = await api.post<{ success: boolean; message: string }>('/management/stackmart/refresh')
    return response.data
  },

  async getInstalled(): Promise<{ installed: Record<string, StackMartInstalledInfo> }> {
    const response = await api.get<{ installed: Record<string, StackMartInstalledInfo> }>('/management/stackmart/installed')
    return response.data
  },

  async uninstall(resourceId: string): Promise<{ success: boolean; error?: string }> {
    const response = await api.delete<{ success: boolean; error?: string }>(`/management/stackmart/uninstall/${resourceId}`)
    return response.data
  },
}

// ============== CURSEFORGE API ==============

export interface CurseForgeCategory {
  id: number
  gameId: number
  name: string
  slug: string
  url: string
  iconUrl: string
  parentCategoryId?: number
  isClass?: boolean
}

export interface CurseForgeMod {
  id: number
  gameId: number
  name: string
  slug: string
  links: {
    websiteUrl: string
    wikiUrl?: string
    issuesUrl?: string
    sourceUrl?: string
  }
  summary: string
  status: number
  downloadCount: number
  isFeatured: boolean
  primaryCategoryId: number
  categories: CurseForgeCategory[]
  classId?: number
  authors: Array<{
    id: number
    name: string
    url: string
  }>
  logo?: {
    id: number
    modId: number
    title: string
    thumbnailUrl: string
    url: string
  }
  screenshots?: Array<{
    id: number
    modId: number
    title: string
    thumbnailUrl: string
    url: string
  }>
  mainFileId: number
  latestFiles: CurseForgeFile[]
  latestFilesIndexes: Array<{
    gameVersion: string
    fileId: number
    filename: string
    releaseType: number
    gameVersionTypeId?: number
    modLoader?: number
  }>
  dateCreated: string
  dateModified: string
  dateReleased: string
  allowModDistribution?: boolean
  gamePopularityRank: number
  thumbsUpCount?: number
}

export interface CurseForgeFile {
  id: number
  gameId: number
  modId: number
  isAvailable: boolean
  displayName: string
  fileName: string
  releaseType: 1 | 2 | 3 // 1=Release, 2=Beta, 3=Alpha
  fileStatus: number
  hashes: Array<{
    value: string
    algo: number
  }>
  fileDate: string
  fileLength: number
  downloadCount: number
  downloadUrl: string | null
  gameVersions: string[]
  sortableGameVersions?: Array<{
    gameVersionName: string
    gameVersionPadded: string
    gameVersion: string
    gameVersionReleaseDate: string
    gameVersionTypeId?: number
  }>
  dependencies?: Array<{
    modId: number
    relationType: number
  }>
  modules?: Array<{
    name: string
    fingerprint: number
  }>
  fileFingerprint: number
}

export interface CurseForgeSearchResult {
  data: CurseForgeMod[]
  pagination: {
    index: number
    pageSize: number
    resultCount: number
    totalCount: number
  }
}

export interface CurseForgeStatus {
  configured: boolean
  hasApiKey: boolean
  apiAvailable: boolean
  gameId: number
}

export interface CurseForgeInstallResult {
  success: boolean
  error?: string
  filename?: string
  version?: string
  modId?: number
  modName?: string
}

export interface CurseForgeInstalledInfo {
  modId: number
  modName: string
  fileId: number
  version: string
  filename: string
  installedAt: string
  releaseType: number
  gameVersions: string[]
}

export interface CurseForgeUpdateInfo {
  modId: number
  modName: string
  currentFileId: number
  currentVersion: string
  latestFileId: number
  latestVersion: string
  releaseType: number
  hasUpdate: boolean
}

export type CurseForgeSortField =
  | 'Featured'
  | 'Popularity'
  | 'LastUpdated'
  | 'Name'
  | 'Author'
  | 'TotalDownloads'
  | 'Category'
  | 'GameVersion'

export type CurseForgeSortOrder = 'asc' | 'desc'

export const curseforgeApi = {
  async getStatus(): Promise<CurseForgeStatus> {
    const response = await api.get<CurseForgeStatus>('/management/curseforge/status')
    return response.data
  },

  async search(options?: {
    search?: string
    gameId?: number
    classId?: number
    categoryId?: number
    gameVersion?: string
    sortField?: CurseForgeSortField
    sortOrder?: CurseForgeSortOrder
    pageSize?: number
    index?: number
  }): Promise<CurseForgeSearchResult> {
    const params = new URLSearchParams()
    if (options?.search) params.append('search', options.search)
    if (options?.gameId !== undefined) params.append('gameId', options.gameId.toString())
    if (options?.classId !== undefined) params.append('classId', options.classId.toString())
    if (options?.categoryId !== undefined) params.append('categoryId', options.categoryId.toString())
    if (options?.gameVersion) params.append('gameVersion', options.gameVersion)
    if (options?.sortField) params.append('sortField', options.sortField)
    if (options?.sortOrder) params.append('sortOrder', options.sortOrder)
    if (options?.pageSize !== undefined) params.append('pageSize', options.pageSize.toString())
    if (options?.index !== undefined) params.append('index', options.index.toString())

    const response = await api.get<CurseForgeSearchResult>(`/management/curseforge/search?${params.toString()}`)
    return response.data
  },

  async getMod(modId: number): Promise<CurseForgeMod> {
    const response = await api.get<CurseForgeMod>(`/management/curseforge/mods/${modId}`)
    return response.data
  },

  async getFiles(modId: number, options?: {
    gameVersion?: string
    pageSize?: number
    index?: number
  }): Promise<{ data: CurseForgeFile[] }> {
    const params = new URLSearchParams()
    if (options?.gameVersion) params.append('gameVersion', options.gameVersion)
    if (options?.pageSize !== undefined) params.append('pageSize', options.pageSize.toString())
    if (options?.index !== undefined) params.append('index', options.index.toString())

    const response = await api.get<{ data: CurseForgeFile[] }>(`/management/curseforge/mods/${modId}/files?${params.toString()}`)
    return response.data
  },

  async install(modId: number, fileId?: number): Promise<CurseForgeInstallResult> {
    const response = await api.post<CurseForgeInstallResult>('/management/curseforge/install', { modId, fileId })
    return response.data
  },

  async update(modId: number, fileId?: number): Promise<CurseForgeInstallResult> {
    const response = await api.post<CurseForgeInstallResult>('/management/curseforge/update', { modId, fileId })
    return response.data
  },

  async checkUpdates(): Promise<{ updates: CurseForgeUpdateInfo[] }> {
    const response = await api.get<{ updates: CurseForgeUpdateInfo[] }>('/management/curseforge/updates')
    return response.data
  },

  async getFeatured(limit?: number): Promise<{ data: CurseForgeMod[] }> {
    const params = limit ? `?limit=${limit}` : ''
    const response = await api.get<{ data: CurseForgeMod[] }>(`/management/curseforge/featured${params}`)
    return response.data
  },

  async getRecent(limit?: number): Promise<{ data: CurseForgeMod[] }> {
    const params = limit ? `?limit=${limit}` : ''
    const response = await api.get<{ data: CurseForgeMod[] }>(`/management/curseforge/recent${params}`)
    return response.data
  },

  async getPopular(limit?: number): Promise<{ data: CurseForgeMod[] }> {
    const params = limit ? `?limit=${limit}` : ''
    const response = await api.get<{ data: CurseForgeMod[] }>(`/management/curseforge/popular${params}`)
    return response.data
  },

  async getCategories(gameId?: number): Promise<{ data: CurseForgeCategory[] }> {
    const params = gameId ? `?gameId=${gameId}` : ''
    const response = await api.get<{ data: CurseForgeCategory[] }>(`/management/curseforge/categories${params}`)
    return response.data
  },

  async refresh(): Promise<{ success: boolean; message: string }> {
    const response = await api.post<{ success: boolean; message: string }>('/management/curseforge/refresh')
    return response.data
  },

  async getInstalled(): Promise<{ mods: Record<string, CurseForgeInstalledInfo> }> {
    const response = await api.get<{ mods: Record<string, CurseForgeInstalledInfo> }>('/management/curseforge/installed')
    return response.data
  },

  async uninstall(modId: number): Promise<{ success: boolean; error?: string }> {
    const response = await api.delete<{ success: boolean; error?: string }>(`/management/curseforge/uninstall/${modId}`)
    return response.data
  },
}

// ============== MOD UPDATES (CFWidget) ==============

export interface TrackedMod {
  filename: string
  curseforgeSlug?: string
  installedFileId?: number
  installedVersion?: string
  latestFileId?: number
  latestVersion?: string
  latestFileName?: string
  hasUpdate: boolean
  lastChecked?: string
  projectId?: number
  projectTitle?: string
  projectUrl?: string
  thumbnail?: string
  installed?: boolean // false = wishlist item, not yet installed
  // Unified updates fields
  name?: string
  source?: 'cfwidget' | 'curseforge' | 'modtale' | 'stackmart' | 'modstore'
  sourceId?: string
  modId?: number
}

export interface ModUpdateStatus {
  totalTracked: number
  updatesAvailable: number
  lastChecked: string | null
  mods: TrackedMod[]
}

export interface CFWidgetProject {
  id: number
  title: string
  summary: string
  thumbnail: string
  game: string
  type: string
  urls: {
    curseforge: string
    project: string
  }
  downloads: {
    monthly: number
    total: number
  }
  categories: string[]
  files: Array<{
    id: number
    url: string
    display: string
    name: string
    type: 'release' | 'beta' | 'alpha'
    version: string
    filesize: number
    versions: string[]
    downloads: number
    uploaded_at: string
  }>
}

export const modupdatesApi = {
  /** Get cached update status (fast, no API calls) */
  async getStatus(): Promise<ModUpdateStatus> {
    const response = await api.get<ModUpdateStatus>('/management/modupdates/status')
    return response.data
  },

  /** Check all tracked mods for updates (slower, makes API calls) */
  async checkAll(): Promise<ModUpdateStatus> {
    const response = await api.post<ModUpdateStatus>('/management/modupdates/check')
    return response.data
  },

  /** Check a single mod for updates */
  async checkMod(filename: string): Promise<{ success: boolean; mod?: TrackedMod }> {
    const response = await api.post<{ success: boolean; mod?: TrackedMod }>(`/management/modupdates/check/${encodeURIComponent(filename)}`)
    return response.data
  },

  /** Track a mod by CurseForge URL or slug */
  async track(filename: string, curseforgeInput: string, currentVersion?: string): Promise<{ success: boolean; error?: string; mod?: TrackedMod }> {
    const response = await api.post<{ success: boolean; error?: string; mod?: TrackedMod }>('/management/modupdates/track', {
      filename,
      curseforgeInput,
      currentVersion,
    })
    return response.data
  },

  /** Untrack a mod */
  async untrack(filename: string): Promise<{ success: boolean }> {
    const response = await api.delete<{ success: boolean }>(`/management/modupdates/track/${encodeURIComponent(filename)}`)
    return response.data
  },

  /** Lookup mod info by CurseForge URL or slug */
  async lookup(input: string): Promise<{ success: boolean; project?: CFWidgetProject; error?: string }> {
    const response = await api.get<{ success: boolean; project?: CFWidgetProject; error?: string }>('/management/modupdates/lookup', {
      params: { input },
    })
    return response.data
  },

  /** Update the installed version of a tracked mod */
  async updateInstalledVersion(filename: string, version: string, fileId?: number): Promise<{ success: boolean }> {
    const response = await api.put<{ success: boolean }>(`/management/modupdates/version/${encodeURIComponent(filename)}`, {
      version,
      fileId,
    })
    return response.data
  },

  /** Clear the CFWidget cache */
  async clearCache(): Promise<{ success: boolean }> {
    const response = await api.post<{ success: boolean }>('/management/modupdates/cache/clear')
    return response.data
  },

  /** Install or update a tracked mod */
  async install(filename: string): Promise<{ success: boolean; error?: string; filename?: string; modName?: string; version?: string }> {
    const response = await api.post<{ success: boolean; error?: string; filename?: string; modName?: string; version?: string }>(`/management/modupdates/install/${encodeURIComponent(filename)}`)
    return response.data
  },

  /** Uninstall a tracked mod (delete file and untrack) */
  async uninstall(filename: string): Promise<{ success: boolean; error?: string }> {
    const response = await api.delete<{ success: boolean; error?: string }>(`/management/modupdates/uninstall/${encodeURIComponent(filename)}`)
    return response.data
  },
}
