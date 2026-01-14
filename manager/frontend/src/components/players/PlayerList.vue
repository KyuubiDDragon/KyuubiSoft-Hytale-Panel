<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PlayerInfo } from '@/api/players'
import Button from '@/components/ui/Button.vue'

const { t } = useI18n()

defineProps<{
  players: PlayerInfo[]
  loading?: boolean
}>()

const emit = defineEmits<{
  kick: [name: string]
  ban: [name: string]
  whitelist: [name: string]
  op: [name: string]
  teleport: [name: string]
  message: [name: string, message: string]
}>()

const expandedPlayer = ref<string | null>(null)
const messageText = ref('')

function togglePlayer(name: string) {
  if (expandedPlayer.value === name) {
    expandedPlayer.value = null
  } else {
    expandedPlayer.value = name
    messageText.value = ''
  }
}

function sendMessage(name: string) {
  if (messageText.value.trim()) {
    emit('message', name, messageText.value)
    messageText.value = ''
  }
}
</script>

<template>
  <div>
    <!-- Loading State -->
    <div v-if="loading" class="text-center text-gray-500 py-8">
      {{ t('common.loading') }}
    </div>

    <!-- Empty State -->
    <div v-else-if="players.length === 0" class="text-center text-gray-500 py-8">
      {{ t('players.noPlayers') }}
    </div>

    <!-- Player Cards -->
    <div v-else class="divide-y divide-dark-50/30">
      <div
        v-for="player in players"
        :key="player.name"
        class="group"
      >
        <!-- Player Row (clickable) -->
        <div
          @click="togglePlayer(player.name)"
          class="flex items-center justify-between p-4 cursor-pointer hover:bg-dark-50/30 transition-colors"
        >
          <div class="flex items-center gap-4">
            <!-- Avatar -->
            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-hytale-orange to-hytale-yellow flex items-center justify-center">
              <span class="text-dark font-bold text-lg">
                {{ player.name.charAt(0).toUpperCase() }}
              </span>
            </div>

            <!-- Info -->
            <div>
              <p class="font-semibold text-white text-lg">{{ player.name }}</p>
              <div class="flex items-center gap-3 text-sm text-gray-400">
                <span class="flex items-center gap-1">
                  <span class="w-2 h-2 bg-status-success rounded-full"></span>
                  Online
                </span>
                <span>{{ player.session_duration || '-' }}</span>
              </div>
            </div>
          </div>

          <!-- Expand Arrow -->
          <svg
            :class="[
              'w-5 h-5 text-gray-400 transition-transform',
              expandedPlayer === player.name ? 'rotate-180' : ''
            ]"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </div>

        <!-- Expanded Actions -->
        <div
          v-if="expandedPlayer === player.name"
          class="px-4 pb-4 bg-dark-100/50"
        >
          <!-- Quick Actions -->
          <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
            <button
              @click.stop="emit('kick', player.name)"
              class="flex items-center justify-center gap-2 px-4 py-3 bg-dark-100 rounded-lg text-gray-300 hover:bg-status-warning/20 hover:text-status-warning transition-colors"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
              {{ t('players.kick') }}
            </button>

            <button
              @click.stop="emit('ban', player.name)"
              class="flex items-center justify-center gap-2 px-4 py-3 bg-dark-100 rounded-lg text-gray-300 hover:bg-status-error/20 hover:text-status-error transition-colors"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
              {{ t('players.ban') }}
            </button>

            <button
              @click.stop="emit('whitelist', player.name)"
              class="flex items-center justify-center gap-2 px-4 py-3 bg-dark-100 rounded-lg text-gray-300 hover:bg-hytale-orange/20 hover:text-hytale-orange transition-colors"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              {{ t('players.whitelist') }}
            </button>

            <button
              @click.stop="emit('op', player.name)"
              class="flex items-center justify-center gap-2 px-4 py-3 bg-dark-100 rounded-lg text-gray-300 hover:bg-purple-500/20 hover:text-purple-400 transition-colors"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
              OP
            </button>
          </div>

          <!-- Send Message -->
          <div class="flex gap-2">
            <input
              v-model="messageText"
              @click.stop
              @keyup.enter="sendMessage(player.name)"
              type="text"
              :placeholder="t('players.messagePlaceholder') || 'Send message...'"
              class="flex-1 px-4 py-2 bg-dark-100 border border-dark-50 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-hytale-orange"
            />
            <Button
              variant="primary"
              @click.stop="sendMessage(player.name)"
              :disabled="!messageText.trim()"
            >
              <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
