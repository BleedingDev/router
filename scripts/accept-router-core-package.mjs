import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

assert.equal(
  process.argv.length,
  3,
  'Expected exactly one normal package archive',
)
const archive = path.resolve(process.argv[2] ?? '')
assert.match(archive, /tanstack-router-core-[0-9][A-Za-z0-9.+-]*\.tgz$/)
const packed = JSON.parse(
  execFileSync('tar', ['-xOf', archive, 'package/package.json']),
)
assert.equal(packed.name, '@tanstack/router-core')
const root = fileURLToPath(new URL('../', import.meta.url))
const compiler = path.join(root, 'node_modules/typescript/lib/tsc.js')
const directory = mkdtempSync(
  path.join(
    process.env.OWNED_TEMP_DIR ?? process.env.RUNNER_TEMP ?? tmpdir(),
    'router-core-consumer-',
  ),
)
const cleanup = () => rmSync(directory, { recursive: true, force: true })
const onInterrupt = () => {
  cleanup()
  process.exit(130)
}
const onTerminate = () => {
  cleanup()
  process.exit(143)
}
process.once('SIGINT', onInterrupt)
process.once('SIGTERM', onTerminate)
const policy = [
  'minimumReleaseAge: 1440',
  'minimumReleaseAgeStrict: true',
  'minimumReleaseAgeExclude: []',
  'packageImportMethod: clone-or-copy',
  'trustPolicy: no-downgrade',
  '',
].join('\n')
const run = (executable, args, options = {}) =>
  execFileSync(executable, args, {
    cwd: directory,
    stdio: 'inherit',
    ...options,
  })

try {
  writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies: { '@tanstack/router-core': `file:${archive}` },
    }),
  )
  writeFileSync(path.join(directory, 'pnpm-workspace.yaml'), policy)
  run('pnpm', ['install', '--ignore-workspace', '--no-frozen-lockfile'])
  assert.equal(
    readFileSync(path.join(directory, 'pnpm-workspace.yaml'), 'utf8'),
    policy,
    'Consumer install must not add release-age exemptions',
  )
  const imports = [
    '@tanstack/router-core',
    '@tanstack/router-core/ssr/server',
    '@tanstack/router-core/ssr/client',
  ]
  for (const specifier of imports) {
    run(process.execPath, [
      '--input-type=module',
      '--eval',
      `import * as api from ${JSON.stringify(specifier)}; if (!Object.keys(api).length) throw new Error('Empty ESM export');`,
    ])
    run(process.execPath, [
      '--input-type=commonjs',
      '--eval',
      `const api = require(${JSON.stringify(specifier)}); if (!Object.keys(api).length) throw new Error('Empty CJS export');`,
    ])
  }
  for (const [condition, expected] of [
    ['node', true],
    ['workerd', true],
    ['browser', false],
    ['development', undefined],
  ]) {
    run(
      process.execPath,
      [
        `--conditions=${condition}`,
        '--input-type=module',
        '--eval',
        `import { isServer } from '@tanstack/router-core/isServer'; if (isServer !== ${String(expected)}) throw new Error('Incorrect ${condition} export');`,
      ],
      { env: { ...process.env, NODE_ENV: 'production' } },
    )
  }
  const source = `${imports.map((specifier, index) => `import * as api${index} from ${JSON.stringify(specifier)}; void api${index};`).join('\n')}\n`
  writeFileSync(path.join(directory, 'consumer.mts'), source)
  writeFileSync(path.join(directory, 'consumer.cts'), source)
  writeFileSync(
    path.join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: [],
        strict: true,
        skipLibCheck: false,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noEmit: true,
      },
      files: ['consumer.mts', 'consumer.cts'],
    }),
  )
  run(process.execPath, [compiler, '--project', 'tsconfig.json'])
  console.log(
    `Accepted installed ESM/CJS declarations and exports: ${packed.name}@${packed.version}`,
  )
} finally {
  cleanup()
  process.off('SIGINT', onInterrupt)
  process.off('SIGTERM', onTerminate)
}
