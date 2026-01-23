<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSetupStore } from '@/stores/setup'
import { setLocale } from '@/i18n'
import Button from '@/components/ui/Button.vue'

const { t } = useI18n()
const setupStore = useSetupStore()

const emit = defineEmits<{
  complete: []
  back: []
}>()

// Available languages with their display names and flags
const languages = [
  {
    code: 'de' as const,
    name: 'Deutsch',
    nativeName: 'Deutsch',
    flag: 'DE',
  },
  {
    code: 'en' as const,
    name: 'English',
    nativeName: 'English',
    flag: 'GB',
  },
  {
    code: 'pt_br' as const,
    name: 'Portuguese (Brazil)',
    nativeName: 'Portugues (Brasil)',
    flag: 'BR',
  },
]

// Selected language (default to stored value or 'de')
const selectedLanguage = ref<'de' | 'en' | 'pt_br'>(
  setupStore.setupData.language?.language || 'de'
)

const isSelected = (code: string) => selectedLanguage.value === code

function selectLanguage(code: 'de' | 'en' | 'pt_br') {
  selectedLanguage.value = code
  // Apply language change immediately for preview
  setLocale(code)
}

async function handleContinue() {
  const success = await setupStore.saveLanguage({ language: selectedLanguage.value })
  if (success) {
    emit('complete')
  }
}

function handleBack() {
  emit('back')
}
</script>

<template>
  <div class="space-y-6">
    <!-- Header -->
    <div class="text-center">
      <div class="inline-flex items-center justify-center w-16 h-16 bg-hytale-orange/20 rounded-2xl mb-4">
        <svg class="w-8 h-8 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
        </svg>
      </div>
      <h2 class="text-2xl font-bold text-white mb-2">{{ t('setup.welcomeTitle') }}</h2>
      <p class="text-gray-400">{{ t('setup.selectLanguage') }}</p>
    </div>

    <!-- Language Cards -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <button
        v-for="lang in languages"
        :key="lang.code"
        @click="selectLanguage(lang.code)"
        class="relative p-6 rounded-xl border-2 transition-all duration-200 text-left group"
        :class="[
          isSelected(lang.code)
            ? 'border-hytale-orange bg-hytale-orange/10'
            : 'border-dark-50 bg-dark-200 hover:border-gray-600 hover:bg-dark-100'
        ]"
      >
        <!-- Selected Indicator -->
        <div
          v-if="isSelected(lang.code)"
          class="absolute top-3 right-3"
        >
          <svg class="w-6 h-6 text-hytale-orange" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>

        <!-- Flag -->
        <div class="text-4xl mb-3">
          <span v-if="lang.flag === 'DE'">
            <svg class="w-10 h-10" viewBox="0 0 512 512">
              <rect fill="#FFCE00" y="341.3" width="512" height="170.7"/>
              <rect fill="#DD0000" y="170.7" width="512" height="170.6"/>
              <rect fill="#000" width="512" height="170.7"/>
            </svg>
          </span>
          <span v-else-if="lang.flag === 'GB'">
            <svg class="w-10 h-10" viewBox="0 0 512 512">
              <rect fill="#012169" width="512" height="512"/>
              <path fill="#FFF" d="M512 0v64L322 256l190 187v69h-67L254 324 68 512H0v-68l186-187L0 74V0h62l192 188L440 0z"/>
              <path fill="#C8102E" d="M184 324l11 34L42 512H0v-3l184-185zm124-12l54 8 150 147v45L308 312zM512 0L320 196l-4-44L466 0h46zM0 1l193 189-59-8L0 49V1z"/>
              <path fill="#FFF" d="M176 0v512h160V0H176zM0 176v160h512V176H0z"/>
              <path fill="#C8102E" d="M0 208v96h512v-96H0zM208 0v512h96V0h-96z"/>
            </svg>
          </span>
          <span v-else-if="lang.flag === 'BR'">
            <svg class="w-10 h-10" viewBox="0 0 512 512">
              <rect fill="#009C3B" width="512" height="512"/>
              <polygon fill="#FFDF00" points="256,52.9 491.5,256 256,459.1 20.5,256"/>
              <circle fill="#002776" cx="256" cy="256" r="90"/>
              <path fill="#FFF" d="M166,256c0-32.9,17.6-61.7,44-77.4c-7.5-2.5-15.5-3.9-23.9-3.9c-44.2,0-80,35.8-80,80s35.8,80,80,80c8.4,0,16.4-1.4,23.9-3.9C183.6,317.7,166,288.9,166,256z"/>
            </svg>
          </span>
        </div>

        <!-- Language Name -->
        <p class="text-lg font-semibold text-white mb-1">{{ lang.nativeName }}</p>
        <p class="text-sm text-gray-400">{{ lang.name }}</p>
      </button>
    </div>

    <!-- Info Text -->
    <div class="p-4 bg-dark-300 rounded-lg border border-dark-50/50">
      <div class="flex items-start gap-3">
        <svg class="w-5 h-5 text-gray-400 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p class="text-sm text-gray-400">{{ t('setup.languageInfo') }}</p>
      </div>
    </div>

    <!-- Error Message -->
    <div v-if="setupStore.error" class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg">
      <p class="text-status-error text-sm">{{ setupStore.error }}</p>
    </div>

    <!-- Actions -->
    <div class="flex items-center justify-between pt-4">
      <Button variant="secondary" @click="handleBack">
        <svg class="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        {{ t('common.back') }}
      </Button>

      <Button :loading="setupStore.isLoading" @click="handleContinue">
        {{ t('common.next') }}
        <svg class="w-4 h-4 ml-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
        </svg>
      </Button>
    </div>
  </div>
</template>
