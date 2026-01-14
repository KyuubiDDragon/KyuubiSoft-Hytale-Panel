<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { playersApi, type PlayerInfo } from '@/api/players'
import Card from '@/components/ui/Card.vue'
import Button from '@/components/ui/Button.vue'
import Modal from '@/components/ui/Modal.vue'
import PlayerList from '@/components/players/PlayerList.vue'

const { t } = useI18n()

const players = ref<PlayerInfo[]>([])
const loading = ref(true)
const error = ref('')

// Modals
const showKickModal = ref(false)
const showBanModal = ref(false)
const selectedPlayer = ref<string | null>(null)
const actionLoading = ref(false)

let pollInterval: ReturnType<typeof setInterval> | null = null

async function fetchPlayers() {
  try {
    const response = await playersApi.getOnline()
    players.value = response.players
    error.value = ''
  } catch (err) {
    error.value = t('errors.connectionFailed')
  } finally {
    loading.value = false
  }
}

function handleKick(name: string) {
  selectedPlayer.value = name
  showKickModal.value = true
}

function handleBan(name: string) {
  selectedPlayer.value = name
  showBanModal.value = true
}

async function handleWhitelist(name: string) {
  try {
    await playersApi.addToWhitelist(name)
  } catch (err) {
    error.value = t('errors.serverError')
  }
}

async function handleOp(name: string) {
  try {
    await playersApi.op(name)
  } catch (err) {
    error.value = t('errors.serverError')
  }
}

async function handleMessage(name: string, message: string) {
  try {
    await playersApi.sendMessage(name, message)
  } catch (err) {
    error.value = t('errors.serverError')
  }
}

async function confirmKick() {
  if (!selectedPlayer.value) return
  actionLoading.value = true
  try {
    await playersApi.kick(selectedPlayer.value)
    showKickModal.value = false
    await fetchPlayers()
  } catch (err) {
    error.value = t('errors.serverError')
  } finally {
    actionLoading.value = false
  }
}

async function confirmBan() {
  if (!selectedPlayer.value) return
  actionLoading.value = true
  try {
    await playersApi.ban(selectedPlayer.value)
    showBanModal.value = false
    await fetchPlayers()
  } catch (err) {
    error.value = t('errors.serverError')
  } finally {
    actionLoading.value = false
  }
}

onMounted(() => {
  fetchPlayers()
  // Poll every 10 seconds
  pollInterval = setInterval(fetchPlayers, 10000)
})

onUnmounted(() => {
  if (pollInterval) {
    clearInterval(pollInterval)
  }
})
</script>

<template>
  <div class="space-y-6">
    <!-- Page Header -->
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-bold text-white">{{ t('players.title') }}</h1>
        <p class="text-gray-400 mt-1">
          {{ t('players.playerCount', { count: players.length }) }}
        </p>
      </div>
      <Button variant="secondary" @click="fetchPlayers" :class="{ 'animate-spin': loading }">
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </Button>
    </div>

    <!-- Error Message -->
    <div v-if="error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error">{{ error }}</p>
    </div>

    <!-- Online Players -->
    <Card :title="t('players.online')" :padding="false">
      <PlayerList
        :players="players"
        :loading="loading"
        @kick="handleKick"
        @ban="handleBan"
        @whitelist="handleWhitelist"
        @op="handleOp"
        @message="handleMessage"
      />
    </Card>

    <!-- Kick Modal -->
    <Modal
      :open="showKickModal"
      :title="t('players.kick')"
      @close="showKickModal = false"
    >
      <p class="text-gray-300">
        {{ t('players.confirmKick') }}
        <span class="font-semibold text-white">{{ selectedPlayer }}</span>
      </p>
      <template #footer>
        <Button variant="secondary" @click="showKickModal = false">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="danger" :loading="actionLoading" @click="confirmKick">
          {{ t('players.kick') }}
        </Button>
      </template>
    </Modal>

    <!-- Ban Modal -->
    <Modal
      :open="showBanModal"
      :title="t('players.ban')"
      @close="showBanModal = false"
    >
      <p class="text-gray-300">
        {{ t('players.confirmBan') }}
        <span class="font-semibold text-white">{{ selectedPlayer }}</span>
      </p>
      <template #footer>
        <Button variant="secondary" @click="showBanModal = false">
          {{ t('common.cancel') }}
        </Button>
        <Button variant="danger" :loading="actionLoading" @click="confirmBan">
          {{ t('players.ban') }}
        </Button>
      </template>
    </Modal>
  </div>
</template>
