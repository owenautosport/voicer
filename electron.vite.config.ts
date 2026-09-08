import { defineConfig } from 'electron-vite'

/*
 * Kokoro is loaded from node_modules at runtime rather than bundled.
 *
 * onnxruntime-node is a native addon — a `.node` binary rollup cannot inline —
 * and @huggingface/transformers picks between a native and a WebAssembly build
 * through an export condition that only survives if Node resolves it. Bundling
 * either one gets the WebAssembly runtime at best, and a build error at worst.
 */
const KOKORO = ['kokoro-js', '@huggingface/transformers', 'onnxruntime-node']

export default defineConfig({
  main: {
    build: { rollupOptions: { input: 'src/main/index.ts', external: KOKORO } },
  },
  preload: { build: { rollupOptions: { input: 'src/preload/index.ts' } } },
  renderer: {
    root: 'src/renderer',
    build: { rollupOptions: { input: 'src/renderer/index.html' } },
  },
})
