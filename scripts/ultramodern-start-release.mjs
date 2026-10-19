import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  validateArchive,
  validateStartPeers,
  validateNormalStartManifest,
  validateRegistryDependencies,
  assertSourceIdentity,
  parent,
  verifyRegistryEvidence,
} from './qualify-start-package.mjs'
import {
  startProfiles as profiles,
  validateStartReleaseRun,
  validateStartReleaseArtifact,
} from './start-release-validators.mjs'

export {
  validateStartReleaseRun,
  validateStartReleaseArtifact,
} from './start-release-validators.mjs'

const repository = 'BleedingDev/router'
const workflow = '.github/workflows/start-package-qualification.yml'
const targetsFor = (profile) => [
  'build',
  'test:eslint',
  'test:types',
  ...(profile === 'storage' ? [] : ['test:unit']),
]
// All three Start packages intentionally export ESM only. This tests their
// supported module graph, while core/history retain their own dual-mode gate.
const checksFor = (profile) => [
  'publint --strict',
  'attw --profile esm-only',
  'installed-esm-public-exports-and-strict-types',
  ...(profile === 'storage' ? ['installed-async-context-isolation'] : []),
]
const integrity = (bytes) =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`

export function validateStartReleaseCohort(
  directory,
  runId,
  run,
  packageAttempt,
  source,
  workspaceVersions = {},
) {
  const filename = path.join(directory, 'start-package.json')
  assert(lstatSync(filename).isFile(), 'Cohort must be a regular file')
  const cohort = JSON.parse(readFileSync(filename, 'utf8'))
  assert.equal(cohort.schemaVersion, 1)
  assert.equal(cohort.contract, 'router-start-package-v1')
  assert.equal(cohort.repository, repository)
  assert.equal(cohort.sourceSha, run.head_sha)
  assert.equal(cohort.workflow, workflow)
  assert.equal(cohort.runId, runId)
  assert.equal(cohort.runAttempt, String(packageAttempt))
  assert.equal(cohort.event, 'workflow_dispatch')
  assert.equal(cohort.ref, 'refs/heads/main')
  const [basename, version] = profiles[cohort.profile] ?? []
  assert(basename, 'Unknown accepted Start profile')
  assert.equal(cohort.qualification.scope, `@tanstack/${basename}`)
  assert.deepEqual(cohort.qualification.targets, targetsFor(cohort.profile))
  assert.deepEqual(
    cohort.qualification.packageChecks,
    checksFor(cohort.profile),
  )
  assert.equal(
    cohort.sourceState,
    undefined,
    'Local candidate state cannot qualify a hosted release',
  )
  const entry = cohort.package
  assert.equal(entry.name, `@tanstack/${basename}`)
  assert.equal(entry.version, version)
  assert.equal(entry.name, source.name)
  assert.equal(entry.version, source.version)
  assert.match(
    entry.archive,
    /^tanstack-start-(?:storage-context|client-core|server-core)-[0-9][A-Za-z0-9.+-]*\.tgz$/,
  )
  assert.deepEqual(
    readdirSync(directory).sort(),
    [entry.archive, 'start-package.json'].sort(),
  )
  const archivePath = path.join(directory, entry.archive)
  assert(lstatSync(archivePath).isFile(), 'Archive must be a regular file')
  assert.equal(integrity(readFileSync(archivePath)), entry.integrity)
  const packed = JSON.parse(
    execFileSync('tar', ['-xOf', archivePath, 'package/package.json'], {
      maxBuffer: 1024 * 1024,
    }),
  )
  assert.equal(packed.name, entry.name)
  assert.equal(packed.version, entry.version)
  assert.deepEqual(packed.dependencies ?? {}, entry.dependencies)
  assert.deepEqual(packed.peerDependencies ?? {}, entry.peerDependencies)
  const {
    dependencies: expectedDependencies,
    peerDependencies: expectedPeers,
  } = validateNormalStartManifest(source, packed, workspaceVersions)
  assert.deepEqual(entry.dependencies, expectedDependencies)
  assert.deepEqual(entry.peerDependencies, expectedPeers)
  const expectedParents = [
    '@tanstack/router-core',
    ...(cohort.profile === 'storage'
      ? []
      : ['@tanstack/start-storage-context']),
    ...(cohort.profile === 'server' ? ['@tanstack/start-client-core'] : []),
  ]
  assert.deepEqual(
    cohort.parents.map((entry) => entry.name),
    expectedParents,
  )
  for (const entry of cohort.parents) {
    assert.equal(entry.version, workspaceVersions[entry.name])
    assert.match(entry.sourceSha, /^[a-f0-9]{40}$/)
    assert.equal(
      entry.url,
      `https://github.com/${repository}/releases/download/${entry.tag}/${entry.archive}`,
    )
  }
  const expectedRegistry = [
    '@tanstack/history',
    ...(cohort.profile === 'storage' ? [] : ['@tanstack/start-fn-stubs']),
  ]
  assert.deepEqual(
    cohort.registry.map((entry) => entry.name),
    expectedRegistry,
  )
  for (const entry of cohort.registry) {
    assert.equal(entry.version, workspaceVersions[entry.name])
    assert.equal(entry.evidence.type, 'normal-workspace-pack-content-v1')
    assert.equal(
      entry.evidence.payloadPolicy,
      'runtime-manifest-fields-and-map-content-v1',
    )
    assert.equal(entry.evidence.workspaceSourceSha, run.head_sha)
    assert.match(
      entry.evidence.workspaceArchiveIntegrity,
      /^sha512-[A-Za-z0-9+/]+={0,2}$/,
    )
    assert.match(entry.evidence.payloadSha256, /^[a-f0-9]{64}$/)
    assert(
      Number.isSafeInteger(entry.evidence.fileCount) &&
        entry.evidence.fileCount > 0,
    )
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/)
    assert.equal(new URL(entry.tarball).origin, 'https://registry.npmjs.org')
  }
  validateRegistryDependencies(
    { dependencies: expectedDependencies },
    cohort.registry,
  )
  validateStartPeers(packed, cohort.parents)
  assert.equal(
    cohort.tag,
    `ultramodern-start-${cohort.profile}-${run.head_sha.slice(0, 12)}`,
  )
  validateArchive(
    source,
    packed,
    execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' })
      .trim()
      .split('\n'),
    expectedDependencies,
  )
  return ['start-package.json', entry.archive]
}

export function validateStartPromotionEnvironment(environment) {
  assert.equal(environment.GITHUB_ACTIONS, 'true')
  assert.equal(environment.GITHUB_REPOSITORY, repository)
  assert.equal(environment.GITHUB_EVENT_NAME, 'workflow_dispatch')
  assert.equal(environment.GITHUB_REF, 'refs/heads/main')
}

export async function publishStartRelease(runId, profile, commands = {}) {
  assert.match(runId, /^[1-9][0-9]*$/)
  assert(profiles[profile], 'Choose storage, client or server')
  validateStartPromotionEnvironment(commands.environment ?? process.env)
  const gh =
    commands.gh ?? ((...args) => execFileSync('gh', args, { encoding: 'utf8' }))
  const git =
    commands.git ??
    ((...args) => execFileSync('git', args, { encoding: 'utf8' }))
  const api = (...args) => JSON.parse(gh('api', ...args))
  const producer = api(
    `repos/${repository}/actions/workflows/start-package-qualification.yml`,
  )
  assert.equal(producer.path, workflow)
  assert.equal(producer.state, 'active')
  assert(Number.isSafeInteger(producer.id) && producer.id > 0)
  const readAcceptedRun = () => {
    const current = api(`repos/${repository}/actions/runs/${runId}`)
    assert.equal(String(current.id), runId)
    assert.equal(current.workflow_id, producer.id)
    const jobs = api(
      `repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`,
      '--paginate',
      '--slurp',
    ).flatMap((page) => page.jobs)
    return { run: current, ...validateStartReleaseRun(current, jobs) }
  }
  const { run, sha, packageAttempt } = readAcceptedRun()
  // Root verifies/enables repository immutability with its authorized settings
  // credential before dispatch. GITHUB_TOKEN has no Administration-read scope;
  // the actual finalized release must still prove immutable on readback.
  assert.equal(
    git('remote', 'get-url', 'origin')
      .trim()
      .replace(/\.git$/, ''),
    `https://github.com/${repository}`,
    'Checkout must belong to the publication fork',
  )
  git('merge-base', '--is-ancestor', sha, 'origin/main')
  const source = JSON.parse(
    git('show', `${sha}:packages/${profiles[profile][0]}/package.json`),
  )
  const workspaceVersions = {}
  // Registry history also occurs transitively under the accepted core.
  for (const basename of [
    'router-core',
    'history',
    'start-storage-context',
    'start-client-core',
    'start-fn-stubs',
  ]) {
    const own = JSON.parse(
      git('show', `${sha}:packages/${basename}/package.json`),
    )
    workspaceVersions[own.name] = own.version
  }
  const directory = mkdtempSync(
    path.join(
      commands.temporaryRoot ?? process.env.RUNNER_TEMP,
      'start-package-release-',
    ),
  )
  try {
    const accepted = path.join(directory, 'accepted')
    const artifacts = api(
      `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
      '--paginate',
      '--slurp',
    ).flatMap((page) => page.artifacts)
    const artifact = validateStartReleaseArtifact(
      artifacts,
      runId,
      run,
      packageAttempt,
      profile,
    )
    const zip = commands.downloadArtifact
      ? commands.downloadArtifact(artifact.id)
      : execFileSync(
          'gh',
          ['api', `repos/${repository}/actions/artifacts/${artifact.id}/zip`],
          { maxBuffer: 128 * 1024 * 1024 },
        )
    assert(
      Buffer.isBuffer(zip),
      'Artifact transport must preserve exact binary bytes',
    )
    assert.equal(zip.length, artifact.size_in_bytes)
    assert.equal(
      `sha256:${createHash('sha256').update(zip).digest('hex')}`,
      artifact.digest,
    )
    const zipPath = path.join(directory, 'accepted.zip')
    writeFileSync(zipPath, zip, { flag: 'wx' })
    const entries = execFileSync('unzip', ['-Z1', zipPath], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
    assert.equal(
      entries.length,
      2,
      'The accepted artifact contains only its exact manifest and archive',
    )
    assert.equal(new Set(entries).size, 2)
    assert(entries.includes('start-package.json'))
    assert(
      entries.every(
        (name) =>
          name === 'start-package.json' ||
          /^tanstack-start-(?:storage-context|client-core|server-core)-[0-9][A-Za-z0-9.+-]*\.tgz$/.test(
            name,
          ),
      ),
      'Artifact paths must be flat regular package members',
    )
    execFileSync('unzip', ['-q', zipPath, '-d', accepted])
    const files = validateStartReleaseCohort(
      accepted,
      runId,
      run,
      packageAttempt,
      source,
      workspaceVersions,
    )
    const cohort = JSON.parse(
      readFileSync(path.join(accepted, 'start-package.json'), 'utf8'),
    )
    assert.equal(cohort.profile, profile)
    // Re-read immutable parents and their original Actions artifacts before
    // promotion. Never infer source equivalence from matching package versions.
    for (const entry of cohort.parents) {
      assert.deepEqual(
        await parent(entry.tag, entry.name, entry.version),
        entry,
      )
      assertSourceIdentity(entry.sourceSha, sha, entry.name, (_command, args) =>
        git(...args),
      )
    }
    for (const entry of cohort.registry) {
      await verifyRegistryEvidence(entry, sha)
    }
    assertSourceIdentity(
      cohort.parents[0].sourceSha,
      sha,
      '@tanstack/history',
      (_command, args) => git(...args),
    )
    const tag = cohort.tag
    const readTag = () => {
      const refs = api(
        `repos/${repository}/git/matching-refs/tags/${tag}`,
      ).filter((ref) => ref.ref === `refs/tags/${tag}`)
      assert(refs.length <= 1)
      for (const ref of refs) {
        assert.equal(
          ref.object.type,
          'commit',
          'Release tag must directly identify the accepted commit',
        )
        assert.equal(
          ref.object.sha,
          sha,
          'Release tag differs from accepted source',
        )
      }
      return refs
    }
    const title = `UltraModern Start ${profile} ${sha.slice(0, 12)}`
    const notes = `Exact Start ${profile} archive accepted by ${run.html_url}. Source: ${sha}.`
    const readReleaseById = (id) => {
      assert(Number.isSafeInteger(id) && id > 0)
      const release = api(`repos/${repository}/releases/${id}`)
      assert.equal(release.id, id, 'Release response differs from requested ID')
      return release
    }
    const readRelease = () => {
      // Authenticated REST listing includes drafts and requires only Contents.
      const matches = api(
        `repos/${repository}/releases?per_page=100`,
        '--paginate',
        '--slurp',
      )
        .flat()
        .filter((release) => release.tag_name === tag)
      assert(
        matches.length <= 1,
        'Multiple releases identify the same exact tag',
      )
      if (matches.length === 0) {
        return undefined
      }
      const [release] = matches
      assert(Number.isSafeInteger(release.id) && release.id > 0)
      return readReleaseById(release.id)
    }
    const validateAsset = (asset) => {
      assert(
        Number.isSafeInteger(asset.id) && asset.id > 0,
        'Asset requires its GitHub ID',
      )
      assert.equal(
        asset.url,
        `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`,
        'Asset URL differs from its validated ID',
      )
    }
    const validateAssets = (release) => {
      assert(Number.isSafeInteger(release.id) && release.id > 0)
      assert.equal(release.tag_name, tag)
      assert.equal(release.target_commitish, sha)
      assert.equal(
        new Set(release.assets.map((asset) => asset.name)).size,
        release.assets.length,
      )
      assert(
        release.assets.every((asset) => files.includes(asset.name)),
        'Unexpected release asset',
      )
      assert.equal(
        new Set(release.assets.map((asset) => asset.id)).size,
        release.assets.length,
        'Duplicate release asset IDs',
      )
      for (const asset of release.assets) {
        validateAsset(asset)
      }
    }
    const download = (asset) => {
      validateAsset(asset)
      const bytes = commands.downloadAsset
        ? commands.downloadAsset(asset.id)
        : execFileSync(
            'gh',
            [
              'api',
              `repos/${repository}/releases/assets/${asset.id}`,
              '-H',
              'Accept: application/octet-stream',
            ],
            { maxBuffer: 128 * 1024 * 1024 },
          )
      assert(
        Buffer.isBuffer(bytes),
        'Asset transport must preserve exact binary bytes',
      )
      return bytes
    }
    const acceptedBytes = (name) => readFileSync(path.join(accepted, name))
    const verifyPublished = (release) => {
      assert(release, 'Published release is missing')
      validateAssets(release)
      assert.equal(release.draft, false, 'Release must be published')
      assert.equal(
        release.prerelease,
        false,
        'Release must not be a prerelease',
      )
      assert.equal(release.name, title, 'Published release title differs')
      assert.equal(release.body, notes, 'Published release notes differ')
      assert.equal(
        release.immutable,
        true,
        'Published release must be immutable',
      )
      assert.equal(
        readTag().length,
        1,
        'Published release requires its exact source tag',
      )
      assert.equal(
        release.assets.length,
        files.length,
        'Published release is incomplete',
      )
      for (const asset of release.assets) {
        assert.equal(
          asset.state,
          'uploaded',
          'Published asset must be fully uploaded',
        )
        assert.deepEqual(
          download(asset),
          acceptedBytes(asset.name),
          'Never replace release bytes',
        )
      }
    }
    readTag()
    let release = readRelease()
    const retained = new Set()
    if (release) {
      validateAssets(release)
      if (!release.draft) {
        verifyPublished(release)
        return `https://github.com/${repository}/releases/tag/${tag}`
      }
      for (const asset of release.assets) {
        assert(
          ['starter', 'uploaded'].includes(asset.state),
          'Unknown draft asset state',
        )
        // A failed upload can leave a starter asset. Uploaded assets must be
        // downloaded successfully before deciding whether their bytes differ.
        if (
          asset.state === 'uploaded' &&
          download(asset).equals(acceptedBytes(asset.name))
        ) {
          retained.add(asset.name)
        } else {
          assert(
            Number.isSafeInteger(asset.id) && asset.id > 0,
            'Draft asset requires its GitHub ID',
          )
          gh(
            'api',
            '--method',
            'DELETE',
            `repos/${repository}/releases/assets/${asset.id}`,
          )
        }
      }
    } else {
      release = api(
        `repos/${repository}/releases`,
        '--method',
        'POST',
        '-f',
        `tag_name=${tag}`,
        '-f',
        `target_commitish=${sha}`,
        '-F',
        'draft=true',
        '-F',
        'prerelease=false',
        '-f',
        `name=${title}`,
        '-f',
        `body=${notes}`,
      )
      validateAssets(release)
      assert.equal(release.draft, true, 'New release must be a draft')
    }
    const releaseId = release.id
    for (const file of files) {
      if (!retained.has(file)) {
        const asset = api(
          `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(file)}`,
          '--method',
          'POST',
          '-H',
          'Content-Type: application/octet-stream',
          '--input',
          path.join(accepted, file),
        )
        validateAsset(asset)
        assert.equal(
          asset.name,
          file,
          'Upload response differs from requested asset',
        )
        assert.equal(asset.state, 'uploaded', 'Upload must complete')
      }
    }
    const completeDraft = readReleaseById(releaseId)
    assert(completeDraft?.draft, 'Only a draft may be finalized')
    validateAssets(completeDraft)
    assert.equal(
      completeDraft.assets.length,
      files.length,
      'Draft release is incomplete',
    )
    for (const asset of completeDraft.assets) {
      assert.equal(
        asset.state,
        'uploaded',
        'Draft asset must be fully uploaded',
      )
      assert.deepEqual(
        download(asset),
        acceptedBytes(asset.name),
        'Draft assets differ from accepted bytes',
      )
    }
    const latest = readAcceptedRun()
    assert.equal(latest.sha, sha)
    assert.equal(
      latest.packageAttempt,
      packageAttempt,
      'Acceptance changed while preparing the draft',
    )
    const finalized = api(
      `repos/${repository}/releases/${releaseId}`,
      '--method',
      'PATCH',
      '-F',
      'draft=false',
      '-F',
      'prerelease=false',
      '-f',
      'make_latest=false',
      '-f',
      `name=${title}`,
      '-f',
      `body=${notes}`,
    )
    assert.equal(
      finalized.id,
      releaseId,
      'Finalization response differs from requested ID',
    )
    verifyPublished(readReleaseById(releaseId))
    return `https://github.com/${repository}/releases/tag/${tag}`
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert.equal(process.argv.length, 4)
  console.log(await publishStartRelease(process.argv[2], process.argv[3]))
}
