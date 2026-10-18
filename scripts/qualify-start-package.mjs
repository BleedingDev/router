import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  lstatSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  consumerEnvironment,
  validateConsumerConfiguration,
  withConsumerDirectory,
  withDependencyRenewal,
} from './accept-router-core-package.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const workflow = '.github/workflows/start-package-qualification.yml'
const packages = {
  storage: ['start-storage-context', '1.167.40'],
  client: ['start-client-core', '1.170.38'],
  server: ['start-server-core', '1.169.44'],
}
const hash = (bytes, algorithm = 'sha512') =>
  `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`
const run = (command, args, cwd = root, env = process.env) =>
  execFileSync(command, args, { cwd, env, stdio: 'inherit' })
const read = (command, args, cwd = root, env = process.env) =>
  execFileSync(command, args, { cwd, env, encoding: 'utf8' }).trim()
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
async function fetchBytes(url) {
  const headers = url.startsWith('https://api.github.com/')
    ? {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? ''}`,
      }
    : {}
  if (url.startsWith('https://api.github.com/')) {
    assert(
      process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      'Authenticated Actions reads require GITHUB_TOKEN or GH_TOKEN',
    )
  }
  const response = await fetch(url, { headers })
  assert(response.ok, `${url}: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}
async function api(endpoint) {
  return JSON.parse(
    await fetchBytes(
      `https://api.github.com/repos/BleedingDev/router/${endpoint}`,
    ),
  )
}

// A parent is usable only after its actual immutable release and successful exact
// source workflow exist. No unpublished sibling URL or consumer override is used.
export async function parent(tag, expectedName, expectedVersion) {
  assert.match(
    tag,
    /^ultramodern-(?:router-core|start-(?:storage|client))-[a-f0-9]{12}$/,
  )
  const release = await api(`releases/tags/${tag}`)
  assert.equal(release.tag_name, tag)
  assert.equal(release.draft, false)
  assert.equal(release.immutable, true, `${tag} must already be immutable`)
  const manifestName =
    expectedName === '@tanstack/router-core'
      ? 'core-package.json'
      : 'start-package.json'
  const asset = release.assets.find((entry) => entry.name === manifestName)
  assert(asset)
  const manifestBytes = await fetchBytes(asset.browser_download_url)
  assert.equal(
    `sha256:${createHash('sha256').update(manifestBytes).digest('hex')}`,
    asset.digest,
  )
  const manifest = JSON.parse(manifestBytes)
  assert.equal(release.target_commitish, manifest.sourceSha)
  const tagRefs = (await api(`git/matching-refs/tags/${tag}`)).filter(
    (ref) => ref.ref === `refs/tags/${tag}`,
  )
  assert.equal(tagRefs.length, 1)
  assert.equal(tagRefs[0].object.type, 'commit')
  assert.equal(tagRefs[0].object.sha, manifest.sourceSha)
  assert.equal(manifest.repository, 'BleedingDev/router')
  assert.equal(
    manifest.contract,
    expectedName === '@tanstack/router-core'
      ? 'router-core-package-v1'
      : 'router-start-package-v1',
  )
  assert.equal(manifest.package.name, expectedName)
  assert.equal(manifest.package.version, expectedVersion)
  assert.equal(manifest.ref, 'refs/heads/main')
  assert.equal(
    tag,
    expectedName === '@tanstack/router-core'
      ? `ultramodern-router-core-${manifest.sourceSha.slice(0, 12)}`
      : `ultramodern-start-${expectedName.endsWith('storage-context') ? 'storage' : 'client'}-${manifest.sourceSha.slice(0, 12)}`,
  )
  assert.match(manifest.sourceSha, /^[a-f0-9]{40}$/)
  const { validateCoreReleaseRun, validateCoreReleaseArtifact } =
    await import('./ultramodern-core-release.mjs')
  const { validateStartReleaseRun, validateStartReleaseArtifact } =
    await import('./ultramodern-start-release.mjs')
  const isCore = expectedName === '@tanstack/router-core'
  const acceptedRun = await api(`actions/runs/${manifest.runId}`)
  assert.equal(String(acceptedRun.id), String(manifest.runId))
  const producer = await api(
    `actions/workflows/${isCore ? 'core-package-qualification.yml' : 'start-package-qualification.yml'}`,
  )
  assert.equal(producer.path, manifest.workflow)
  assert.equal(producer.state, 'active')
  assert.equal(acceptedRun.workflow_id, producer.id)
  const jobs = JSON.parse(
    read('gh', [
      'api',
      `repos/BleedingDev/router/actions/runs/${manifest.runId}/jobs?filter=all&per_page=100`,
      '--paginate',
      '--slurp',
    ]),
  ).flatMap((page) => page.jobs)
  const validated = isCore
    ? validateCoreReleaseRun(acceptedRun, jobs)
    : validateStartReleaseRun(acceptedRun, jobs)
  assert.equal(validated.sha, manifest.sourceSha)
  assert.equal(String(validated.packageAttempt), String(manifest.runAttempt))
  assert.equal(acceptedRun.event, manifest.event)
  assert.equal(
    acceptedRun.path.replace(/@refs\/heads\/main$/, ''),
    manifest.workflow,
  )
  const artifacts = JSON.parse(
    read('gh', [
      'api',
      `repos/BleedingDev/router/actions/runs/${manifest.runId}/artifacts?per_page=100`,
      '--paginate',
      '--slurp',
    ]),
  ).flatMap((page) => page.artifacts)
  const artifact = isCore
    ? validateCoreReleaseArtifact(
        artifacts,
        String(manifest.runId),
        acceptedRun,
        validated.packageAttempt,
      )
    : validateStartReleaseArtifact(
        artifacts,
        String(manifest.runId),
        acceptedRun,
        validated.packageAttempt,
        manifest.profile,
      )
  const archive = release.assets.find(
    (entry) => entry.name === manifest.package.archive,
  )
  assert(archive)
  const bytes = await fetchBytes(archive.browser_download_url)
  assert.equal(hash(bytes), manifest.package.integrity)
  assert.equal(
    `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    archive.digest,
  )
  // Release bytes must be the exact successful latest-attempt Actions artifact.
  const tempRoot = process.env.RUNNER_TEMP ?? process.env.OWNED_TEMP_DIR
  assert(
    tempRoot,
    'Artifact verification requires operation-owned temporary root',
  )
  const temporary = mkdtempSync(path.join(tempRoot, 'start-parent-'))
  try {
    const zip = execFileSync(
      'gh',
      ['api', `repos/BleedingDev/router/actions/artifacts/${artifact.id}/zip`],
      { maxBuffer: 128 * 1024 * 1024 },
    )
    assert.equal(zip.length, artifact.size_in_bytes)
    assert.equal(
      `sha256:${createHash('sha256').update(zip).digest('hex')}`,
      artifact.digest,
    )
    const filename = path.join(temporary, 'accepted.zip')
    writeFileSync(filename, zip, { flag: 'wx' })
    assert.deepEqual(
      read('unzip', ['-Z1', filename]).split('\n').sort(),
      [manifestName, manifest.package.archive].sort(),
    )
    for (const [name, expected] of [
      [manifestName, manifestBytes],
      [manifest.package.archive, bytes],
    ]) {
      assert.deepEqual(
        execFileSync('unzip', ['-p', filename, name], {
          maxBuffer: 128 * 1024 * 1024,
        }),
        expected,
      )
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  return {
    ...manifest.package,
    url: archive.browser_download_url,
    tag,
    sourceSha: manifest.sourceSha,
    runId: manifest.runId,
    parents: manifest.parents ?? [],
  }
}

export function assertSourceIdentity(sha, head, name, git = read) {
  assert.match(sha, /^[a-f0-9]{40}$/)
  assert.match(head, /^[a-f0-9]{40}$/)
  assert.match(
    name,
    /^@tanstack\/(router-core|history|start-storage-context|start-client-core|start-fn-stubs)$/,
  )
  try {
    git('git', ['merge-base', '--is-ancestor', sha, head])
    git('git', [
      'diff',
      '--exit-code',
      sha,
      head,
      '--',
      `packages/${name.slice('@tanstack/'.length)}`,
    ])
  } catch (error) {
    throw new Error(
      `${name}: source differs or publication commit is unavailable; fetch its authenticated source and re-release changed parents first`,
      { cause: error },
    )
  }
}
export function validateRegistryDependencies(packed, registry) {
  for (const entry of registry) {
    if (Object.hasOwn(packed.dependencies ?? {}, entry.name)) {
      assert.equal(
        packed.dependencies[entry.name],
        entry.version,
        `${entry.name}: normal pack must retain the verified registry source version`,
      )
    }
  }
}

// Compare the exact file set and bytes. Ignore only scripts/devDependencies in
// manifests after rejecting consumer lifecycle hooks, and mappings in flat source
// maps. Preserve every other key, including
// unknown future fields and conditional export/import order.
function archiveFiles(bytes) {
  assert(
    Buffer.isBuffer(bytes) &&
      bytes.length > 0 &&
      bytes.length <= 32 * 1024 * 1024,
  )
  const tar = (args) =>
    execFileSync('tar', args, { input: bytes, maxBuffer: 64 * 1024 * 1024 })
  const entries = tar(['-tzf', '-']).toString().trim().split('\n')
  assert(entries.length > 0 && entries.length <= 2000)
  assert.equal(
    new Set(entries).size,
    entries.length,
    'Duplicate tar entries are forbidden',
  )
  assert(
    tar(['-tvzf', '-'])
      .toString()
      .trim()
      .split('\n')
      .every((line) => /^[-d]/.test(line)),
    'Only regular files and directories may appear',
  )
  const files = entries.filter((entry) => !entry.endsWith('/')).sort()
  assert(files.includes('package/package.json'))
  return files.map((filename) => {
    assert(
      /^package\/[A-Za-z0-9_.@+\/-]+$/.test(filename) &&
        !filename.split('/').includes('..'),
      'Unsafe package member',
    )
    return [filename, tar(['-xOzf', '-', filename])]
  })
}

export function registryPayload(bytes, name, version) {
  const files = archiveFiles(bytes)
  const payload = files.map(([filename, bytes]) => {
    let content = bytes
    if (filename === 'package/package.json') {
      const manifest = JSON.parse(content)
      assert.equal(manifest.name, name)
      assert.equal(manifest.version, version)
      if (Object.hasOwn(manifest, 'scripts')) {
        assert(
          manifest.scripts !== null &&
            typeof manifest.scripts === 'object' &&
            !Array.isArray(manifest.scripts),
          'Package scripts must be an object',
        )
        assert(
          Object.values(manifest.scripts).every(
            (script) => typeof script === 'string',
          ),
          'Package scripts must contain string commands',
        )
        for (const hook of [
          'preinstall',
          'install',
          'postinstall',
          'preuninstall',
          'uninstall',
          'postuninstall',
        ]) {
          assert(
            !Object.hasOwn(manifest.scripts, hook),
            `Consumer lifecycle scripts are forbidden: ${hook}`,
          )
        }
      }
      delete manifest.scripts
      delete manifest.devDependencies
      // Sort only top-level keys; nested conditional object order is behavior.
      const runtime = Object.fromEntries(
        Object.entries(manifest).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      )
      content = Buffer.from(JSON.stringify(runtime))
    } else if (filename.endsWith('.map')) {
      const map = JSON.parse(content)
      assert.equal(map.version, 3, 'Only normal v3 source maps are supported')
      assert(
        !Object.hasOwn(map, 'sections'),
        'Indexed source maps require a separate reviewed comparison',
      )
      delete map.mappings
      const source = Object.fromEntries(
        Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      )
      content = Buffer.from(JSON.stringify(source))
    }
    return [filename, createHash('sha256').update(content).digest('hex')]
  })
  return {
    fileCount: files.length,
    payloadSha256: createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex'),
  }
}
export function compareRegistryPayload(
  metadata,
  normal,
  published,
  workspaceSourceSha,
) {
  assert.match(workspaceSourceSha, /^[a-f0-9]{40}$/)
  assert.match(metadata.dist.integrity, /^sha512-/)
  assert.equal(
    hash(published),
    metadata.dist.integrity,
    'Registry tarball differs from authenticated dist.integrity',
  )
  const expected = registryPayload(normal, metadata.name, metadata.version)
  assert.deepEqual(
    registryPayload(published, metadata.name, metadata.version),
    expected,
    'Registry package payload differs from the actual normal workspace pack',
  )
  return {
    type: 'normal-workspace-pack-content-v1',
    payloadPolicy: 'runtime-manifest-fields-and-map-content-v1',
    workspaceSourceSha,
    workspaceArchiveIntegrity: hash(normal),
    ...expected,
  }
}
export async function verifyRegistryEvidence(entry, sourceSha) {
  assert.equal(entry.evidence.type, 'normal-workspace-pack-content-v1')
  assert.equal(
    entry.evidence.payloadPolicy,
    'runtime-manifest-fields-and-map-content-v1',
  )
  assert.equal(entry.evidence.workspaceSourceSha, sourceSha)
  assert.match(
    entry.evidence.workspaceArchiveIntegrity,
    /^sha512-[A-Za-z0-9+/]+={0,2}$/,
  )
  assert.match(entry.evidence.payloadSha256, /^[a-f0-9]{64}$/)
  assert(
    Number.isSafeInteger(entry.evidence.fileCount) &&
      entry.evidence.fileCount > 0,
  )
  const metadata = JSON.parse(
    await fetchBytes(
      `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${entry.version}`,
    ),
  )
  assert.equal(metadata.name, entry.name)
  assert.equal(metadata.version, entry.version)
  assert.equal(metadata.dist.tarball, entry.tarball)
  assert.equal(metadata.dist.integrity, entry.integrity)
  assert.equal(new URL(entry.tarball).origin, 'https://registry.npmjs.org')
  const published = await fetchBytes(entry.tarball)
  assert.equal(hash(published), entry.integrity)
  assert.deepEqual(registryPayload(published, entry.name, entry.version), {
    fileCount: entry.evidence.fileCount,
    payloadSha256: entry.evidence.payloadSha256,
  })
}

const sharedParents = {
  '@tanstack/start-storage-context': ['@tanstack/router-core'],
  '@tanstack/start-client-core': [
    '@tanstack/router-core',
    '@tanstack/start-storage-context',
  ],
  '@tanstack/start-server-core': [
    '@tanstack/router-core',
    '@tanstack/start-storage-context',
    '@tanstack/start-client-core',
  ],
}

export function validateStartPeers(packed, parents) {
  assert(sharedParents[packed.name], 'Unknown Start package')
  assert.deepEqual(
    parents.map((entry) => entry.name),
    sharedParents[packed.name],
    'Every shared peer needs its authenticated parent archive',
  )
  for (const accepted of parents) {
    const names = sharedParents[accepted.name]
    if (!names) continue
    assert.deepEqual(
      accepted.parents,
      parents.filter((entry) => names.includes(entry.name)),
      'Accepted parents must retain the exact authenticated parent lineage',
    )
  }
  for (const owner of [packed, ...parents]) {
    for (const name of sharedParents[owner.name] ?? []) {
      const expected = parents.find((entry) => entry.name === name)
      assert(expected, `${name} needs an accepted parent archive`)
      assert.equal(
        owner.peerDependencies?.[name],
        expected.version,
        `${owner.name}: normal pack must retain the exact ${name} peer`,
      )
      assert.notEqual(owner.peerDependenciesMeta?.[name]?.optional, true)
      assert.equal(owner.dependencies?.[name], undefined)
      assert.equal(owner.optionalDependencies?.[name], undefined)
    }
    for (const requests of [
      owner.dependencies,
      owner.optionalDependencies,
      owner.peerDependencies,
    ]) {
      for (const [name, request] of Object.entries(requests ?? {})) {
        assert.equal(typeof request, 'string')
        assert(
          request.trim().length > 0 && !/[:/\\]/.test(request),
          `${owner.name}: ${name} must resolve outside the producer without exotic transitives`,
        )
      }
    }
  }
}

export function validateNormalStartManifest(source, packed, workspaceVersions) {
  const expected = {}
  for (const field of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    expected[field] = Object.fromEntries(
      Object.entries(source[field] ?? {}).map(([name, request]) => {
        assert.equal(typeof request, 'string')
        if (!request.startsWith('workspace:')) {
          return [name, request]
        }
        assert.equal(
          request,
          'workspace:*',
          'Only the owning exact workspace version is supported',
        )
        assert.match(
          workspaceVersions[name],
          /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/,
        )
        return [name, workspaceVersions[name]]
      }),
    )
    assert.deepEqual(
      packed[field] ?? {},
      expected[field],
      `Normal pack ${field} must match the owning source manifest`,
    )
  }
  assert.deepEqual(packed.peerDependenciesMeta, source.peerDependenciesMeta)
  return expected
}

export function verifyInstalledPackage(bytes, manifestPath) {
  const directory = path.dirname(realpathSync(manifestPath))
  const files = archiveFiles(bytes)
  const expected = files.map(([filename]) => filename.slice('package/'.length))
  const actual = []
  function visit(relative = '') {
    for (const name of readdirSync(path.join(directory, relative))) {
      if (!relative && name === 'node_modules') continue
      const filename = path.join(relative, name)
      const stat = lstatSync(path.join(directory, filename))
      assert(
        !stat.isSymbolicLink(),
        'Installed package payload must not contain symlinks',
      )
      if (stat.isDirectory()) visit(filename)
      else {
        assert(
          stat.isFile(),
          'Installed package payload must contain regular files',
        )
        actual.push(filename.split(path.sep).join('/'))
      }
    }
  }
  visit()
  assert.deepEqual(
    actual.sort(),
    expected,
    'Installed archive file set differs',
  )
  for (const [filename, content] of files) {
    assert.deepEqual(
      readFileSync(path.join(directory, filename.slice('package/'.length))),
      content,
      `Installed archive bytes differ: ${filename}`,
    )
  }
}

export function validateArchive(source, packed, entries, dependencies) {
  assert.equal(packed.name, source.name)
  assert.equal(packed.version, source.version)
  assert.deepEqual(packed.dependencies ?? {}, dependencies)
  assert.deepEqual(packed.exports, source.exports)
  assert.deepEqual(packed.imports, source.imports)
  const files = new Set(entries)
  for (const entry of entries) {
    assert(!entry.startsWith('/') && !entry.split('/').includes('..'))
  }
  function targets(value) {
    if (typeof value === 'string') {
      assert(value.startsWith('./') && !value.split('/').includes('..'))
      assert(
        files.has(`package/${value.slice(2)}`),
        `Missing packed target: ${value}`,
      )
    } else if (value && typeof value === 'object') {
      for (const target of Object.values(value)) {
        targets(target)
      }
    }
  }
  targets(packed.exports)
  targets(packed.imports)
}

async function accept(archive, packed, parents, registry) {
  const archives = [{ name: packed.name, bytes: readFileSync(archive) }]
  for (const entry of [...parents, ...registry]) {
    const bytes = await fetchBytes(entry.url ?? entry.tarball)
    assert.equal(hash(bytes), entry.integrity)
    archives.push({ name: entry.name, bytes })
  }
  const types = json(
    path.join(root, 'node_modules/@types/node/package.json'),
  ).version
  return withConsumerDirectory((directory, external, renew) => {
    const env = consumerEnvironment(process.env)
    const virtualStore = external ?? path.join(directory, 'node_modules/.pnpm')
    const policy = `minimumReleaseAge: 1440\nminimumReleaseAgeStrict: true\nminimumReleaseAgeExclude: []\nblockExoticSubdeps: true\nautoInstallPeers: false\npackageImportMethod: clone-or-copy\ntrustPolicy: no-downgrade\nvirtualStoreDir: ${JSON.stringify(virtualStore)}\n${process.env.ROUTER_CORE_STORE_DIR ? `storeDir: ${JSON.stringify(process.env.ROUTER_CORE_STORE_DIR)}\n` : ''}`
    const dependencies = Object.fromEntries([
      [packed.name, `file:${archive}`],
      ...parents.map((entry) => [entry.name, entry.url]),
    ])
    writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        private: true,
        type: 'module',
        packageManager: json(path.join(root, 'package.json')).packageManager,
        dependencies,
        devDependencies: { '@types/node': types },
      }),
    )
    writeFileSync(path.join(directory, 'pnpm-workspace.yaml'), policy)
    const readPnpm = (args) => read('pnpm', args, directory, env)
    const configuration = () =>
      Object.fromEntries(
        [
          'minimumReleaseAge',
          'minimumReleaseAgeStrict',
          'minimumReleaseAgeExclude',
          'blockExoticSubdeps',
          'autoInstallPeers',
          'packageImportMethod',
          'trustPolicy',
          'virtualStoreDir',
          ...(process.env.ROUTER_CORE_STORE_DIR ? ['storeDir'] : []),
        ].map((key) => [
          key,
          JSON.parse(readPnpm(['config', 'get', key, '--json'])),
        ]),
      )
    const effective = configuration()
    assert.equal(effective.blockExoticSubdeps, true)
    assert.equal(effective.autoInstallPeers, false)
    validateConsumerConfiguration(effective, undefined, directory, virtualStore)
    if (process.env.ROUTER_CORE_STORE_DIR) {
      assert.equal(
        path.resolve(effective.storeDir),
        path.resolve(process.env.ROUTER_CORE_STORE_DIR),
      )
    }
    withDependencyRenewal(
      () => run('pnpm', ['install', '--no-frozen-lockfile'], directory, env),
      renew,
    )
    assert.equal(
      readFileSync(path.join(directory, 'pnpm-workspace.yaml'), 'utf8'),
      policy,
    )
    assert.deepEqual(configuration(), effective)
    const yaml = createRequire(
      realpathSync(path.join(root, 'node_modules/nx/package.json')),
    )('yaml')
    const modules = yaml.parse(
      readFileSync(path.join(directory, 'node_modules/.modules.yaml'), 'utf8'),
    )
    validateConsumerConfiguration(
      effective,
      modules,
      directory,
      virtualStore,
      readPnpm(['store', 'path', '--silent']),
    )
    const lock = yaml.parse(
      readFileSync(path.join(directory, 'pnpm-lock.yaml'), 'utf8'),
    )
    for (const [name, request] of Object.entries(dependencies)) {
      assert.equal(lock.importers['.'].dependencies[name].specifier, request)
    }
    for (const entry of parents) {
      assert.equal(
        lock.packages[`${entry.name}@${entry.url}`].resolution.integrity,
        entry.integrity,
        `Installed ${entry.name} must retain authenticated parent bytes`,
      )
    }
    for (const entry of registry) {
      assert.equal(
        lock.packages[`${entry.name}@${entry.version}`].resolution.integrity,
        entry.integrity,
        `Installed ${entry.name} must retain authenticated registry bytes`,
      )
    }
    const consumer = createRequire(path.join(directory, 'package.json'))
    const seen = new Map()
    const direct = new Map(
      [packed, ...parents].map((entry) => [
        entry.name,
        realpathSync(consumer.resolve(`${entry.name}/package.json`)),
      ]),
    )
    function visit(filename) {
      filename = realpathSync(filename)
      const manifest = json(filename)
      const previous = seen.get(manifest.name)
      assert(
        !previous || previous === filename,
        `Duplicate native instance: ${manifest.name}`,
      )
      if (previous) return
      seen.set(manifest.name, filename)
      const owner = createRequire(filename)
      for (const entry of parents) {
        if (!Object.hasOwn(manifest.peerDependencies ?? {}, entry.name))
          continue
        assert.equal(manifest.peerDependencies[entry.name], entry.version)
        const target = realpathSync(owner.resolve(`${entry.name}/package.json`))
        assert.equal(
          target,
          direct.get(entry.name),
          `Duplicate shared peer: ${entry.name}`,
        )
        visit(target)
      }
      for (const entry of registry) {
        if (!Object.hasOwn(manifest.dependencies ?? {}, entry.name)) continue
        assert.equal(manifest.dependencies[entry.name], entry.version)
        const target = owner.resolve(`${entry.name}/package.json`)
        assert.equal(json(target).version, entry.version)
        visit(target)
      }
    }
    for (const [name, filename] of direct) {
      const expected =
        name === packed.name
          ? packed
          : parents.find((entry) => entry.name === name)
      const manifest = json(filename)
      assert.equal(manifest.name, name)
      assert.equal(manifest.version, expected.version)
      assert.deepEqual(manifest.dependencies ?? {}, expected.dependencies ?? {})
      assert.deepEqual(
        manifest.peerDependencies ?? {},
        expected.peerDependencies ?? {},
      )
      visit(filename)
    }
    for (const entry of archives) {
      assert(seen.has(entry.name), `Missing installed archive: ${entry.name}`)
      verifyInstalledPackage(entry.bytes, seen.get(entry.name))
    }
    const imports = Object.keys(packed.exports).map((key) =>
      key === '.' ? packed.name : `${packed.name}${key.slice(1)}`,
    )
    for (const specifier of imports) {
      const suffix = specifier.endsWith('/package.json')
        ? ' with {type:"json"}'
        : ''
      run(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import * as api from ${JSON.stringify(specifier)}${suffix}; if(!Object.keys(api).length){throw new Error('Empty public export')}`,
        ],
        directory,
        env,
      )
    }
    if (packed.name === '@tanstack/start-storage-context') {
      run(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import assert from 'node:assert/strict'; import {getStartContext,runWithStartContext} from '@tanstack/start-storage-context'; const a={request:new Request('https://a.example')},b={request:new Request('https://b.example')}; await Promise.all([a,b].map(context=>runWithStartContext(context,async()=>{await Promise.resolve();assert.equal(getStartContext(),context)}))); assert.equal(getStartContext({throwIfNotFound:false}),undefined);`,
        ],
        directory,
        env,
      )
    }
    const fixture = imports
      .filter((specifier) => !specifier.endsWith('/package.json'))
      .map(
        (specifier, index) =>
          `import * as api${index} from ${JSON.stringify(specifier)}; void api${index};`,
      )
      .join('\n')
    writeFileSync(path.join(directory, 'consumer.mts'), fixture)
    writeFileSync(
      path.join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022', 'DOM', 'DOM.Iterable'],
          types: ['node'],
          strict: true,
          skipLibCheck: false,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          noImplicitOverride: true,
          noEmit: true,
        },
        files: ['consumer.mts'],
      }),
    )
    run(
      process.execPath,
      [
        path.join(root, 'node_modules/typescript/lib/tsc.js'),
        '--project',
        'tsconfig.json',
      ],
      directory,
      env,
    )
  })
}

export async function qualifyStartPackage(profile, directory, parentTags = {}) {
  const [basename, version] = packages[profile] ?? []
  assert(basename, 'Choose storage, client or server')
  const source = json(path.join(root, 'packages', basename, 'package.json'))
  assert.equal(source.version, version)
  const sourceSha = read('git', ['rev-parse', 'HEAD'])
  const statusBefore = read('git', [
    'status',
    '--porcelain',
    '--untracked-files=normal',
  ])
  const ci = process.env.GITHUB_ACTIONS === 'true'
  const accepted =
    ci &&
    process.env.GITHUB_REPOSITORY === 'BleedingDev/router' &&
    process.env.GITHUB_REF === 'refs/heads/main' &&
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  if (ci) {
    assert.equal(statusBefore, '')
    assert.equal(sourceSha, process.env.GITHUB_SHA)
  }
  const output = path.resolve(directory)
  assert(
    ci ||
      (process.env.OWNED_TEMP_DIR &&
        output.startsWith(`${process.env.OWNED_TEMP_DIR}${path.sep}`)),
    'Local outputs must remain in the caller owned-temp-dir',
  )
  mkdirSync(output)
  const coreSource = json(path.join(root, 'packages/router-core/package.json'))
  const parents = [
    await parent(parentTags.core, '@tanstack/router-core', coreSource.version),
  ]
  if (profile !== 'storage') {
    parents.push(
      await parent(
        parentTags.storage,
        '@tanstack/start-storage-context',
        packages.storage[1],
      ),
    )
  }
  if (profile === 'server') {
    parents.push(
      await parent(
        parentTags.client,
        '@tanstack/start-client-core',
        packages.client[1],
      ),
    )
  }
  for (const entry of parents) {
    assertSourceIdentity(entry.sourceSha, sourceSha, entry.name)
  }
  // Workspace checks and installed archives must use the same actual sources.
  const registry = []
  for (const basename of [
    'history',
    ...(profile === 'storage' ? [] : ['start-fn-stubs']),
  ]) {
    const own = json(path.join(root, 'packages', basename, 'package.json'))
    const metadata = JSON.parse(
      await fetchBytes(
        `https://registry.npmjs.org/${encodeURIComponent(own.name)}/${own.version}`,
      ),
    )
    assert.equal(metadata.name, own.name)
    assert.equal(metadata.version, own.version)
    assert.match(metadata.dist.integrity, /^sha512-/)
    if (basename === 'history') {
      assert.equal(parents[0].dependencies[own.name], own.version)
      assertSourceIdentity(parents[0].sourceSha, sourceSha, own.name)
    }
    assert.equal(
      new URL(metadata.dist.tarball).origin,
      'https://registry.npmjs.org',
    )
    registry.push({
      name: own.name,
      version: own.version,
      tarball: metadata.dist.tarball,
      integrity: metadata.dist.integrity,
    })
  }
  const targets = ['build', 'test:eslint', 'test:types']
  // The upstream storage test:unit exits before Vitest; no unit success is claimed.
  if (profile !== 'storage') {
    targets.push('test:unit')
  }
  run('pnpm', [
    'nx',
    'run-many',
    `--targets=${targets.join(',')}`,
    `--projects=${source.name}`,
    '--parallel=1',
    '--outputStyle=stream',
    '--skipRemoteCache',
    '--skipNxCache',
  ])
  const registryStaging = mkdtempSync(path.join(output, 'registry-packs-'))
  try {
    for (const entry of registry) {
      const packDirectory = path.join(
        registryStaging,
        entry.name.slice('@tanstack/'.length),
      )
      mkdirSync(packDirectory)
      run('pnpm', [
        '--filter',
        entry.name,
        'pack',
        '--pack-destination',
        packDirectory,
      ])
      const filenames = readdirSync(packDirectory)
      assert.equal(filenames.length, 1)
      const normal = readFileSync(path.join(packDirectory, filenames[0]))
      const published = await fetchBytes(entry.tarball)
      entry.evidence = compareRegistryPayload(
        {
          name: entry.name,
          version: entry.version,
          dist: { tarball: entry.tarball, integrity: entry.integrity },
        },
        normal,
        published,
        sourceSha,
      )
    }
  } finally {
    rmSync(registryStaging, { recursive: true, force: true })
  }
  run('pnpm', ['--filter', source.name, 'pack', '--pack-destination', output])
  const files = readdirSync(output)
  assert.equal(files.length, 1)
  const archive = files[0]
  const archivePath = path.join(output, archive)
  const packed = JSON.parse(
    read('tar', ['-xOf', archivePath, 'package/package.json']),
  )
  const workspaceVersions = Object.fromEntries(
    [
      'router-core',
      'history',
      'start-storage-context',
      'start-client-core',
      'start-fn-stubs',
    ].map((basename) => {
      const own = json(path.join(root, 'packages', basename, 'package.json'))
      return [own.name, own.version]
    }),
  )
  const expected = validateNormalStartManifest(
    source,
    packed,
    workspaceVersions,
  )
  validateStartPeers(packed, parents)
  validateRegistryDependencies(packed, registry)
  validateArchive(
    source,
    packed,
    read('tar', ['-tzf', archivePath]).split('\n'),
    expected.dependencies,
  )
  const integrity = hash(readFileSync(archivePath))
  run('pnpm', [
    '--filter',
    source.name,
    'exec',
    'publint',
    '--strict',
    archivePath,
  ])
  run('pnpm', [
    '--filter',
    source.name,
    'exec',
    'attw',
    '--profile',
    'esm-only',
    archivePath,
  ])
  await accept(archivePath, packed, parents, registry)
  assert.equal(hash(readFileSync(archivePath)), integrity)
  const headAfter = read('git', ['rev-parse', 'HEAD'])
  const statusAfter = read('git', [
    'status',
    '--porcelain',
    '--untracked-files=normal',
  ])
  if (ci) {
    assert.equal(headAfter, sourceSha)
    assert.equal(statusAfter, '')
  }
  const manifest = {
    schemaVersion: 1,
    contract: accepted
      ? 'router-start-package-v1'
      : 'router-start-package-candidate-v1',
    repository: 'BleedingDev/router',
    sourceSha,
    profile,
    workflow,
    event: process.env.GITHUB_EVENT_NAME ?? 'local',
    ref: process.env.GITHUB_REF ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    tag: `ultramodern-start-${profile}-${sourceSha.slice(0, 12)}`,
    qualification: {
      scope: source.name,
      targets,
      packageChecks: [
        'publint --strict',
        'attw --profile esm-only',
        'installed-esm-public-exports-and-strict-types',
        ...(profile === 'storage' ? ['installed-async-context-isolation'] : []),
      ],
    },
    package: {
      name: packed.name,
      version: packed.version,
      archive,
      integrity,
      dependencies: packed.dependencies ?? {},
      peerDependencies: packed.peerDependencies ?? {},
    },
    parents,
    registry,
    ...(!ci ? { sourceState: { headAfter, statusBefore, statusAfter } } : {}),
  }
  writeFileSync(
    path.join(output, accepted ? 'start-package.json' : 'candidate.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert.equal(process.argv.length, 5)
  await qualifyStartPackage(
    process.argv[2],
    process.argv[3],
    json(process.argv[4]),
  )
}
