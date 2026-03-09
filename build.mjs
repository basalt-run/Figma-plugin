import esbuild from 'esbuild'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// 1. Build the React UI with Vite
console.log('Building UI...')
execSync('npx vite build', { stdio: 'inherit', cwd: __dirname })

// 2. Read the built HTML
const htmlPath = resolve(__dirname, 'dist/ui.html')
const html = readFileSync(htmlPath, 'utf-8')

// 3. Bundle plugin.ts with __html__ injected
console.log('Building plugin...')
await esbuild.build({
  entryPoints: ['src/plugin.ts'],
  bundle: true,
  outfile: 'dist/plugin.js',
  platform: 'browser',
  target: 'es2017',
  define: {
    __html__: JSON.stringify(html),
  },
})

console.log('Done. dist/plugin.js and dist/ui.html are ready.')
