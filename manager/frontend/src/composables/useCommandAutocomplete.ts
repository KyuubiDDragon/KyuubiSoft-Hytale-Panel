import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import { consoleApi, type CommandNode } from '@/api/console'

/**
 * Console autocomplete. With the KyuubiSoft API plugin it uses the server's
 * real command list (vanilla and mod commands, subcommands, syntax) plus the
 * server's own completion for argument values such as player names. Without
 * the plugin the panel sends the vanilla Hytale 0.7 commands instead; a short
 * built-in list is left for when the panel does not answer at all.
 */

export interface CommandSuggestion {
  /** Full input line after choosing this suggestion. */
  value: string
  /** What the list shows, e.g. "/world add". */
  label: string
  /** Syntax shown next to the label, e.g. "<name>". */
  hint?: string
  description?: string
  /** Real server command the panel's whitelist does not allow. */
  blocked?: boolean
  /** Needs the console.execute.admin permission in the panel. */
  admin?: boolean
}

const MAX_SUGGESTIONS = 10
const COMPLETION_DEBOUNCE_MS = 250
// The backend caches the list; re-asking now and then picks up a server
// that was offline before, or plugins loaded since.
const RELOAD_INTERVAL_MS = 60_000

// Used only when the panel cannot answer with a command list at all (it
// normally sends the server's list, or the vanilla Hytale 0.7 list without
// one): common Hytale 0.7 commands.
const FALLBACK_COMMANDS = [
  '/help',
  '/who',
  '/say',
  '/notify',
  '/world save --all --confirm',
  '/world list',
  '/server stats memory',
  '/time set',
  '/weather set',
  '/kick',
  '/ban',
  '/unban',
  '/op add',
  '/op remove',
  '/whitelist add',
  '/whitelist remove',
  '/whitelist list',
  '/gamemode',
  '/give',
  '/kill',
  '/update status',
  '/auth status',
  '/stop',
]

function matchesName(node: CommandNode, token: string): boolean {
  const t = token.toLowerCase()
  return node.name.toLowerCase() === t || (node.aliases ?? []).some((a) => a.toLowerCase() === t)
}

/** Like the server: a command's name wins over another command's alias. */
function findByName(nodes: CommandNode[] | undefined, token: string): CommandNode | undefined {
  const t = token.toLowerCase()
  return nodes?.find((c) => c.name.toLowerCase() === t) ?? nodes?.find((c) => matchesName(c, token))
}

function startsWithName(node: CommandNode, prefix: string): boolean {
  const p = prefix.toLowerCase()
  return (
    node.name.toLowerCase().startsWith(p) ||
    (node.aliases ?? []).some((a) => a.toLowerCase().startsWith(p))
  )
}

function argHint(node: CommandNode): string | undefined {
  if (node.subcommands?.length) return '…'
  const args = node.requiredArgs?.map((a) => `<${a.name}>`).join(' ')
  return args || undefined
}

/** Words after the "/"; a trailing space starts a new, empty word. */
function splitLine(line: string): string[] {
  const words = line.slice(1).trimStart().split(/\s+/)
  return words.length === 0 ? [''] : words
}

interface Resolved {
  root?: CommandNode
  /** Deepest command the finished words name. */
  node?: CommandNode
  /** Words up to and including `node`, as typed. */
  path: string[]
  partial: string
}

function resolve(commands: CommandNode[], words: string[]): Resolved {
  const partial = words[words.length - 1] ?? ''
  const finished = words.slice(0, -1)
  if (finished.length === 0) return { path: [], partial }
  const root = findByName(commands, finished[0])
  if (!root) return { path: [], partial }
  let node = root
  const path = [finished[0]]
  for (const word of finished.slice(1)) {
    const sub = findByName(node.subcommands, word)
    if (!sub) break
    node = sub
    path.push(word)
  }
  return { root, node, path, partial }
}

export function useCommandAutocomplete(input: Ref<string>) {
  const commands = ref<CommandNode[] | null>(null)
  const serverSuggestions = ref<string[]>([])
  let completionTimer: ReturnType<typeof setTimeout> | null = null
  let completionSeq = 0
  let loadedAt = 0

  async function loadCommands(): Promise<void> {
    loadedAt = Date.now()
    try {
      const registry = await consoleApi.getCommands()
      commands.value = registry.available ? registry.commands : null
    } catch {
      commands.value = null
    }
  }

  const resolved = computed<Resolved | null>(() => {
    if (!commands.value || !input.value.startsWith('/')) return null
    return resolve(commands.value, splitLine(input.value))
  })

  /** The command being typed, for the syntax line under the input. */
  const activeCommand = computed<CommandNode | null>(() => resolved.value?.node ?? null)

  const suggestions = computed<CommandSuggestion[]>(() => {
    const line = input.value
    if (!line.startsWith('/')) return []

    if (!commands.value) {
      const typed = line.toLowerCase()
      return FALLBACK_COMMANDS.filter((cmd) => cmd.startsWith(typed))
        .slice(0, MAX_SUGGESTIONS)
        .map((cmd) => ({ value: cmd, label: cmd }))
    }

    const state = resolved.value
    if (!state) return []

    // First word: root commands, allowed ones first.
    if (!state.node) {
      if (state.path.length === 0 && splitLine(line).length > 1) return []
      return commands.value
        .filter((c) => startsWithName(c, state.partial))
        .sort(
          (a, b) =>
            Number(!!b.panel?.allowed) - Number(!!a.panel?.allowed) || a.name.localeCompare(b.name),
        )
        .slice(0, MAX_SUGGESTIONS)
        .map((c) => ({
          value: `/${c.name} `,
          label: `/${c.name}`,
          hint: argHint(c),
          description: c.description,
          blocked: c.panel ? !c.panel.allowed : false,
          admin: c.panel?.permission === 'console.execute.admin',
        }))
    }

    const prefix = `/${state.path.join(' ')} `
    // Subcommands only directly after the command path, not after arguments.
    const atCommandEnd = state.path.length === splitLine(line).length - 1
    // Each subcommand carries its own tier (e.g. /world save vs /world remove).
    const subs = (atCommandEnd ? (state.node.subcommands ?? []) : [])
      .filter((c) => startsWithName(c, state.partial))
      .map((c) => ({
        value: `${prefix}${c.name} `,
        label: `${prefix}${c.name}`,
        hint: argHint(c),
        description: c.description,
        blocked: c.panel ? !c.panel.allowed : false,
        admin: c.panel?.permission === 'console.execute.admin',
      }))
    // Argument values from the server (player names, items, --options, …).
    const head = line.slice(0, line.length - state.partial.length)
    const values = serverSuggestions.value
      .filter((s) => !subs.some((sub) => sub.label.endsWith(` ${s}`)))
      .map((s) => ({ value: `${head}${s} `, label: s }))
    return [...subs, ...values].slice(0, MAX_SUGGESTIONS)
  })

  /** Load the list again if the last load is older than RELOAD_INTERVAL_MS. */
  function refreshCommands(): void {
    if (Date.now() - loadedAt >= RELOAD_INTERVAL_MS) void loadCommands()
  }

  // Ask the server for argument values once the user is past the command name.
  watch(input, (line) => {
    if (completionTimer) clearTimeout(completionTimer)
    serverSuggestions.value = []
    // Invalidate answers to earlier lines even when this line needs none.
    const seq = ++completionSeq
    const state = resolved.value
    if (!state?.node || !line.startsWith('/')) return
    completionTimer = setTimeout(async () => {
      try {
        const result = await consoleApi.complete(line)
        if (seq === completionSeq && result.available) serverSuggestions.value = result.suggestions
      } catch {
        // completion is a convenience; the input keeps working without it
      }
    }, COMPLETION_DEBOUNCE_MS)
  })

  onUnmounted(() => {
    if (completionTimer) clearTimeout(completionTimer)
  })

  return { commands, suggestions, activeCommand, loadCommands, refreshCommands }
}
