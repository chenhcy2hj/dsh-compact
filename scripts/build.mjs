import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'

const srcDir = new URL('../src/', import.meta.url)
const outDir = new URL('../lib/', import.meta.url)

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

const entries = await readdir(srcDir, { withFileTypes: true })
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) {
    continue
  }

  const source = await readFile(new URL(entry.name, srcDir), 'utf8')
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' })
  // Rewrite relative `.ts` import/export specifiers to `.js` for emitted ESM output.
  const rewritten = stripped.replace(/(from\s+['"]\.\/[^'"]+)\.ts(['"])/g, '$1.js$2')
  const outName = entry.name.replace(/\.ts$/, '.js')
  await writeFile(join(outDir.pathname, outName), rewritten, 'utf8')
}
