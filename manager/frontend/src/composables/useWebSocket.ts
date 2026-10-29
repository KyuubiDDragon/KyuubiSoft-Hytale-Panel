import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useConsoleStore } from '@/stores/console'
import { consoleApi, type LiveLogEntry, type LogsResponse } from '@/api/console'
import { authApi } from '@/api/auth'
import { useServersStore } from '@/stores/servers'
import { scopedWsUrl } from '@/api/scope'

// Commands typed while the console (re)connects are sent once it is open;
// at most this many, for at most QUEUED_COMMAND_MS.
const MAX_QUEUED_COMMANDS = 20
const QUEUED_COMMAND_MS = 15_000
// Without any message for this long the connection counts as dead (the
// client pings every 30 s and the server answers).
const SILENCE_LIMIT_MS = 75_000
// Quick attempts before the console waits a while and offers a manual retry.
export const MAX_RECONNECT_ATTEMPTS = 5
// Close codes after which reconnecting cannot help.
const FINAL_CLOSE_CODES: Record<number, string> = {
  4003: 'console.permissionLost',
  4004: 'console.unknownServer',
}

export function useWebSocket() {
  const { t } = useI18n()
  const authStore = useAuthStore()
  const consoleStore = useConsoleStore()
  const serversStore = useServersStore()

  const ws = ref<WebSocket | null>(null)
  const reconnectAttempts = ref(0)
  const maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS
  const baseReconnectDelay = 3000
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  let isManualDisconnect = false
  // Closed for a reason reconnecting cannot fix; only the reconnect button tries again.
  let finalClosed = false
  let connecting = false
  let lastMessageAt = Date.now()
  const queuedCommands: Array<{ command: string; requestId: string; until: number }> = []

  function notice(level: 'INFO' | 'WARN' | 'ERROR', message: string) {
    consoleStore.addLog({ timestamp: new Date().toISOString(), level, message })
  }

  /** Commands sent over a socket that is gone get no answer any more; queued ones still go out. */
  function failSentCommands() {
    const queued = new Set(queuedCommands.map((q) => q.requestId))
    consoleStore.failPendingCommands('console.reply.connectionLost', undefined, (id) =>
      queued.has(id),
    )
  }

  /** Closes the current socket without its close handler running (no reconnect from it). */
  function closeSocket() {
    const socket = ws.value
    ws.value = null
    connecting = false
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    if (socket.readyState !== WebSocket.CLOSED) socket.close()
    consoleStore.setConnected(false)
    failSentCommands()
  }

  function scheduleReconnect() {
    if (reconnectTimeout || isManualDisconnect) return
    if (reconnectAttempts.value < maxReconnectAttempts) {
      reconnectAttempts.value++
      consoleStore.setReconnect(reconnectAttempts.value, false)
      // Exponential backoff: 3s, 6s, 12s, 24s, 48s
      const delay = baseReconnectDelay * Math.pow(2, reconnectAttempts.value - 1)
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null
        void connect()
      }, delay)
    } else {
      // After max attempts, wait longer and reset counter for eventual retry.
      // The console shows that it paused and offers "connect now".
      consoleStore.setReconnect(maxReconnectAttempts, true)
      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null
        reconnectAttempts.value = 0
        void connect()
      }, 30000)
    }
  }

  /** Commands that waited too long, or for a connection that will not come, are not sent. */
  function dropQueuedCommands(all: boolean) {
    const now = Date.now()
    for (let i = queuedCommands.length - 1; i >= 0; i--) {
      const queued = queuedCommands[i]
      if (all || queued.until <= now || !consoleStore.isCommandPending(queued.requestId)) {
        queuedCommands.splice(i, 1)
        consoleStore.failPendingCommands('console.reply.notSent', queued.requestId)
      }
    }
  }

  function flushQueuedCommands() {
    dropQueuedCommands(false)
    const socket = ws.value
    while (queuedCommands.length > 0 && socket?.readyState === WebSocket.OPEN) {
      const { command, requestId } = queuedCommands.shift()!
      socket.send(JSON.stringify({ type: 'command', payload: command, requestId }))
    }
  }

  async function connect() {
    // Clear any pending reconnect
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }

    if (!authStore.accessToken) {
      console.warn('No access token, cannot connect to WebSocket')
      return
    }

    // Close existing connection if any
    closeSocket()
    isManualDisconnect = false
    connecting = true

    // Get a single-use ticket for WebSocket authentication
    // This is more secure than putting the JWT in the URL
    let ticket: string
    // The ticket belongs to the server the socket is opened for.
    const ticketServerId = serversStore.scopeId
    try {
      const ticketResponse = await authApi.getWsTicket(ticketServerId)
      ticket = ticketResponse.ticket
    } catch (error) {
      console.error('Failed to get WebSocket ticket:', error)
      connecting = false
      scheduleReconnect()
      return
    }
    // A disconnect or another connect while the ticket was on its way wins.
    if (isManualDisconnect || ws.value) return

    // The server changed while the ticket was on its way: it would not open.
    if (serversStore.scopeId !== ticketServerId) {
      connecting = false
      void connect()
      return
    }
    const url = scopedWsUrl('console/ws', ticket)

    const socket = new WebSocket(url)
    ws.value = socket

    socket.onopen = () => {
      connecting = false
      lastMessageAt = Date.now()
      consoleStore.setConnected(true)
      reconnectAttempts.value = 0
      consoleStore.setReconnect(0, false)
      // The server holds messages until the socket is authenticated.
      flushQueuedCommands()
    }

    socket.onmessage = (event) => {
      lastMessageAt = Date.now()
      try {
        handleMessage(JSON.parse(event.data))
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error)
      }
    }

    socket.onclose = (event) => {
      if (ws.value !== socket) return
      ws.value = null
      connecting = false
      consoleStore.setConnected(false)
      // Answers to commands sent over this socket can no longer arrive.
      failSentCommands()

      const finalKey = FINAL_CLOSE_CODES[event.code]
      if (finalKey) {
        finalClosed = true
        consoleStore.setReconnect(0, false)
        dropQueuedCommands(true)
        notice('ERROR', t(finalKey))
        return
      }
      scheduleReconnect()
    }

    socket.onerror = (error) => {
      console.error('WebSocket error:', error)
    }
  }

  function handleMessage(data: Record<string, unknown>) {
    switch (data.type) {
      case 'log_batch':
        if (Array.isArray(data.entries)) {
          consoleStore.addServerEntries(data.entries as LiveLogEntry[], data.history === true)
        }
        break

      case 'log':
        // Single entries (older panel versions).
        consoleStore.addServerEntries([data as unknown as LiveLogEntry])
        break

      case 'logs_dropped':
        notice(
          'WARN',
          t(
            data.reason === 'burst' ? 'console.droppedBurst' : 'console.droppedSlow',
            { count: Number(data.count) || 0 },
            Number(data.count) || 0,
          ),
        )
        break

      case 'player_event':
        consoleStore.addLog({
          timestamp: String(data.timestamp),
          level: 'INFO',
          message: `Player ${data.player} ${data.event === 'join' ? 'joined' : 'left'} the game`,
        })
        break

      case 'command_response':
        // Newer backends echo the request id: show the answer as a block
        // under the command it belongs to.
        if (
          typeof data.requestId === 'string' &&
          consoleStore.setCommandReply(data.requestId, {
            success: data.success as boolean | undefined,
            status: data.status as never,
            via: data.via as never,
            lines: Array.isArray(data.lines) ? (data.lines as string[]) : [],
            error: data.success === false ? (data.error as string | undefined) : undefined,
          })
        ) {
          break
        }
        if (data.output) {
          notice('INFO', String(data.output))
        }
        // Surface failures (permission denied, validation, server not
        // running, …) instead of silently dropping them — otherwise a
        // rejected command looks like it just did nothing.
        if (data.success === false && data.error) {
          notice('ERROR', String(data.error))
        }
        break

      case 'error':
        notice('ERROR', String(data.message))
        break

      case 'pong':
        // Keep-alive response
        break

      default:
        console.log('Unknown WebSocket message:', data)
    }
  }

  function disconnect() {
    isManualDisconnect = true
    consoleStore.setReconnect(0, false)
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    closeSocket()
    dropQueuedCommands(true)
  }

  // Returns true if the command was sent, or will be once the console is
  // connected again. Otherwise the caller keeps the typed text and shows a
  // "not connected" message instead of the command silently vanishing.
  function sendCommand(command: string): boolean {
    if (ws.value && ws.value.readyState === WebSocket.OPEN) {
      // Log the command first; its answer is attached to it by request id.
      const requestId = consoleStore.addCommand(command)
      ws.value.send(
        JSON.stringify({
          type: 'command',
          payload: command,
          requestId,
        }),
      )
      return true
    }

    const reconnecting =
      connecting || reconnectTimeout !== null || ws.value?.readyState === WebSocket.CONNECTING
    if (!reconnecting) void reconnect()
    if (queuedCommands.length >= MAX_QUEUED_COMMANDS) return false
    const requestId = consoleStore.addCommand(command)
    queuedCommands.push({ command, requestId, until: Date.now() + QUEUED_COMMAND_MS })
    setTimeout(() => dropQueuedCommands(false), QUEUED_COMMAND_MS + 50)
    return true
  }

  function ping() {
    const socket = ws.value
    if (socket && socket.readyState === WebSocket.OPEN) {
      if (Date.now() - lastMessageAt > SILENCE_LIMIT_MS) {
        // The server stopped answering: start over instead of waiting forever.
        closeSocket()
        scheduleReconnect()
        return
      }
      socket.send(JSON.stringify({ type: 'ping' }))
    }
  }

  async function reconnect() {
    finalClosed = false
    reconnectAttempts.value = 0
    consoleStore.setReconnect(0, false)
    await connect()
  }

  // A tab that comes back or a network that returns reconnects right away.
  function reconnectIfIdle() {
    if (document.visibilityState === 'hidden' || isManualDisconnect || finalClosed) return
    if (!ws.value || ws.value.readyState === WebSocket.CLOSED) void reconnect()
  }

  const isLoadingLogs = ref(false)

  async function loadAllLogs(limit: number = 0): Promise<LogsResponse> {
    isLoadingLogs.value = true
    try {
      const response = await consoleApi.getLogs(limit)
      if (response.logs && response.logs.length > 0) {
        consoleStore.replaceLogs(
          response.logs.map((log) => ({
            timestamp: log.timestamp,
            level: log.level,
            message: log.message,
            logger: log.logger,
          })),
        )
      }
      return response
    } finally {
      isLoadingLogs.value = false
    }
  }

  // Keep-alive ping
  let pingInterval: ReturnType<typeof setInterval> | null = null

  // Switching servers: leave the old console, open the new one.
  const stopScopeWatch = watch(
    () => serversStore.scopeId,
    () => {
      queuedCommands.length = 0
      void reconnect()
    },
  )

  onMounted(() => {
    void connect()
    pingInterval = setInterval(ping, 30000)
    document.addEventListener('visibilitychange', reconnectIfIdle)
    window.addEventListener('online', reconnectIfIdle)
  })

  onUnmounted(() => {
    stopScopeWatch()
    if (pingInterval) {
      clearInterval(pingInterval)
      pingInterval = null
    }
    document.removeEventListener('visibilitychange', reconnectIfIdle)
    window.removeEventListener('online', reconnectIfIdle)
    disconnect()
  })

  return {
    connected: consoleStore.connected,
    isLoadingLogs,
    connect,
    disconnect,
    reconnect,
    sendCommand,
    loadAllLogs,
  }
}
