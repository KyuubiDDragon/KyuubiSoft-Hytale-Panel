<script setup lang="ts">
/**
 * Where an access page's data comes from (live from the running server or
 * from its files), what in those files the server cannot read, and access
 * files from before Hytale 0.7 that still have to be converted.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  accessMigrationApi,
  type AccessMigrationStatus,
  type AccessViewBase,
} from '@/api/management'
import { useToast } from '@/composables/useToast'
import Badge from '@/components/ui/Badge.vue'
import Button from '@/components/ui/Button.vue'
import { accessErrorText } from './accessText'

const props = defineProps<{
  view: AccessViewBase | null
  /** May read and run the migration (players.permissions and players.whitelist). */
  canMigrate?: boolean
}>()

const emit = defineEmits<{
  /** The migration changed files; the page should load again. */
  migrated: []
}>()

const { t } = useI18n()
const toast = useToast()

const migration = ref<AccessMigrationStatus | null>(null)
const migrating = ref(false)

const sourceText = computed(() => {
  if (!props.view) return ''
  if (props.view.source === 'live') return t('access.sourceLive')
  if (props.view.serverRunning === true) return t('access.sourceFileRunning')
  if (props.view.serverRunning === null) return t('access.serverUnknown')
  return t('access.sourceFile')
})

const fatalProblems = computed(() => props.view?.problems.filter((p) => p.fatal) ?? [])
const minorProblems = computed(() => props.view?.problems.filter((p) => !p.fatal) ?? [])

const report = computed(() => migration.value?.lastReport ?? null)
const showMigration = computed(
  () =>
    !!migration.value &&
    (migration.value.needed ||
      (report.value?.pending.length ?? 0) > 0 ||
      (report.value?.errors.length ?? 0) > 0 ||
      (report.value?.unresolved.length ?? 0) > 0),
)

async function loadMigration() {
  if (!props.canMigrate) return
  try {
    migration.value = await accessMigrationApi.get()
  } catch {
    // The notice is optional; the page itself still works.
    migration.value = null
  }
}

async function runMigration() {
  migrating.value = true
  try {
    const result = await accessMigrationApi.run()
    const changes = result.report?.changes.length ?? 0
    if (result.success) toast.success(t('access.migrationDone', { count: changes }))
    else toast.warning(result.report?.errors.join(' ') || t('errors.serverError'))
    await loadMigration()
    if (changes > 0) emit('migrated')
  } catch (err) {
    toast.error(accessErrorText(err, t))
  } finally {
    migrating.value = false
  }
}

defineExpose({ reload: loadMigration })

onMounted(loadMigration)
</script>

<template>
  <div v-if="view" class="space-y-3">
    <div class="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
      <Badge :variant="view.source === 'live' ? 'success' : 'info'">
        {{ view.source === 'live' ? t('access.live') : t('access.file') }}
      </Badge>
      <span>{{ sourceText }}</span>
    </div>

    <div
      v-if="fatalProblems.length > 0"
      class="p-4 bg-status-error/10 border border-status-error/20 rounded-lg text-sm"
      role="alert"
    >
      <p class="text-status-error font-medium">{{ t('access.problemsFatal') }}</p>
      <ul class="mt-2 space-y-1 font-mono text-xs text-ink-muted">
        <li v-for="p in fatalProblems.slice(0, 10)" :key="p.where + p.detail">
          {{ p.where }}: {{ p.detail }}
        </li>
      </ul>
    </div>

    <details v-if="minorProblems.length > 0" class="text-sm text-ink-muted">
      <summary class="cursor-pointer">{{ t('access.problemsMinor', { count: minorProblems.length }) }}</summary>
      <ul class="mt-2 space-y-1 font-mono text-xs">
        <li v-for="p in minorProblems.slice(0, 20)" :key="p.where + p.detail">
          {{ p.where }}: {{ p.detail }}
        </li>
      </ul>
    </details>

    <div
      v-if="showMigration && migration"
      class="p-4 bg-status-warning/10 border border-status-warning/20 rounded-lg text-sm space-y-2"
    >
      <template v-if="migration.needed">
        <p class="text-ink font-medium">{{ t('access.migrationNeeded') }}</p>
        <ul class="list-disc ms-5 text-ink-muted">
          <li v-for="item in migration.items" :key="item">{{ item }}</li>
        </ul>
        <p class="text-ink-muted">{{ t('access.migrationHint') }}</p>
      </template>
      <template v-if="report && report.pending.length > 0">
        <p class="text-ink font-medium">{{ t('access.migrationPending') }}</p>
        <ul class="list-disc ms-5 text-ink-muted">
          <li v-for="item in report.pending" :key="item">{{ item }}</li>
        </ul>
      </template>
      <template v-if="report && report.unresolved.length > 0">
        <p class="text-ink-muted">
          {{ t('access.migrationUnresolved', { names: report.unresolved.join(', ') }) }}
        </p>
      </template>
      <template v-if="report && report.errors.length > 0">
        <p class="text-status-error font-medium">{{ t('access.migrationErrors') }}</p>
        <ul class="list-disc ms-5 text-ink-muted">
          <li v-for="item in report.errors" :key="item">{{ item }}</li>
        </ul>
      </template>
      <Button v-if="migration.needed" size="sm" :disabled="migrating" @click="runMigration">
        {{ t('access.migrationRun') }}
      </Button>
    </div>
  </div>
</template>
