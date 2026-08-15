/**
 * Build the browser-half client bundle (`dist/client.js`).
 *
 * Mirrors DSH's `tsdown.client` output contract so the published web app's
 * client-modules machinery can load this plugin's UI:
 *
 *   window.__ModuleLoader__.load({
 *     id: "<package-name>",
 *     factory: (require) => { <bundled cjs>; return module.exports; },
 *   })
 *
 * Externals are the platform modules the web shell shares into its module
 * table (react and the @deepseek-ai/ui-* seed packages). Everything else must
 * be inlined or type-only: cross-plugin value imports are not resolvable by
 * the loader's table and would throw at runtime. This bundle only value-imports
 * `react`, so the practical external set is just the two react specifiers plus
 * the platform list as a guard against future accidental value imports.
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PACKAGE_NAME = 'dsh-plugin-commandcode-provider'

/** Platform modules shared into the web shell's frozen module table. */
const PLATFORM_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  outfile: join(root, 'dist/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: PLATFORM_EXTERNALS,
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  // tsdown emits these around the CJS body; the loader feeds `require`.
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, factory: (require) => {\n`
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
})

console.log('built dist/client.js')
