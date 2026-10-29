/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/ban-types -- standard Vue SFC shim
  const component: DefineComponent<{}, {}, any>
  export default component
}

// The deep monaco entry is imported for tree-shaking but ships no own types;
// map it to the package's main type surface.
declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor'
}
