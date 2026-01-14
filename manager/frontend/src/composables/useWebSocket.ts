import { ref, onMounted, onUnmounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { useConsoleStore } from '@/stores/console'

export function useWebSocket() {
  const authStore = useAuthStore()
  const consoleStore = useConsoleStore()

  const ws = ref<WebSocket | null>(null)
  const reconnectAttempts = ref(0)
  const maxReconnectAttempts = 5
  const reconnectDelay = 3000

  function connect() {
    if (!authStore.accessToken) {
      console.warn('No access token, cannot connect to WebSocket')
      return
    }

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

      // Try to reconnect
      if (reconnectAttempts.value < maxReconnectAttempts) {
        reconnectAttempts.value++
        console.log(`Reconnecting in ${reconnectDelay}ms... (attempt ${reconnectAttempts.value})`)
        setTimeout(connect, reconnectDelay)
      }
    }

    ws.value.onerror = (error) => {
      console.error('WebSocket error:', error)
    }
  }

  function disconnect() {
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

  // Keep-alive ping
  let pingInterval: ReturnType<typeof setInterval> | null = null

  onMounted(() => {
    connect()
    pingInterval = setInterval(ping, 30000)
  })

  onUnmounted(() => {
    if (pingInterval) {
      clearInterval(pingInterval)
    }
    disconnect()
  })

  return {
    connected: consoleStore.connected,
    connect,
    disconnect,
    sendCommand,
  }
}
