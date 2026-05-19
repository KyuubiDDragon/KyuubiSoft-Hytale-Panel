<script setup lang="ts">
import { computed } from 'vue'
import type { FileEntry } from '@/api/files'

export interface TreeNode extends FileEntry {
  expanded: boolean
  loaded: boolean
  loading: boolean
  children: TreeNode[]
}

const props = defineProps<{
  node: TreeNode
  selected: string
  depth: number
  iconFor: (n: TreeNode) => string
}>()

const emit = defineEmits<{
  (e: 'toggle', node: TreeNode): void
  (e: 'select', node: TreeNode): void
}>()

const indentPx = computed(() => `${props.depth * 12 + 4}px`)
const isSelected = computed(() => props.selected === props.node.path)

function onClick() {
  if (props.node.type === 'directory') emit('toggle', props.node)
  else emit('select', props.node)
}

function glyph(icon: string): string {
  switch (icon) {
    case 'folder':
      return '📁'
    case 'folder-open':
      return '📂'
    case 'json':
      return '⚙'
    case 'image':
      return '🖼'
    case 'code':
      return '⌨'
    default:
      return '📄'
  }
}
</script>

<template>
  <li>
    <div
      class="flex items-center gap-1 px-2 py-1 rounded cursor-pointer hover:bg-dark-50/40"
      :class="isSelected ? 'bg-hytale-orange/20 text-hytale-orange' : 'text-gray-300'"
      :style="{ paddingLeft: indentPx }"
      @click="onClick"
    >
      <span class="w-3 inline-block text-xs text-gray-500">
        {{ node.type === 'directory' ? (node.expanded ? '▾' : '▸') : '' }}
      </span>
      <span class="w-4 text-center text-xs">{{ glyph(iconFor(node)) }}</span>
      <span class="truncate text-sm">{{ node.name }}</span>
      <span v-if="node.loading" class="text-xs text-gray-500">…</span>
    </div>
    <ul v-if="node.expanded && node.children.length > 0">
      <TreeItem
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :selected="selected"
        :depth="depth + 1"
        :icon-for="iconFor"
        @toggle="(n) => emit('toggle', n)"
        @select="(n) => emit('select', n)"
      />
    </ul>
  </li>
</template>
