import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareRegistryPayload,
  registryPayload,
  validateStartPeers,
  validateNormalStartManifest,
  verifyInstalledPackage,
  assertSourceIdentity,
  validateRegistryDependencies,
} from './qualify-start-package.mjs'
const core = {
  name: '@tanstack/router-core',
  version: '1.171.38',
  url: 'https://github.com/BleedingDev/router/releases/download/ultramodern-router-core-0a4eed5ea37d/tanstack-router-core-1.171.38.tgz',
  dependencies: { '@tanstack/history': '1.162.5' },
  parents: [],
}
const storage = {
  name: '@tanstack/start-storage-context',
  version: '1.167.40',
  url: 'https://github.com/BleedingDev/router/releases/download/ultramodern-start-storage-123456789abc/tanstack-start-storage-context-1.167.40.tgz',
  dependencies: {},
  peerDependencies: { '@tanstack/router-core': core.version },
  parents: [core],
}
const client = {
  name: '@tanstack/start-client-core',
  version: '1.170.38',
  url: 'https://github.com/BleedingDev/router/releases/download/ultramodern-start-client-123456789abc/tanstack-start-client-core-1.170.38.tgz',
  dependencies: {},
  peerDependencies: {
    '@tanstack/router-core': core.version,
    '@tanstack/start-storage-context': storage.version,
  },
  parents: [core, storage],
}

const packagesDirectory = fileURLToPath(
  new URL('../packages/', import.meta.url),
)
const manifests = new Map(
  readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifest = JSON.parse(
        readFileSync(
          path.join(packagesDirectory, entry.name, 'package.json'),
          'utf8',
        ),
      )
      return [manifest.name, manifest]
    }),
)
const sharedStartPackages = [
  '@tanstack/start-storage-context',
  '@tanstack/start-client-core',
  '@tanstack/start-server-core',
]
for (const consumer of manifests.values()) {
  if (sharedStartPackages.includes(consumer.name)) {
    continue
  }
  const parents = sharedStartPackages.filter(
    (name) => consumer.dependencies?.[name],
  )
  if (!parents.length) {
    continue
  }
  test(`${consumer.name} provides shared Start peers without installer auto-provisioning`, () => {
    for (const name of parents) {
      const parent = manifests.get(name)
      for (const [peer, request] of Object.entries(parent.peerDependencies)) {
        assert.equal(
          consumer.dependencies[peer],
          request,
          `${consumer.name} must provide ${peer} beside its ${name} dependency`,
        )
      }
    }
  })
}

test('shared peer validation preserves the packed manifest and binds exact accepted parents', () => {
  const source = {
    name: '@tanstack/start-server-core',
    version: '1.169.44',
    dependencies: {
      '@tanstack/history': '1.162.5',
      seroval: '^1.6.7',
    },
    peerDependencies: {
      '@tanstack/router-core': core.version,
      '@tanstack/start-storage-context': storage.version,
      '@tanstack/start-client-core': client.version,
    },
  }
  const before = structuredClone(source)
  validateStartPeers(source, [core, storage, client])
  assert.deepEqual(source, before)
  validateStartPeers(storage, [core])
  validateStartPeers(client, [core, storage])
})
test('a bare sibling version cannot replace an absent accepted predecessor', () => {
  assert.throws(() => validateStartPeers(client, [core]))
})
test('accepted parents must converge on the same exact required native core peer', () => {
  assert.throws(() =>
    validateStartPeers(client, [
      core,
      {
        ...storage,
        peerDependencies: {
          '@tanstack/router-core': '1.171.37',
        },
      },
    ]),
  )
  assert.throws(
    () =>
      validateStartPeers(client, [
        core,
        {
          ...storage,
          parents: [{ ...core, url: 'https://example.invalid/other-core.tgz' }],
        },
      ]),
    /authenticated parent lineage/,
  )
})
test('producer-local or exotic requests cannot escape as transitive dependencies', () => {
  for (const request of [
    'workspace:*',
    'catalog:',
    'file:../dependency',
    'link:../dependency',
    core.url,
    'git+https://example.invalid/owner/repository.git',
    'npm:seroval@1.6.7',
    'owner/repository',
    '../dependency',
    '/tmp/dependency',
    'C:\\dependency',
    'git@github.com:owner/repository.git',
    '',
  ]) {
    assert.throws(() =>
      validateStartPeers({ ...storage, dependencies: { unrelated: request } }, [
        core,
      ]),
    )
  }
})

test('normal pack contracts derive dependencies and peers independently from source', () => {
  const source = {
    name: storage.name,
    version: storage.version,
    dependencies: { '@tanstack/history': 'workspace:*', seroval: '^1.6.7' },
    optionalDependencies: { cookie: '~1.0.0' },
    peerDependencies: { '@tanstack/router-core': 'workspace:*' },
    peerDependenciesMeta: { '@tanstack/router-core': { optional: false } },
  }
  const packed = {
    ...source,
    dependencies: { '@tanstack/history': '1.162.5', seroval: '^1.6.7' },
    peerDependencies: { '@tanstack/router-core': core.version },
  }
  const versions = {
    '@tanstack/history': '1.162.5',
    '@tanstack/router-core': core.version,
  }
  const before = structuredClone({ source, packed })
  assert.deepEqual(validateNormalStartManifest(source, packed, versions), {
    dependencies: packed.dependencies,
    optionalDependencies: packed.optionalDependencies,
    peerDependencies: packed.peerDependencies,
  })
  assert.deepEqual({ source, packed }, before)
  for (const changed of [
    { dependencies: { ...packed.dependencies, seroval: '^1.6.9' } },
    { dependencies: { ...packed.dependencies, unexpected: '1.0.0' } },
    { dependencies: { seroval: '^1.6.7' } },
    { optionalDependencies: { cookie: '^2.0.0' } },
    { peerDependencies: { '@tanstack/router-core': '^1.171.38' } },
    { peerDependenciesMeta: { '@tanstack/router-core': { optional: true } } },
  ]) {
    assert.throws(() =>
      validateNormalStartManifest(source, { ...packed, ...changed }, versions),
    )
  }
  assert.throws(() => validateNormalStartManifest(source, packed, {}))
  assert.throws(() =>
    validateNormalStartManifest(
      {
        ...source,
        peerDependencies: { '@tanstack/router-core': 'workspace:^' },
      },
      packed,
      versions,
    ),
  )
})

test('ordinary registry ranges remain unchanged in normal packed dependencies', () => {
  for (const request of ['1.6.7', '^1.6.7', '~1.6.7', '>=1.6.7 <2', '*']) {
    const packed = { ...storage, dependencies: { seroval: request } }
    validateStartPeers(packed, [core])
    validateNormalStartManifest(packed, packed, {})
  }
})

test('shared authority cannot be a ranged, optional or duplicated dependency', () => {
  for (const change of [
    { peerDependencies: {} },
    { peerDependencies: { '@tanstack/router-core': '^1.171.38' } },
    { peerDependencies: { '@tanstack/router-core': '1.171.37' } },
    { peerDependenciesMeta: { '@tanstack/router-core': { optional: true } } },
    { dependencies: { '@tanstack/router-core': core.url } },
    { optionalDependencies: { '@tanstack/router-core': core.version } },
  ]) {
    assert.throws(() => validateStartPeers({ ...storage, ...change }, [core]))
  }
})
test('history and stubs must retain actual registry source versions before qualification', () => {
  const registry = [
    { name: '@tanstack/history', version: '1.162.5' },
    { name: '@tanstack/start-fn-stubs', version: '1.162.0' },
  ]
  validateRegistryDependencies(
    {
      dependencies: {
        '@tanstack/history': '1.162.5',
        '@tanstack/start-fn-stubs': '1.162.0',
      },
    },
    registry,
  )
  for (const entry of registry) {
    assert.throws(
      () =>
        validateRegistryDependencies(
          { dependencies: { [entry.name]: '0.0.0' } },
          registry,
        ),
      /normal pack/,
    )
  }
})
test('source identity compares exact package paths and propagates any source mismatch', () => {
  const calls = []
  const sha = 'a'.repeat(40),
    head = 'b'.repeat(40)
  for (const name of [
    'router-core',
    'history',
    'start-storage-context',
    'start-client-core',
    'start-fn-stubs',
  ]) {
    assertSourceIdentity(sha, head, `@tanstack/${name}`, (command, args) =>
      calls.push([command, args]),
    )
  }
  assert.deepEqual(calls[0], [
    'git',
    ['merge-base', '--is-ancestor', sha, head],
  ])
  assert.deepEqual(calls[1], [
    'git',
    ['diff', '--exit-code', sha, head, '--', 'packages/router-core'],
  ])
  assert.deepEqual(calls[3][1].at(-1), 'packages/history')
  assert.throws(
    () =>
      assertSourceIdentity(sha, head, '@tanstack/router-core', () => {
        throw Error('Re-release changed source first')
      }),
    /re-release/,
  )
  assert.throws(() =>
    assertSourceIdentity(sha, head, '@tanstack/../../escape', () => {}),
  )
})

test('installed archive proof checks every file and byte, including manifests and extra files', () => {
  const temporaryRoot = process.env.RUNNER_TEMP ?? process.env.OWNED_TEMP_DIR
  assert(temporaryRoot)
  const directory = mkdtempSync(
    path.join(temporaryRoot, 'start-installed-bytes-'),
  )
  try {
    const installed = path.join(directory, 'package')
    mkdirSync(installed)
    const manifest = path.join(installed, 'package.json')
    const source = path.join(installed, 'index.js')
    writeFileSync(
      manifest,
      JSON.stringify({ name: storage.name, version: storage.version }),
    )
    writeFileSync(source, 'export const context = true')
    const bytes = execFileSync('tar', ['-czf', '-', '-C', directory, 'package'])
    verifyInstalledPackage(bytes, manifest)
    writeFileSync(source, 'export const context = false')
    assert.throws(() => verifyInstalledPackage(bytes, manifest), /bytes differ/)
    writeFileSync(source, 'export const context = true')
    writeFileSync(path.join(installed, 'unexpected.js'), 'injected')
    assert.throws(
      () => verifyInstalledPackage(bytes, manifest),
      /file set differs/,
    )
    rmSync(path.join(installed, 'unexpected.js'))
    writeFileSync(
      manifest,
      JSON.stringify({ name: storage.name, version: '0.0.0' }),
    )
    assert.throws(() => verifyInstalledPackage(bytes, manifest), /bytes differ/)
    rmSync(source)
    assert.throws(
      () => verifyInstalledPackage(bytes, manifest),
      /file set differs/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('registry payload without gitHead must equal the real normal pack, under the explicit runtime and source-map content policy', () => {
  const temporaryRoot = process.env.RUNNER_TEMP ?? process.env.OWNED_TEMP_DIR
  assert(
    temporaryRoot,
    'Run archive fixtures under operation-owned temporary root',
  )
  const directory = mkdtempSync(path.join(temporaryRoot, 'registry-payload-'))
  const manifest = {
    name: '@tanstack/history',
    version: '1.162.5',
    type: 'module',
    exports: { '.': { import: './index.js', default: './index.js' } },
  }
  const pack = (contents) => {
    const raw = mkdtempSync(path.join(directory, 'raw-'))
    mkdirSync(path.join(raw, 'package'))
    for (const [name, bytes] of Object.entries(contents)) {
      writeFileSync(path.join(raw, 'package', name), bytes)
    }
    return execFileSync('tar', ['-czf', '-', '-C', raw, 'package'])
  }
  const sri = (bytes) =>
    'sha512-' + createHash('sha512').update(bytes).digest('base64')
  try {
    const normal = pack({
      'package.json': JSON.stringify(manifest),
      'index.js': 'export const history = true',
      'index.d.ts': 'export declare const history: boolean',
    })
    const registry = pack({
      'index.d.ts': 'export declare const history: boolean',
      'index.js': 'export const history = true',
      'package.json': JSON.stringify(
        {
          exports: manifest.exports,
          type: manifest.type,
          version: manifest.version,
          name: manifest.name,
        },
        null,
        4,
      ),
    })
    // These real registry metadata shapes intentionally have no gitHead.
    const metadata = {
      name: manifest.name,
      version: manifest.version,
      dist: {
        integrity: sri(registry),
        tarball:
          'https://registry.npmjs.org/@tanstack/history/-/history-1.162.5.tgz',
        attestations: {
          url: 'https://registry.npmjs.org/-/npm/v1/attestations/@tanstack%2fhistory@1.162.5',
        },
      },
    }
    const evidence = compareRegistryPayload(
      metadata,
      normal,
      registry,
      'a'.repeat(40),
    )
    assert.equal(evidence.type, 'normal-workspace-pack-content-v1')
    assert.equal(evidence.workspaceSourceSha, 'a'.repeat(40))
    assert.equal(evidence.fileCount, 3)
    assert.equal(
      evidence.payloadPolicy,
      'runtime-manifest-fields-and-map-content-v1',
    )
    assert.deepEqual(
      registryPayload(registry, manifest.name, manifest.version),
      { fileCount: evidence.fileCount, payloadSha256: evidence.payloadSha256 },
    )
    const stubsManifest = {
      name: '@tanstack/start-fn-stubs',
      version: '1.162.0',
      type: 'module',
      exports: { '.': './index.js' },
    }
    const stubs = pack({
      'package.json': JSON.stringify(stubsManifest),
      'index.js': 'export const stub = true',
    })
    const stubsMetadata = {
      name: stubsManifest.name,
      version: stubsManifest.version,
      dist: {
        integrity: sri(stubs),
        tarball:
          'https://registry.npmjs.org/@tanstack/start-fn-stubs/-/start-fn-stubs-1.162.0.tgz',
        attestations: {
          url: 'https://registry.npmjs.org/-/npm/v1/attestations/@tanstack%2fstart-fn-stubs@1.162.0',
        },
      },
    }
    assert.equal(
      compareRegistryPayload(stubsMetadata, stubs, stubs, 'a'.repeat(40))
        .fileCount,
      2,
    )
    for (const contents of [
      {
        'package.json': JSON.stringify(manifest),
        'index.js': 'export const history = false',
        'index.d.ts': 'export declare const history: boolean',
      },
      {
        'package.json': JSON.stringify(manifest),
        'index.js': 'export const history = true',
        'index.d.ts': 'export declare const history: string',
      },
      {
        'package.json': JSON.stringify({ ...manifest, version: '0.0.0' }),
        'index.js': 'export const history = true',
        'index.d.ts': 'export declare const history: boolean',
      },
      {
        'package.json': JSON.stringify({
          ...manifest,
          exports: { '.': { default: './index.js', import: './index.js' } },
        }),
        'index.js': 'export const history = true',
        'index.d.ts': 'export declare const history: boolean',
      },
      {
        'package.json': JSON.stringify({ ...manifest, sideEffects: true }),
        'index.js': 'export const history = true',
        'index.d.ts': 'export declare const history: boolean',
      },
      {
        'package.json': JSON.stringify(manifest),
        'index.js': 'export const history = true',
        'extra.js': 'injected',
        'index.d.ts': 'export declare const history: boolean',
      },
    ]) {
      const changed = pack(contents)
      assert.throws(() =>
        compareRegistryPayload(
          { ...metadata, dist: { ...metadata.dist, integrity: sri(changed) } },
          normal,
          changed,
          'a'.repeat(40),
        ),
      )
    }
    assert.throws(
      () =>
        compareRegistryPayload(
          metadata,
          normal,
          Buffer.from('corrupt registry bytes'),
          'a'.repeat(40),
        ),
      /dist.integrity/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('normal pack permits build-only catalog/script and map-mapping drift, never runtime or embedded-source drift', () => {
  const temporaryRoot = process.env.RUNNER_TEMP ?? process.env.OWNED_TEMP_DIR
  assert(temporaryRoot)
  const directory = mkdtempSync(
    path.join(temporaryRoot, 'registry-build-drift-'),
  )
  const pack = (contents) => {
    const raw = mkdtempSync(path.join(directory, 'raw-'))
    mkdirSync(path.join(raw, 'package'))
    for (const [name, bytes] of Object.entries(contents)) {
      writeFileSync(path.join(raw, 'package', name), bytes)
    }
    return execFileSync('tar', ['-czf', '-', '-C', raw, 'package'])
  }
  const manifest = {
    name: '@tanstack/start-fn-stubs',
    version: '1.162.0',
    type: 'module',
    types: './index.d.ts',
    exports: {
      '.': { import: { types: './index.d.ts', default: './index.js' } },
    },
    sideEffects: false,
    engines: { node: '>=22.12.0' },
    scripts: { test: 'vitest' },
    devDependencies: { vitest: '4.1.0' },
  }
  const map = {
    version: 3,
    file: 'index.js',
    sources: ['../src/index.ts'],
    sourcesContent: ['export const stub = true'],
    names: [],
    mappings: 'AAAA,MAAM',
  }
  const publishedFiles = {
    'package.json': JSON.stringify(manifest),
    'index.js': 'export const stub = true',
    'index.d.ts': 'export declare const stub: boolean',
    'index.js.map': JSON.stringify(map),
    LICENSE: 'MIT license exact bytes',
  }
  const normalFiles = {
    ...publishedFiles,
    'package.json': JSON.stringify(
      {
        ...manifest,
        scripts: { test: 'vitest run', types: 'tsc' },
        devDependencies: { vitest: '5.0.0' },
      },
      null,
      2,
    ),
    'index.js.map': JSON.stringify({ ...map, mappings: 'AACA,OAAO' }),
  }
  const sri = (bytes) =>
    'sha512-' + createHash('sha512').update(bytes).digest('base64')
  try {
    const published = pack(publishedFiles),
      normal = pack(normalFiles)
    const metadata = {
      name: manifest.name,
      version: manifest.version,
      dist: { integrity: sri(published) },
    }
    assert.equal(
      compareRegistryPayload(metadata, normal, published, 'a'.repeat(40))
        .payloadPolicy,
      'runtime-manifest-fields-and-map-content-v1',
    )
    const indexed = pack({
      ...publishedFiles,
      'index.js.map': JSON.stringify({ ...map, sections: [] }),
    })
    assert.throws(
      () =>
        compareRegistryPayload(
          { ...metadata, dist: { integrity: sri(indexed) } },
          indexed,
          indexed,
          'a'.repeat(40),
        ),
      /Indexed source maps/,
    )
    for (const changed of [
      ...[
        {
          exports: {
            '.': { import: { default: './index.js', types: './index.d.ts' } },
          },
        },
        { typesVersions: { '*': { '*': ['different.d.ts'] } } },
        { browser: './other.js' },
        { os: ['linux'] },
        { futureRuntimeField: { behavior: 'changed' } },
      ].map((extra) => ({
        ...normalFiles,
        'package.json': JSON.stringify({ ...manifest, ...extra }),
      })),
      ...[
        { sourceRoot: 'https://other.example/' },
        { sections: [] },
        {
          sections: [
            {
              offset: { line: 0, column: 0 },
              map: { version: 3, sources: [], names: [], mappings: '' },
            },
          ],
        },
        { futureMapField: { behavior: 'changed' } },
      ].map((extra) => ({
        ...normalFiles,
        'index.js.map': JSON.stringify({ ...map, ...extra }),
      })),
      {
        ...normalFiles,
        'package.json': JSON.stringify({
          ...manifest,
          engines: { node: '>=24' },
        }),
      },
      {
        ...normalFiles,
        'package.json': JSON.stringify({
          ...manifest,
          dependencies: { evil: '1.0.0' },
        }),
      },
      {
        ...normalFiles,
        'index.js.map': JSON.stringify({
          ...map,
          sourcesContent: ['export const stub = false'],
        }),
      },
      {
        ...normalFiles,
        'index.js.map': JSON.stringify({ ...map, names: ['changed'] }),
      },
      {
        ...normalFiles,
        'index.js.map': JSON.stringify({
          ...map,
          sources: ['../different.ts'],
        }),
      },
      {
        ...normalFiles,
        'index.js.map': JSON.stringify({ ...map, file: 'different.js' }),
      },
      { ...normalFiles, 'index.js': 'export const stub = false' },
      { ...normalFiles, 'index.d.ts': 'export declare const stub: string' },
      { ...normalFiles, 'extra.js': 'export const injected=true' },
      { ...normalFiles, LICENSE: 'different license bytes' },
    ]) {
      assert.throws(() =>
        compareRegistryPayload(
          metadata,
          pack(changed),
          published,
          'a'.repeat(40),
        ),
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('registry and workspace manifests cannot hide consumer lifecycle hooks or malformed scripts', () => {
  const temporaryRoot = process.env.RUNNER_TEMP ?? process.env.OWNED_TEMP_DIR
  assert(temporaryRoot)
  const directory = mkdtempSync(path.join(temporaryRoot, 'registry-lifecycle-'))
  const manifest = {
    name: '@tanstack/start-fn-stubs',
    version: '1.162.0',
    type: 'module',
    exports: { '.': './index.js' },
    scripts: { build: 'vite build', test: 'vitest' },
    devDependencies: { vitest: '5.0.0' },
  }
  const pack = (scripts) => {
    const raw = mkdtempSync(path.join(directory, 'raw-'))
    mkdirSync(path.join(raw, 'package'))
    writeFileSync(
      path.join(raw, 'package/package.json'),
      JSON.stringify({ ...manifest, scripts }),
    )
    writeFileSync(path.join(raw, 'package/index.js'), 'export const stub=true')
    return execFileSync('tar', ['-czf', '-', '-C', raw, 'package'])
  }
  const metadata = (bytes) => ({
    name: manifest.name,
    version: manifest.version,
    dist: {
      integrity:
        'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    },
  })
  try {
    const clean = pack(manifest.scripts)
    for (const hook of [
      'preinstall',
      'install',
      'postinstall',
      'preuninstall',
      'uninstall',
      'postuninstall',
    ]) {
      const unsafe = pack({
        ...manifest.scripts,
        [hook]: 'node ./consumer-side-effect.js',
      })
      // Correct registry SRI must not make a published hook acceptable.
      assert.throws(
        () =>
          compareRegistryPayload(
            metadata(unsafe),
            clean,
            unsafe,
            'a'.repeat(40),
          ),
        /Consumer lifecycle scripts are forbidden/,
      )
      assert.throws(
        () =>
          compareRegistryPayload(
            metadata(clean),
            unsafe,
            clean,
            'a'.repeat(40),
          ),
        /Consumer lifecycle scripts are forbidden/,
      )
    }
    for (const scripts of [
      null,
      [],
      'node install.js',
      42,
      { postinstall: 42 },
      { build: { command: 'vite build' } },
    ]) {
      const unsafe = pack(scripts)
      assert.throws(
        () =>
          compareRegistryPayload(
            metadata(unsafe),
            clean,
            unsafe,
            'a'.repeat(40),
          ),
        /Package scripts must/,
      )
      assert.throws(
        () =>
          compareRegistryPayload(
            metadata(clean),
            unsafe,
            clean,
            'a'.repeat(40),
          ),
        /Package scripts must/,
      )
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('qualification CLI reaches authenticated parent validation without an unsettled module cycle', () => {
  const temporaryRoot = process.env.RUNNER_TEMP ?? process.env.OWNED_TEMP_DIR
  assert(
    temporaryRoot,
    'Run CLI fixture under an operation-owned temporary root',
  )
  const directory = mkdtempSync(path.join(temporaryRoot, 'start-cli-'))
  try {
    const sourceSha = 'a'.repeat(40)
    const tag = `ultramodern-router-core-${sourceSha.slice(0, 12)}`
    const manifest = {
      repository: 'BleedingDev/router',
      contract: 'router-core-package-v1',
      sourceSha,
      ref: 'refs/heads/main',
      runId: '456',
      package: { name: '@tanstack/router-core', version: '1.171.38' },
    }
    const manifestBytes = JSON.stringify(manifest)
    const manifestUrl = `https://github.com/BleedingDev/router/releases/download/${tag}/core-package.json`
    const api = 'https://api.github.com/repos/BleedingDev/router/'
    const responses = {
      [`${api}releases/tags/${tag}`]: {
        tag_name: tag,
        draft: false,
        immutable: true,
        target_commitish: sourceSha,
        assets: [
          {
            name: 'core-package.json',
            browser_download_url: manifestUrl,
            digest: `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`,
          },
        ],
      },
      [manifestUrl]: manifest,
      [`${api}git/matching-refs/tags/${tag}`]: [
        {
          ref: `refs/tags/${tag}`,
          object: { type: 'commit', sha: sourceSha },
        },
      ],
    }
    const preload = path.join(directory, 'fetch-fixture.mjs')
    writeFileSync(
      preload,
      `
      import assert from 'node:assert/strict';
      const responses = ${JSON.stringify(responses)};
      globalThis.fetch = async (url) => {
        if (url === ${JSON.stringify(`${api}actions/runs/456`)}) {
          throw new Error('Reached authenticated parent run validation');
        }
        assert(Object.hasOwn(responses, url), 'Unexpected fixture request: ' + url);
        return new Response(JSON.stringify(responses[url]));
      };
    `,
    )
    const parents = path.join(directory, 'parents.json')
    writeFileSync(parents, JSON.stringify({ core: tag }))
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        preload,
        fileURLToPath(new URL('./qualify-start-package.mjs', import.meta.url)),
        'storage',
        path.join(directory, 'output'),
        parents,
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'false',
          GH_TOKEN: 'fixture-token',
          OWNED_TEMP_DIR: directory,
        },
      },
    )
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /Reached authenticated parent run validation/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
