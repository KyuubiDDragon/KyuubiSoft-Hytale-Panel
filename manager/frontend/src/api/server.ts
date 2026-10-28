import api from './client'
import type { PendingLogin } from '@/utils/deviceLogin'

/** Stop/restart wait for a clean shutdown: up to 120 s, then 30 s forced, then the start. */
export const LIFECYCLE_TIMEOUT_MS = 200_000

/** A rollback stops the server, copies up to ~4 GB (Assets.zip) and starts it again. */
export const ROLLBACK_TIMEOUT_MS = 600_000

/** Downloader calls in the game container: version probe (~35 s), self-update (~160 s). */
const DOWNLOADER_PROBE_TIMEOUT_MS = 90_000
const DOWNLOADER_UPDATE_TIMEOUT_MS = 180_000

export interface ServerStatus {
  status: string
  running: boolean
  id?: string
  name?: string
  created?: string
  started_at?: string
  error?: string
}

export interface ServerStats {
  cpu_percent?: number
  memory_bytes?: number
  memory_limit_bytes?: number
  memory_percent?: number
  memory_mb?: number
  memory_limit_mb?: number
  error?: string
}

export interface ActionResponse {
  success: boolean
  message?: string
  error?: string
}

export interface ServerMemoryStats {
  available: boolean
  physical?: {
    total: number | null
    free: number | null
  }
  swap?: {
    total: number | null
    free: number | null
  }
  heap?: {
    init: number | null
    used: number | null
    committed: number | null
    max: number | null
  }
  raw?: string
  error?: string
}

export interface ConfigFile {
  name: string
  size: number
  modified: string | null
}

export interface ConfigFilesResponse {
  files: ConfigFile[]
}

export interface ConfigContentResponse {
  filename: string
  content: string
}

export interface QuickSettings {
  serverName: string
  motd: string
  password: string
  maxPlayers: number
  maxViewRadius: number
  defaultGameMode: string
}

/** live: the running server takes it at once (by command); restart: read at start. */
export type SettingApply = 'live' | 'restart'

/** A setting an older panel stored under a name Hytale never read, and what was done with it. */
export interface ConfigMigrationNote {
  file: string
  key: string
  action: 'removed' | 'renamed' | 'repaired'
  /** The value found */
  value?: unknown
  to?: string
  /** Explanation in English, for the log */
  note: string
  at: string
}

export interface QuickSettingsResponse extends QuickSettings {
  fields: Record<keyof QuickSettings, SettingApply>
  limits: {
    serverName: number
    motd: number
    password: number
    maxPlayers: number
    minViewRadius: number
    maxViewRadius: number
    gameModes: string[]
  }
  serverRunning: boolean
  /** The plugin can apply live settings on the running server. */
  liveAvailable: boolean
  /** What the running server uses right now (it saves a live change about a minute later). */
  liveValues: Partial<Pick<QuickSettings, 'maxPlayers' | 'maxViewRadius'>> | null
  legacyKeys: string[]
  notes: ConfigMigrationNote[]
}

export interface ServerFileSaveResponse {
  success: boolean
  changed?: boolean
  applied?: 'live' | 'file' | 'restart'
  restarted?: boolean
  warnings?: string[]
  message?: string
}

export interface UpdateCheckResponse {
  installedVersion: string
  latestVersion: string
  updateAvailable: boolean
  patchline?: string
  authRequired?: boolean // NEW: indicates if downloader needs re-authentication
  versions?: {
    release: string
    preRelease: string
  }
  message: string
}

export interface DownloaderAuthStatus {
  authenticated: boolean
  credentialsExist: boolean
  authRequired: boolean
  error?: string
  /** A login the server's container waits for (a new server without game files). */
  pendingLogin?: PendingLogin | null
}

export interface DownloaderAuthInitResponse {
  success: boolean
  alreadyAuthenticated?: boolean
  /** 'container': the login the container already waits for was handed on. */
  source?: 'container'
  verificationUrl?: string
  userCode?: string
  expiresIn?: number
  error?: string
  message?: string
}

export interface DownloaderAuthPollResponse {
  completed: boolean
  /** The login worked and the container is downloading the game files. */
  downloading?: boolean
  expired?: boolean
  version?: string
  verificationUrl?: string
  userCode?: string
  error?: string
}

// Native Update System Types (Hytale 24.01.2026+)
export interface UpdateConfig {
  enabled: boolean
  checkIntervalSeconds: number
  notifyPlayersOnAvailable: boolean
  patchline: 'release' | 'pre-release'
  runBackupBeforeUpdate: boolean
  backupConfigBeforeUpdate: boolean
  autoApplyMode: 'DISABLED' | 'WHEN_EMPTY' | 'SCHEDULED'
  autoApplyDelayMinutes: number
}

export type UpdateActionBlock =
  | 'server_stopped'
  | 'server_running'
  | 'no_updater'
  | 'invalid_layout'
  | 'already_staged'
  | 'nothing_staged'
  | 'disk_space'
  | 'no_backup'
  | 'staged_invalid'
  | 'patchline_mismatch'
  | 'lifecycle_busy'

export interface UpdateActionState {
  allowed: boolean
  reason?: UpdateActionBlock
}

export interface DiskVolumeCheck {
  dirs: string[]
  requiredBytes: number
  freeBytes: number
  sufficient: boolean
}

// Built from the installation's files (staged update, previous version in
// updater/backup) - the server's console replies are not visible to the panel.
export interface NativeUpdateStatus {
  available: boolean
  currentVersion: string
  latestVersion: string
  state: 'IDLE' | 'READY'
  currentPatchline: string | null
  staged: {
    version: string | null
    patchline: string | null
    jarBytes: number
    assetsBytes: number
    stagedAt: string
  } | null
  backup: {
    version: string | null
    patchline: string | null
    hasAssets: boolean
    createdAt: string
  } | null
  serverRunning: boolean
  updaterMounted: boolean
  // missing: not mounted in the panel; not_shared: the game container uses another updater folder
  updaterMount: 'mounted' | 'missing' | 'not_shared'
  // A stop, start, rollback or restore of the server runs or waits
  lifecycleBusy: boolean
  layoutValid: boolean | null
  disk: {
    checked: boolean
    sufficient: boolean
    requiredBytes: number
    volumes: DiskVolumeCheck[]
  } | null
  lastCheck: {
    patchline: string
    latestVersion: string
    checkedAt: string
    authRequired?: boolean
    error?: string
  } | null
  actions: {
    download: UpdateActionState
    apply: UpdateActionState
    cancel: UpdateActionState
    rollbackNative: UpdateActionState
    rollbackSnapshot: UpdateActionState
  }
}

export interface DownloaderVersion {
  installed: boolean
  version: string | null
  latestVersion: string | null
  updateAvailable: boolean
  busy: boolean
  checkedAt: string
}

export interface UpdateHistoryEntry {
  id: string
  at: string
  fromVersion: string | null
  toVersion: string | null
  action: 'apply' | 'rollback'
  by: string | null
  success: boolean
  /** Apply requested, not confirmed by the installed version yet. */
  pending?: boolean
  note?: string
}

export interface JarSnapshot {
  id: string
  version: string | null
  createdAt: string
  sizeBytes: number
  file: string
  /** Assets.zip of that version is kept with the snapshot. */
  hasAssets?: boolean
  assetsSizeBytes?: number
  /** HytaleServer.aot of that version is kept with the snapshot. */
  hasAot?: boolean
}

export interface RollbackOptions {
  /** Delete a downloaded (staged) update along with the rollback. */
  discardStaged?: boolean
}

export interface RollbackResponse {
  success: boolean
  message?: string
  warning?: string
  restoredVersion?: string | null
  restoredAssets?: boolean
  discardedStagedVersion?: string | null
  error?: string
}

export interface NewFeaturesStatus {
  hasNewFeatures: boolean
  features: string[]
  dismissed: boolean
  panelVersion: string
}

export interface PanelVersionInfo {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseUrl: string
  releaseNotes: string
  publishedAt: string
  lastChecked: string
}

export interface PatchlineResponse {
  patchline: string
  options: string[]
}

export interface PatchlineUpdateResponse {
  success: boolean
  patchline: string
  changed?: boolean
  message: string
}

export interface AcceptEarlyPluginsResponse {
  acceptEarlyPlugins: boolean
}

export interface AcceptEarlyPluginsUpdateResponse {
  success: boolean
  acceptEarlyPlugins: boolean
  changed?: boolean
  message: string
}

export interface DisableSentryResponse {
  disableSentry: boolean
}

export interface DisableSentryUpdateResponse {
  success: boolean
  disableSentry: boolean
  changed?: boolean
  message: string
}

export interface AllowOpResponse {
  allowOp: boolean
}

export interface AllowOpUpdateResponse {
  success: boolean
  allowOp: boolean
  changed?: boolean
  message: string
}

// KyuubiSoft API Plugin interfaces
export interface PluginStatus {
  installed: boolean
  running: boolean
  version: string | null
  port: number
  error?: string
  // Plugin refused the panel token (token_rejected) or has none (token_missing);
  // both clear after a server restart through the panel.
  authError?: 'token_rejected' | 'token_missing'
}

export interface PluginUpdateCheck {
  available: boolean
  currentVersion: string | null
  latestVersion: string
}

export interface PluginInstallResponse {
  success: boolean
  message?: string
  version?: string
  error?: string
}

// Plugin API data interfaces
export interface PluginServerInfo {
  version: string
  patchline: string
  onlinePlayers: number
  maxPlayers: number
  worldCount: number
  uptimeSeconds: number
  startedAt: string
  // Plugin 2.1+: 10 s average of the slowest world (tpsWorld) and its real
  // tick time in ms; absent while no world runs. Older plugins: capped at 20.
  tps: number
  mspt: number
  targetTps?: number
  tpsWorld?: string
}

// Tick statistics of one window ("10s", "1m", "5m"), plugin 2.1+
export interface PluginTpsWindow {
  window: string
  tpsAvg: number
  tpsMin: number
  tpsMax: number
  tickMsAvg: number
  tickMsMin: number
  tickMsMax: number
}

// Tick metrics and load of one world, plugin 2.1+
export interface PluginWorldPerf {
  world: string
  targetTps: number
  tickBudgetMs: number
  tps: number
  mspt: number
  windows: PluginTpsWindow[]
  players: number
  entities: number
  loadedChunks: number
}

// TPS summary: per-world metrics (plugin 2.1+) or the Prometheus gauges
export interface PluginTpsMetrics {
  current: number
  average: number
  min: number
  max: number
  target: number
  msptCurrent: number
  msptAverage: number
  world?: string
  worlds?: PluginWorldPerf[]
}

// Memory pool info
export interface MemoryPool {
  name: string
  used: number
  max: number
  percent: number
}

// GC stats
export interface GcStats {
  name: string
  count: number
  timeSeconds: number
}

// Thread metrics
export interface ThreadMetrics {
  current: number
  daemon: number
  peak: number
}

// Extended memory metrics
export interface ExtendedMemoryMetrics {
  heapUsed: number
  heapMax: number
  heapCommitted: number
  heapPercent: number
  nonHeapUsed: number
  nonHeapCommitted: number
  pools: MemoryPool[]
}

// Extended player metrics
export interface ExtendedPlayerMetrics {
  online: number
  max: number
  joins: number
  leaves: number
  perWorld: Record<string, number>
}

// Prometheus metrics response
export interface PrometheusMetrics {
  raw: string
  parsed?: {
    tps: PluginTpsMetrics
    players: ExtendedPlayerMetrics
    memory: ExtendedMemoryMetrics
    threads: ThreadMetrics
    gc: GcStats[]
    cpu: {
      process: number
      system: number
    }
    uptime: number
    worlds: number
  }
}

export interface PluginPlayer {
  uuid: string
  name: string
  position?: { x: number; y: number; z: number }
  world?: string
  health?: number
  gameMode?: string
  ping?: number
  joinedAt?: string
}

export interface PluginPlayersResponse {
  players: PluginPlayer[]
  count: number
}

export interface PluginMemoryInfo {
  heapUsed: number
  heapMax: number
  heapFree: number
  heapUsagePercent: number
}

export interface PluginApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}

// Player detail interfaces
export interface PluginPlayerDetails {
  uuid: string
  name: string
  world?: string
  position?: { x: number; y: number; z: number }
  yaw?: number
  pitch?: number
  gamemode?: string
  health?: number
  maxHealth?: number
}

export interface PluginInventoryItem {
  slot: number
  itemId: string
  displayName?: string
  amount: number
  durability?: number
  maxDurability?: number
  enchantments?: string[]
  nbt?: Record<string, unknown>
}

export interface PluginPlayerInventory {
  uuid: string
  name: string
  items: PluginInventoryItem[]
  totalSlots: number
  usedSlots: number
}

export interface PluginAppearanceCustomization {
  hairStyle?: string
  hairColor?: string
  eyeColor?: string
  skinTone?: string
  bodyType?: string
  accessories?: string[]
  colors?: Record<string, string>
}

export interface PluginPlayerAppearance {
  uuid: string
  name: string
  skinId?: string
  skinUrl?: string
  modelType?: string
  capeId?: string
  capeUrl?: string
  customization?: PluginAppearanceCustomization
}

// File-based player data interfaces (from server/universe/players/)
export interface FileInventoryItem {
  slot: number
  itemId: string
  displayName: string
  amount: number
  durability: number
  maxDurability: number
}

export interface FilePlayerInventory {
  uuid: string
  name: string
  storage: FileInventoryItem[]
  armor: FileInventoryItem[]
  hotbar: FileInventoryItem[]
  utility: FileInventoryItem[]
  backpack: FileInventoryItem[]
  tools: FileInventoryItem[]
  activeHotbarSlot: number
  totalSlots: number
  usedSlots: number
  // Per-container capacities reported by the API (optional; UI falls back to defaults).
  capacities?: {
    hotbar?: number
    armor?: number
    utility?: number
    storage?: number
    backpack?: number
    tools?: number
  }
  // 'live' when read from the running server (plugin 2.1+), absent for the saved file.
  source?: 'live'
}

// Live player data from the plugin (read on the player's world thread).
export interface LivePing {
  type: string
  lastMs?: number
  avg1mMs?: number
  min1mMs?: number
  max1mMs?: number
  avg5mMs?: number
}

export interface LivePlayerSnapshot {
  uuid: string
  name: string
  world?: string
  // Absent when the player was online before the plugin started.
  joinedAt?: string
  language?: string
  groups?: string[]
  ping?: LivePing
  // Protocol checksum of the client; the server keeps no client build string.
  protocolCrc?: number
  gamemode?: string
  stats?: Record<string, { value: number; max: number }>
  position?: { x: number; y: number; z: number }
  yaw?: number
  pitch?: number
  appearance?: Record<string, string>
}

export interface FilePlayerStats {
  health: number
  maxHealth: number
  stamina: number
  maxStamina: number
  oxygen: number
  mana: number
  immunity: number
}

export interface FilePlayerDetails {
  uuid: string
  name: string
  world: string
  gameMode: string
  position: { x: number; y: number; z: number } | null
  rotation: { pitch: number; yaw: number; roll: number } | null
  stats: FilePlayerStats
  discoveredZones: string[]
  memoriesCount: number
  uniqueItemsUsed: string[]
}

export interface PerfSample {
  ts: number
  tps: number | null
  // Target TPS and world of the sample's TPS (slowest world); null in gaps
  targetTps?: number | null
  world?: string | null
  mspt: number | null
  cpu: number | null
  mem: number | null
}

export interface PerfHistory {
  intervalMs: number
  samples: PerfSample[]
}

export interface StorageCategory {
  name: string
  path: string
  bytes: number
  exists: boolean
}

export interface FilesystemUsage {
  path: string
  totalBytes: number
  freeBytes: number
  usedBytes: number
  usedPercent: number
}

export interface StorageBreakdown {
  filesystem: FilesystemUsage | null
  categories: StorageCategory[]
  trackedBytes: number
  generatedAt: string
}

export interface JvmSettings {
  javaMinRam: string
  javaMaxRam: string
  extraJavaArgs: string
  extraServerArgs: string
  bootCommands: string[]
  aotCache: boolean
  nativeBackupMaxCount: number
  nativeBackupArchiveMaxCount: number
  /** Container memory limit; null = none / unknown. */
  memoryLimitMb: number | null
  /** Largest heap that leaves the JVM enough room inside the limit. */
  maxHeapMb: number | null
  /** Stored values the current validation would reject (saved by an older panel). */
  invalid?: { extraJavaArgs: string | null; extraServerArgs: string | null }
  envDefaults: { javaMinRam: string; javaMaxRam: string }
}

export interface JvmSettingsUpdate {
  javaMinRam: string
  javaMaxRam: string
  extraJavaArgs: string
  extraServerArgs: string
  bootCommands?: string[]
  aotCache?: boolean
  nativeBackupMaxCount?: number
  nativeBackupArchiveMaxCount?: number
}

export const serverApi = {
  async getStatus(): Promise<ServerStatus> {
    const response = await api.get<ServerStatus>('/server/status')
    return response.data
  },

  async getStats(): Promise<ServerStats> {
    const response = await api.get<ServerStats>('/server/stats')
    return response.data
  },

  async getMemoryStats(): Promise<ServerMemoryStats> {
    const response = await api.get<ServerMemoryStats>('/server/memory')
    return response.data
  },

  async getPerfHistory(): Promise<PerfHistory> {
    const response = await api.get<PerfHistory>('/server/perf-history')
    return response.data
  },

  async getStorage(): Promise<StorageBreakdown> {
    const response = await api.get<StorageBreakdown>('/server/storage')
    return response.data
  },

  async start(): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>('/server/start')
    return response.data
  },

  // The panel waits until the server has saved and exited (up to ~2.5 min
  // before it forces the stop), so these outlast the default 30 s timeout.
  async stop(): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>('/server/stop', undefined, {
      timeout: LIFECYCLE_TIMEOUT_MS,
    })
    return response.data
  },

  async restart(): Promise<ActionResponse> {
    const response = await api.post<ActionResponse>('/server/restart', undefined, {
      timeout: LIFECYCLE_TIMEOUT_MS,
    })
    return response.data
  },

  async getConfigFiles(): Promise<ConfigFilesResponse> {
    const response = await api.get<ConfigFilesResponse>('/server/config/files')
    return response.data
  },

  async getConfigContent(filename: string): Promise<ConfigContentResponse> {
    const response = await api.get<ConfigContentResponse>(
      `/server/config/${encodeURIComponent(filename)}`,
    )
    return response.data
  },

  // With `restart` the panel stops the server, writes and starts it again,
  // which outlasts the default timeout.
  async saveConfigContent(
    filename: string,
    content: string,
    options: { restart?: boolean } = {},
  ): Promise<ServerFileSaveResponse> {
    const response = await api.put<ServerFileSaveResponse>(
      `/server/config/${encodeURIComponent(filename)}`,
      { content, ...(options.restart ? { restart: true } : {}) },
      options.restart ? { timeout: LIFECYCLE_TIMEOUT_MS } : undefined,
    )
    return response.data
  },

  /** `live` also asks the running server for the values it uses. */
  async getQuickSettings(options: { live?: boolean } = {}): Promise<QuickSettingsResponse> {
    const response = await api.get<QuickSettingsResponse>('/server/quick-settings', {
      params: options.live ? { live: 1 } : undefined,
    })
    return response.data
  },

  async saveQuickSettings(
    settings: Partial<QuickSettings>,
    options: { restart?: boolean } = {},
  ): Promise<ServerFileSaveResponse> {
    const response = await api.put<ServerFileSaveResponse>(
      '/server/quick-settings',
      { ...settings, ...(options.restart ? { restart: true } : {}) },
      options.restart ? { timeout: LIFECYCLE_TIMEOUT_MS } : undefined,
    )
    return response.data
  },

  async dismissConfigNotes(): Promise<void> {
    await api.delete('/server/quick-settings/notes')
  },

  async checkForUpdates(): Promise<UpdateCheckResponse> {
    const response = await api.get<UpdateCheckResponse>('/server/check-update')
    return response.data
  },

  async getPatchline(): Promise<PatchlineResponse> {
    const response = await api.get<PatchlineResponse>('/server/patchline')
    return response.data
  },

  async setPatchline(patchline: string): Promise<PatchlineUpdateResponse> {
    const response = await api.put<PatchlineUpdateResponse>('/server/patchline', { patchline })
    return response.data
  },

  async getAcceptEarlyPlugins(): Promise<AcceptEarlyPluginsResponse> {
    const response = await api.get<AcceptEarlyPluginsResponse>('/server/accept-early-plugins')
    return response.data
  },

  async setAcceptEarlyPlugins(
    acceptEarlyPlugins: boolean,
  ): Promise<AcceptEarlyPluginsUpdateResponse> {
    const response = await api.put<AcceptEarlyPluginsUpdateResponse>(
      '/server/accept-early-plugins',
      { acceptEarlyPlugins },
    )
    return response.data
  },

  async getDisableSentry(): Promise<DisableSentryResponse> {
    const response = await api.get<DisableSentryResponse>('/server/disable-sentry')
    return response.data
  },

  async setDisableSentry(disableSentry: boolean): Promise<DisableSentryUpdateResponse> {
    const response = await api.put<DisableSentryUpdateResponse>('/server/disable-sentry', {
      disableSentry,
    })
    return response.data
  },

  async getAllowOp(): Promise<AllowOpResponse> {
    const response = await api.get<AllowOpResponse>('/server/allow-op')
    return response.data
  },

  async setAllowOp(allowOp: boolean): Promise<AllowOpUpdateResponse> {
    const response = await api.put<AllowOpUpdateResponse>('/server/allow-op', { allowOp })
    return response.data
  },

  async getJvmSettings(): Promise<JvmSettings> {
    const response = await api.get<JvmSettings>('/server/jvm')
    return response.data
  },

  async saveJvmSettings(
    payload: JvmSettingsUpdate,
  ): Promise<{ success: boolean; changed: boolean; message?: string }> {
    const response = await api.put('/server/jvm', payload)
    return response.data
  },

  // KyuubiSoft API Plugin methods
  async getPluginStatus(): Promise<PluginStatus> {
    const response = await api.get<PluginStatus>('/server/plugin/status')
    return response.data
  },

  async checkPluginUpdate(): Promise<PluginUpdateCheck> {
    const response = await api.get<PluginUpdateCheck>('/server/plugin/update-check')
    return response.data
  },

  async installPlugin(): Promise<PluginInstallResponse> {
    const response = await api.post<PluginInstallResponse>('/server/plugin/install')
    return response.data
  },

  async uninstallPlugin(): Promise<PluginInstallResponse> {
    const response = await api.delete<PluginInstallResponse>('/server/plugin/uninstall')
    return response.data
  },

  // Plugin API data methods
  async getPluginServerInfo(): Promise<PluginApiResponse<PluginServerInfo>> {
    const response = await api.get<PluginApiResponse<PluginServerInfo>>('/server/plugin/info')
    return response.data
  },

  async getPluginPlayers(): Promise<PluginApiResponse<PluginPlayersResponse>> {
    const response =
      await api.get<PluginApiResponse<PluginPlayersResponse>>('/server/plugin/players')
    return response.data
  },

  async getPluginMemory(): Promise<PluginApiResponse<PluginMemoryInfo>> {
    const response = await api.get<PluginApiResponse<PluginMemoryInfo>>('/server/plugin/memory')
    return response.data
  },

  async getPluginPrometheusMetrics(): Promise<PluginApiResponse<PrometheusMetrics>> {
    const response = await api.get<PluginApiResponse<PrometheusMetrics>>('/server/plugin/metrics')
    return response.data
  },

  async getPluginTpsMetrics(): Promise<PluginApiResponse<PluginTpsMetrics>> {
    const response = await api.get<PluginApiResponse<PluginTpsMetrics>>('/server/plugin/tps')
    return response.data
  },

  // Player detail methods
  async getPluginPlayerDetails(
    playerName: string,
  ): Promise<PluginApiResponse<PluginPlayerDetails>> {
    const response = await api.get<PluginApiResponse<PluginPlayerDetails>>(
      `/server/plugin/players/${encodeURIComponent(playerName)}/details`,
    )
    return response.data
  },

  async getPluginPlayerInventory(
    playerName: string,
  ): Promise<PluginApiResponse<PluginPlayerInventory>> {
    const response = await api.get<PluginApiResponse<PluginPlayerInventory>>(
      `/server/plugin/players/${encodeURIComponent(playerName)}/inventory`,
    )
    return response.data
  },

  async getPluginPlayerAppearance(
    playerName: string,
  ): Promise<PluginApiResponse<PluginPlayerAppearance>> {
    const response = await api.get<PluginApiResponse<PluginPlayerAppearance>>(
      `/server/plugin/players/${encodeURIComponent(playerName)}/appearance`,
    )
    return response.data
  },

  // Live player data (plugin 2.1+); rejects with 404 while the player is offline.
  async getPluginPlayerLive(playerName: string): Promise<PluginApiResponse<LivePlayerSnapshot>> {
    const response = await api.get<PluginApiResponse<LivePlayerSnapshot>>(
      `/server/plugin/players/${encodeURIComponent(playerName)}/live`,
    )
    return response.data
  },

  // The real inventory in the same shape as the saved-file inventory (source: 'live').
  async getPluginPlayerLiveInventory(
    playerName: string,
  ): Promise<PluginApiResponse<FilePlayerInventory>> {
    const response = await api.get<PluginApiResponse<FilePlayerInventory>>(
      `/server/plugin/players/${encodeURIComponent(playerName)}/live/inventory`,
    )
    return response.data
  },

  // File-based player data methods (reads from server/universe/players/)
  async getFilePlayerDetails(playerName: string): Promise<PluginApiResponse<FilePlayerDetails>> {
    const response = await api.get<PluginApiResponse<FilePlayerDetails>>(
      `/server/players/${encodeURIComponent(playerName)}/file/details`,
    )
    return response.data
  },

  async getFilePlayerInventory(
    playerName: string,
  ): Promise<PluginApiResponse<FilePlayerInventory>> {
    const response = await api.get<PluginApiResponse<FilePlayerInventory>>(
      `/server/players/${encodeURIComponent(playerName)}/file/inventory`,
    )
    return response.data
  },

  // Downloader authentication methods
  async getDownloaderAuthStatus(): Promise<DownloaderAuthStatus> {
    const response = await api.get<DownloaderAuthStatus>('/server/downloader/auth-status')
    return response.data
  },

  async initiateDownloaderAuth(): Promise<DownloaderAuthInitResponse> {
    const response = await api.post<DownloaderAuthInitResponse>('/server/downloader/initiate-auth')
    return response.data
  },

  async pollDownloaderAuth(): Promise<DownloaderAuthPollResponse> {
    const response = await api.get<DownloaderAuthPollResponse>('/server/downloader/auth-poll')
    return response.data
  },

  // Native Update System Methods (Hytale 24.01.2026+)
  async getUpdateConfig(): Promise<UpdateConfig> {
    const response = await api.get<UpdateConfig>('/server/update-config')
    return response.data
  },

  // The server only accepts the change while it is stopped: with a running
  // server this rejects with 409 `requiresRestart` unless `restart` is set,
  // which stops the server, saves and starts it again (it takes as long as a restart).
  async saveUpdateConfig(
    config: Partial<UpdateConfig>,
    options: { restart?: boolean } = {},
  ): Promise<{ success: boolean; message?: string; restarted?: boolean; data?: UpdateConfig }> {
    const response = await api.put<{
      success: boolean
      message?: string
      restarted?: boolean
      data?: UpdateConfig
    }>(
      '/server/update-config',
      { ...config, ...(options.restart ? { restart: true } : {}) },
      options.restart ? { timeout: LIFECYCLE_TIMEOUT_MS } : undefined,
    )
    return response.data
  },

  async getUpdateStatus(): Promise<{
    success: boolean
    data?: NativeUpdateStatus
    error?: string
  }> {
    const response = await api.get<{ success: boolean; data?: NativeUpdateStatus; error?: string }>(
      '/server/update-status',
    )
    return response.data
  },

  async checkForNativeUpdate(): Promise<{
    success: boolean
    data?: NativeUpdateStatus
    message?: string
    error?: string
  }> {
    const response = await api.post<{
      success: boolean
      data?: NativeUpdateStatus
      message?: string
      error?: string
    }>('/server/update-check', undefined, { timeout: DOWNLOADER_PROBE_TIMEOUT_MS })
    return response.data
  },

  async downloadNativeUpdate(): Promise<{ success: boolean; message?: string; error?: string }> {
    const response = await api.post<{ success: boolean; message?: string; error?: string }>(
      '/server/update-download',
    )
    return response.data
  },

  // force: apply despite the disk-space estimate; allowPatchlineSwitch:
  // install a staged build of another patchline.
  async applyNativeUpdate(
    options: { force?: boolean; allowPatchlineSwitch?: boolean } = {},
  ): Promise<{
    success: boolean
    message?: string
    warning?: string
    error?: string
  }> {
    const response = await api.post<{
      success: boolean
      message?: string
      warning?: string
      error?: string
    }>('/server/update-apply', {
      ...(options.force ? { force: true } : {}),
      ...(options.allowPatchlineSwitch ? { allowPatchlineSwitch: true } : {}),
    })
    return response.data
  },

  // A running server discards it itself (asynchronously); for a stopped one the
  // panel deletes it right away (`discarded: true`).
  async cancelNativeUpdate(): Promise<{
    success: boolean
    discarded?: boolean
    message?: string
    error?: string
  }> {
    const response = await api.post<{
      success: boolean
      discarded?: boolean
      message?: string
      error?: string
    }>('/server/update-cancel')
    return response.data
  },

  async getUpdateHistory(): Promise<{ history: UpdateHistoryEntry[] }> {
    const response = await api.get<{ history: UpdateHistoryEntry[] }>('/server/update-history')
    return response.data
  },

  async getJarSnapshots(): Promise<{ snapshots: JarSnapshot[] }> {
    const response = await api.get<{ snapshots: JarSnapshot[] }>('/server/jar-snapshots')
    return response.data
  },

  async createJarSnapshot(): Promise<{ success: boolean; snapshot?: JarSnapshot; error?: string }> {
    const response = await api.post<{ success: boolean; snapshot?: JarSnapshot; error?: string }>(
      '/server/jar-snapshot',
    )
    return response.data
  },

  // `discardStaged`: a downloaded update would be installed again by the next
  // start, so the rollback is refused (409 staged_update) unless it discards it.
  // The answer comes after the stop, the copy and the start.
  async rollbackJar(snapshotId: string, options: RollbackOptions = {}): Promise<RollbackResponse> {
    const response = await api.post<RollbackResponse>(
      '/server/rollback',
      { snapshotId, ...(options.discardStaged ? { discardStaged: true } : {}) },
      { timeout: ROLLBACK_TIMEOUT_MS },
    )
    return response.data
  },

  // Previous version kept in updater/backup (JAR, Assets.zip, Licenses).
  async rollbackNative(options: RollbackOptions = {}): Promise<RollbackResponse> {
    const response = await api.post<RollbackResponse>(
      '/server/rollback',
      { source: 'native', ...(options.discardStaged ? { discardStaged: true } : {}) },
      { timeout: ROLLBACK_TIMEOUT_MS },
    )
    return response.data
  },

  async getDownloaderVersion(
    refresh = false,
  ): Promise<{ success: boolean; data?: DownloaderVersion; error?: string }> {
    const response = await api.get<{ success: boolean; data?: DownloaderVersion; error?: string }>(
      '/server/downloader-version',
      { params: refresh ? { refresh: '1' } : {}, timeout: DOWNLOADER_PROBE_TIMEOUT_MS },
    )
    return response.data
  },

  async updateDownloader(): Promise<{
    success: boolean
    message?: string
    data?: DownloaderVersion
    error?: string
  }> {
    const response = await api.post<{
      success: boolean
      message?: string
      data?: DownloaderVersion
      error?: string
    }>('/server/downloader-update', undefined, { timeout: DOWNLOADER_UPDATE_TIMEOUT_MS })
    return response.data
  },

  // New Features Banner
  async getNewFeaturesStatus(): Promise<NewFeaturesStatus> {
    const response = await api.get<NewFeaturesStatus>('/server/new-features')
    return response.data
  },

  async dismissNewFeaturesBanner(): Promise<{ success: boolean }> {
    const response = await api.post<{ success: boolean }>('/server/new-features/dismiss')
    return response.data
  },

  // Panel Version Check
  async checkPanelVersion(forceRefresh = false): Promise<PanelVersionInfo> {
    const url = forceRefresh ? '/server/panel-version?refresh=true' : '/server/panel-version'
    const response = await api.get<PanelVersionInfo>(url)
    return response.data
  },
}
