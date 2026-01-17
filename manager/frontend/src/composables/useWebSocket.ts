import { ref, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useConsoleStore } from '@/stores/console'
import api from '@/services/api'

export function useWebSocket() {
  const authStore = useAuthStore()
  const consoleStore = useConsoleStore()

  const ws = ref<WebSocket | null>(null)
  const reconnectAttempts = ref(0)
  const maxReconnectAttempts = 5
  const baseReconnectDelay = 3000
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  let isManualDisconnect = false

  function connect() {
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
    if (ws.value && ws.value.readyState !== WebSocket.CLOSED) {
      isManualDisconnect = true
      ws.value.close()
    }

    isManualDisconnect = false

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const url = `${protocol}//${host}/api/console/ws?token=${authStore.accessToken}`

    ws.value = new WebSocket(url)

    ws.value.onopen = () => {
      console.log('WebSocket connected')
      consoleStore.setConnected(true)
      reconnectAttempts.value = 0
    }

    ws.value.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        switch (data.type) {
          case 'log':
            consoleStore.addLog({
              timestamp: data.timestamp,
              level: data.level,
              message: data.message,
            })
            break

          case 'player_event':
            consoleStore.addLog({
              timestamp: data.timestamp,
              level: 'INFO',
              message: `Player ${data.player} ${data.event === 'join' ? 'joined' : 'left'} the game`,
            })
            break

          case 'command_response':
            if (data.output) {
              consoleStore.addLog({
                timestamp: new Date().toISOString(),
                level: 'INFO',
                message: data.output,
              })
            }
            break

          case 'error':
            consoleStore.addLog({
              timestamp: new Date().toISOString(),
              level: 'ERROR',
              message: data.message,
            })
            break

          case 'pong':
            // Keep-alive response
            break

          default:
            console.log('Unknown WebSocket message:', data)
        }
      } catch (error) {
        console.error('Failed to parse WebSocket message:', error)
      }
    }

    ws.value.onclose = () => {
      console.log('WebSocket disconnected')
      consoleStore.setConnected(false)

      // Don't reconnect if manually disconnected
      if (isManualDisconnect) {
        return
      }

      // Try to reconnect with exponential backoff
      if (reconnectAttempts.value < maxReconnectAttempts) {
        reconnectAttempts.value++
        // Exponential backoff: 3s, 6s, 12s, 24s, 48s
        const delay = baseReconnectDelay * Math.pow(2, reconnectAttempts.value - 1)
        console.log(`Reconnecting in ${delay}ms... (attempt ${reconnectAttempts.value}/${maxReconnectAttempts})`)
        reconnectTimeout = setTimeout(connect, delay)
      } else {
        // After max attempts, wait longer and reset counter for eventual retry
        console.log('Max reconnection attempts reached, will retry in 30 seconds...')
        reconnectTimeout = setTimeout(() => {
          reconnectAttempts.value = 0
          connect()
        }, 30000)
      }
    }

    ws.value.onerror = (error) => {
      console.error('WebSocket error:', error)
    }
  }

  function disconnect() {
    isManualDisconnect = true
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
    if (ws.value) {
      ws.value.close()
      ws.value = null
    }
  }

  function sendCommand(command: string) {
    if (ws.value && ws.value.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify({
        type: 'command',
        payload: command,
      }))

      // Add command to logs
      consoleStore.addLog({
        timestamp: new Date().toISOString(),
        level: 'INFO',
        message: `> ${command}`,
      })
    }
  }

  function ping() {
    if (ws.value && ws.value.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify({ type: 'ping' }))
    }
  }

  function reconnect() {
    console.log('Manual reconnect requested')
    reconnectAttempts.value = 0
    connect()
  }

  const isLoadingLogs = ref(false)

  async function loadAllLogs(limit: number = 0) {
    if (isLoadingLogs.value) return

    isLoadingLogs.value = true
    try {
      const response = await api.get('/console/logs', {
        params: { tail: limit }
      })

      if (response.data.logs && response.data.logs.length > 0) {
        // Clear existing logs and add all fetched logs
        consoleStore.clearLogs()
        for (const log of response.data.logs) {
          consoleStore.addLog({
            timestamp: log.timestamp,
            level: log.level,
            message: log.message,
          })
        }
      }

      return response.data.count
    } catch (error) {
      console.error('Failed to load logs:', error)
      throw error
    } finally {
      isLoadingLogs.value = false
    }
  }

  // Keep-alive ping
  let pingInterval: ReturnType<typeof setInterval> | null = null

  onMounted(() => {
    connect()
    pingInterval = setInterval(ping, 30000)
  })

  onUnmounted(() => {
    if (pingInterval) {
      clearInterval(pingInterval)
      pingInterval = null
    }
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout)
      reconnectTimeout = null
    }
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
