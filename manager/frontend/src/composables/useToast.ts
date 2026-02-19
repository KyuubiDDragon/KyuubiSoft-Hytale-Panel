import { ref } from 'vue'

export interface Toast {
  id: number
  message: string
  type: 'success' | 'error' | 'warning' | 'info'
  duration: number
}

const toasts = ref<Toast[]>([])
let nextId = 0

export function useToast() {
  function addToast(message: string, type: Toast['type'] = 'info', duration = 4000) {
    const id = nextId++
    toasts.value.push({ id, message, type, duration })
    setTimeout(() => {
      removeToast(id)
    }, duration)
  }

  function removeToast(id: number) {
    const index = toasts.value.findIndex(t => t.id === id)
    if (index > -1) {
      toasts.value.splice(index, 1)
    }
  }

  function success(message: string) {
    addToast(message, 'success')
  }

  function error(message: string) {
    addToast(message, 'error', 6000)
  }

  function warning(message: string) {
    addToast(message, 'warning', 5000)
  }

  function info(message: string) {
    addToast(message, 'info')
  }

  return { toasts, addToast, removeToast, success, error, warning, info }
}
