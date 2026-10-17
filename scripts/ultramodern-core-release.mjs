import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const repository = 'BleedingDev/router'
const workflow = '.github/workflows/fork-qualification.yml'
const acceptedJob = 'Accept exact router-core archive after all eight shards'
const targets = [
  'test:eslint',
  'test:unit',
  'test:e2e',
  'test:types',
  'test:build',
  'build',
]
const integrity = (bytes) =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`

export function validateCoreReleaseRun(run, jobs) {
  assert.equal(run.repository?.full_name, repository)
  assert.equal(run.head_repository?.full_name, repository)
  assert.match(
    run.path,
    /^\.github\/workflows\/fork-qualification\.yml(?:@.+)?$/,
  )
  assert.equal(run.event, 'push')
  assert.equal(run.head_branch, 'main')
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
  assert.match(run.head_sha, /^[a-f0-9]{40}$/)
  assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0)
  const names = [
    'Plan the full fork qualification',
    ...Array.from(
      { length: 8 },
      (_, index) => `Full fork qualification shard ${index + 1}/8`,
    ),
    acceptedJob,
  ]
  const latest = names.map((name) => {
    const matches = jobs.filter((job) => job.name === name)
    const attempt = Math.max(...matches.map((job) => job.run_attempt))
    const newest = matches.filter((job) => job.run_attempt === attempt)
    assert.equal(newest.length, 1, `${name} requires one latest job`)
    const [job] = newest
    assert.equal(job.status, 'completed', `${name} must complete`)
    assert.equal(job.conclusion, 'success', `${name} must pass`)
    assert.equal(job.head_sha, run.head_sha)
    assert(
      Number.isSafeInteger(attempt) &&
        attempt > 0 &&
        attempt <= run.run_attempt,
    )
    return job
  })
  const packageAttempt = latest.at(-1).run_attempt
  // An earlier archive cannot attest a later rerun of any prerequisite.
  assert(latest.every((job) => job.run_attempt <= packageAttempt))
  return { sha: run.head_sha, packageAttempt }
}

export function validateCoreReleaseCohort(
  directory,
  runId,
  run,
  packageAttempt,
  source,
) {
  const filename = path.join(directory, 'cohort.json')
  assert(lstatSync(filename).isFile(), 'Cohort must be a regular file')
  const cohort = JSON.parse(readFileSync(filename, 'utf8'))
  assert.equal(cohort.schemaVersion, 1)
  assert.equal(cohort.repository, repository)
  assert.equal(cohort.sourceSha, run.head_sha)
  assert.equal(cohort.headSha, run.head_sha)
  assert.match(cohort.baseSha, /^[a-f0-9]{40}$/)
  assert.equal(cohort.workflow, workflow)
  assert.equal(cohort.runId, runId)
  assert.equal(cohort.runAttempt, String(packageAttempt))
  assert.equal(cohort.event, 'push')
  assert.equal(cohort.ref, 'refs/heads/main')
  assert.equal(cohort.qualification.shardCount, 8)
  assert(
    Number.isInteger(cohort.qualification.coreShard) &&
      cohort.qualification.coreShard >= 1 &&
      cohort.qualification.coreShard <= 8,
  )
  assert(
    Number.isSafeInteger(cohort.qualification.projectCount) &&
      cohort.qualification.projectCount >= 8,
  )
  assert.deepEqual(cohort.qualification.targets, targets)
  const entry = cohort.package
  assert.equal(entry.name, '@tanstack/router-core')
  assert.equal(entry.name, source.name)
  assert.equal(entry.version, source.version)
  assert.match(
    entry.archive,
    /^tanstack-router-core-[0-9][A-Za-z0-9.+-]*\.tgz$/,
  )
  assert.deepEqual(
    readdirSync(directory).sort(),
    [entry.archive, 'cohort.json'].sort(),
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
  return ['cohort.json', entry.archive]
}

export function publishCoreRelease(runId, commands = {}) {
  assert.match(runId, /^[1-9][0-9]*$/)
  const gh =
    commands.gh ?? ((...args) => execFileSync('gh', args, { encoding: 'utf8' }))
  const git =
    commands.git ??
    ((...args) => execFileSync('git', args, { encoding: 'utf8' }))
  const api = (...args) => JSON.parse(gh('api', ...args))
  const run = api(`repos/${repository}/actions/runs/${runId}`)
  assert.equal(String(run.id), runId)
  const jobs = api(
    `repos/${repository}/actions/runs/${runId}/jobs?filter=all&per_page=100`,
    '--paginate',
    '--slurp',
  ).flatMap((page) => page.jobs)
  const { sha, packageAttempt } = validateCoreReleaseRun(run, jobs)
  git('merge-base', '--is-ancestor', sha, 'origin/main')
  const source = JSON.parse(
    git('show', `${sha}:packages/router-core/package.json`),
  )
  const directory = mkdtempSync(
    path.join(
      commands.temporaryRoot ?? process.env.RUNNER_TEMP,
      'router-core-release-',
    ),
  )
  try {
    const accepted = path.join(directory, 'accepted')
    gh(
      'run',
      'download',
      runId,
      '--repo',
      repository,
      '--name',
      `router-core-cohort-${runId}-${packageAttempt}`,
      '--dir',
      accepted,
    )
    const files = validateCoreReleaseCohort(
      accepted,
      runId,
      run,
      packageAttempt,
      source,
    )
    const tag = `ultramodern-router-core-${sha.slice(0, 12)}`
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
    const readRelease = () => {
      // GraphQL resolves drafts as well as published releases.
      const id = api(
        'graphql',
        '-f',
        'query=query($tag: String!) { repository(owner: "BleedingDev", name: "router") { release(tagName: $tag) { databaseId } } }',
        '-f',
        `tag=${tag}`,
      ).data.repository.release?.databaseId
      return id === undefined
        ? undefined
        : api(`repos/${repository}/releases/${id}`)
    }
    const validateAssets = (release) => {
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
    }
    const download = (asset) => {
      const downloadDirectory = mkdtempSync(path.join(directory, 'asset-'))
      gh(
        'release',
        'download',
        tag,
        '--repo',
        repository,
        '--pattern',
        asset.name,
        '--dir',
        downloadDirectory,
      )
      return readFileSync(path.join(downloadDirectory, asset.name))
    }
    const acceptedBytes = (name) => readFileSync(path.join(accepted, name))
    const verifyPublished = (release) => {
      assert(release, 'Published release is missing')
      validateAssets(release)
      assert.equal(release.draft, false, 'Release must be published')
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
    const release = readRelease()
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
      gh(
        'release',
        'create',
        tag,
        '--repo',
        repository,
        '--target',
        sha,
        '--draft',
        '--title',
        `UltraModern router-core ${sha.slice(0, 12)}`,
        '--notes',
        `Exact router-core archive accepted by ${run.html_url}. Source: ${sha}.`,
      )
    }
    for (const file of files) {
      if (!retained.has(file)) {
        gh(
          'release',
          'upload',
          tag,
          path.join(accepted, file),
          '--repo',
          repository,
        )
      }
    }
    gh(
      'release',
      'edit',
      tag,
      '--repo',
      repository,
      '--draft=false',
      '--latest=false',
    )
    verifyPublished(readRelease())
    return `https://github.com/${repository}/releases/tag/${tag}`
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(publishCoreRelease(process.argv[2]))
}
