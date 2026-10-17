import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  publishCoreRelease,
  validateCoreReleaseCohort,
  validateCoreReleaseRun,
} from './ultramodern-core-release.mjs'

const sha = 'a'.repeat(40)
const source = { name: '@tanstack/router-core', version: '1.171.34' }
const run = {
  id: 123,
  repository: { full_name: 'BleedingDev/router' },
  head_repository: { full_name: 'BleedingDev/router' },
  path: '.github/workflows/fork-qualification.yml',
  event: 'push',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  head_sha: sha,
  run_attempt: 2,
  html_url: 'https://github.com/BleedingDev/router/actions/runs/123',
}
const jobs = [
  'Plan the full fork qualification',
  ...Array.from(
    { length: 8 },
    (_, index) => `Full fork qualification shard ${index + 1}/8`,
  ),
  'Accept exact router-core archive after all eight shards',
].map((name) => ({
  name,
  status: 'completed',
  conclusion: 'success',
  head_sha: sha,
  run_attempt: 1,
}))

test('only successful fork main push qualification with all shards can promote', () => {
  assert.deepEqual(validateCoreReleaseRun(run, jobs), {
    sha,
    packageAttempt: 1,
  })
  for (const change of [
    { repository: { full_name: 'TanStack/router' } },
    { head_repository: { full_name: 'foreign/router' } },
    { path: '.github/workflows/fork-qualification.yml.backup' },
    { event: 'pull_request' },
    { event: 'workflow_dispatch' },
    { head_branch: 'feature' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { run_attempt: 0 },
    { head_sha: '../escape' },
  ]) {
    assert.throws(() => validateCoreReleaseRun({ ...run, ...change }, jobs))
  }
  assert.deepEqual(
    validateCoreReleaseRun(
      { ...run, path: run.path + '@refs/heads/main' },
      jobs,
    ),
    { sha, packageAttempt: 1 },
  )
  for (let index = 0; index < jobs.length; index++) {
    assert.throws(() =>
      validateCoreReleaseRun(
        run,
        jobs.filter((_, offset) => offset !== index),
      ),
    )
    for (const change of [
      { conclusion: 'failure' },
      { conclusion: 'skipped' },
      { status: 'in_progress' },
      { head_sha: 'b'.repeat(40) },
      { run_attempt: 3 },
    ]) {
      assert.throws(() =>
        validateCoreReleaseRun(
          run,
          jobs.map((job, offset) =>
            offset === index ? { ...job, ...change } : job,
          ),
        ),
      )
    }
  }
  const later = { ...jobs[3], run_attempt: 2, conclusion: 'failure' }
  assert.throws(() => validateCoreReleaseRun(run, [...jobs, later]))
  assert.throws(() => validateCoreReleaseRun(run, [later, ...jobs]))
  // Even a newer successful shard needs a final acceptance at least as new.
  assert.throws(() =>
    validateCoreReleaseRun(run, [...jobs, { ...later, conclusion: 'success' }]),
  )
  assert.deepEqual(
    validateCoreReleaseRun(run, [
      ...jobs,
      { ...later, conclusion: 'success' },
      { ...jobs.at(-1), run_attempt: 2 },
    ]),
    { sha, packageAttempt: 2 },
  )
})

function fixture(context) {
  const root = mkdtempSync(path.join(tmpdir(), 'router-core-release-test-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const accepted = path.join(root, 'accepted')
  mkdirSync(accepted)
  const packed = path.join(root, 'source/package')
  mkdirSync(packed, { recursive: true })
  writeFileSync(
    path.join(packed, 'package.json'),
    JSON.stringify({
      ...source,
      dependencies: { '@tanstack/history': '1.162.4' },
    }),
  )
  const archive = 'tanstack-router-core-1.171.34.tgz'
  execFileSync('tar', [
    '-czf',
    path.join(accepted, archive),
    '-C',
    path.dirname(packed),
    'package',
  ])
  const cohort = {
    schemaVersion: 1,
    repository: 'BleedingDev/router',
    sourceSha: sha,
    headSha: sha,
    baseSha: 'b'.repeat(40),
    workflow: '.github/workflows/fork-qualification.yml',
    runId: '123',
    runAttempt: '1',
    event: 'push',
    ref: 'refs/heads/main',
    qualification: {
      targets: [
        'test:eslint',
        'test:unit',
        'test:e2e',
        'test:types',
        'test:build',
        'build',
      ],
      shardCount: 8,
      coreShard: 3,
      projectCount: 100,
    },
    package: {
      ...source,
      archive,
      dependencies: { '@tanstack/history': '1.162.4' },
      integrity: `sha512-${createHash('sha512')
        .update(readFileSync(path.join(accepted, archive)))
        .digest('base64')}`,
    },
  }
  const save = () =>
    writeFileSync(path.join(accepted, 'cohort.json'), JSON.stringify(cohort))
  save()
  return { root, accepted, cohort, save }
}

test('binds accepted archive bytes to exact attempt, source, package and qualification', (context) => {
  const f = fixture(context)
  const validate = () =>
    validateCoreReleaseCohort(f.accepted, '123', run, 1, source)
  assert.deepEqual(validate(), ['cohort.json', f.cohort.package.archive])
  for (const [key, value] of Object.entries({
    schemaVersion: 2,
    repository: 'TanStack/router',
    sourceSha: 'b'.repeat(40),
    headSha: 'b'.repeat(40),
    baseSha: '../escape',
    workflow: 'other.yml',
    runId: '124',
    runAttempt: '2',
    event: 'pull_request',
    ref: 'refs/pull/1/merge',
  })) {
    const previous = f.cohort[key]
    f.cohort[key] = value
    f.save()
    assert.throws(validate)
    f.cohort[key] = previous
  }
  for (const [key, value] of Object.entries({
    name: '@foreign/router-core',
    version: '9.9.9',
    archive: '../outside.tgz',
    integrity: 'sha512-incorrect',
    dependencies: {},
  })) {
    const previous = f.cohort.package[key]
    f.cohort.package[key] = value
    f.save()
    assert.throws(validate)
    f.cohort.package[key] = previous
  }
  f.cohort.qualification.shardCount = 7
  f.save()
  assert.throws(validate)
  f.cohort.qualification.shardCount = 8
  f.save()
  writeFileSync(path.join(f.accepted, 'unexpected.tgz'), 'unaccepted archive')
  assert.throws(validate)
  rmSync(path.join(f.accepted, 'unexpected.tgz'))
  const archivePath = path.join(f.accepted, f.cohort.package.archive)
  const outside = path.join(f.root, 'original.tgz')
  cpSync(archivePath, outside)
  rmSync(archivePath)
  symlinkSync(outside, archivePath)
  assert.throws(validate, /regular file/)
  rmSync(archivePath)
  writeFileSync(archivePath, 'tampered')
  assert.throws(validate)
})

function promotion(context) {
  const f = fixture(context)
  const temporaryRoot = path.join(f.root, 'temporary')
  mkdirSync(temporaryRoot)
  const sentinel = path.join(temporaryRoot, 'caller-owned.txt')
  writeFileSync(sentinel, 'preserve')
  const tag = `ultramodern-router-core-${sha.slice(0, 12)}`
  const state = {
    release: undefined,
    assets: new Map(),
    assetMetadata: new Map(),
    jobs: jobs.map((job) => ({ ...job })),
    deletes: 0,
    nextAssetId: 1,
    immutableOnPublish: true,
    tagShaOnPublish: sha,
    corruptOnPublish: false,
    failAssetDownload: false,
    uploads: 0,
    creates: 0,
    edits: 0,
    tagSha: undefined,
    failAfterOneUpload: false,
    failDownload: false,
    ancestryFailure: false,
  }
  const commands = {
    temporaryRoot,
    git: (...args) => {
      if (args[0] === 'merge-base') {
        assert.deepEqual(args, [
          'merge-base',
          '--is-ancestor',
          sha,
          'origin/main',
        ])
        if (state.ancestryFailure) {
          throw new Error('Not an ancestor')
        }
        return ''
      }
      assert.deepEqual(args, [
        'show',
        `${sha}:packages/router-core/package.json`,
      ])
      return JSON.stringify(source)
    },
    gh: (...args) => {
      if (args[0] === 'api') {
        if (args[1] === '--method') {
          assert.equal(args[2], 'DELETE')
          assert.equal(
            state.release.draft,
            true,
            'Never mutate published assets',
          )
          const id = Number(args[3].split('/').at(-1))
          const entry = [...state.assetMetadata].find(
            ([, asset]) => asset.id === id,
          )
          assert(entry, 'Delete only the identified draft asset')
          state.assets.delete(entry[0])
          state.assetMetadata.delete(entry[0])
          state.deletes++
          return ''
        }
        if (args[1].endsWith('/runs/123')) {
          return JSON.stringify(run)
        }
        if (args[1].includes('/jobs?')) {
          assert(args.includes('--paginate') && args.includes('--slurp'))
          return JSON.stringify([
            { jobs: state.jobs.slice(0, 5) },
            { jobs: state.jobs.slice(5) },
          ])
        }
        if (args[1].includes('/matching-refs/')) {
          return JSON.stringify(
            state.tagSha
              ? [
                  {
                    ref: `refs/tags/${tag}`,
                    object: { type: 'commit', sha: state.tagSha },
                  },
                ]
              : [],
          )
        }
        if (args[1] === 'graphql') {
          return JSON.stringify({
            data: {
              repository: {
                release: state.release ? { databaseId: 501 } : null,
              },
            },
          })
        }
        assert.equal(args[1], 'repos/BleedingDev/router/releases/501')
        return JSON.stringify({
          ...state.release,
          assets: [...state.assets.keys()].map((name) => ({
            name,
            ...state.assetMetadata.get(name),
          })),
        })
      }
      if (args[0] === 'run') {
        assert.equal(
          args[args.indexOf('--name') + 1],
          `router-core-cohort-123-${f.cohort.runAttempt}`,
        )
        if (state.failDownload) {
          throw new Error('Download interrupted')
        }
        cpSync(f.accepted, args[args.indexOf('--dir') + 1], { recursive: true })
        return ''
      }
      const [, command, requestedTag] = args
      assert.equal(requestedTag, tag)
      assert(!args.includes('--clobber'))
      if (command === 'create') {
        assert.equal(state.release, undefined)
        state.release = { tag_name: tag, target_commitish: sha, draft: true }
        state.creates++
      } else if (command === 'upload') {
        const file = args[3]
        const name = path.basename(file)
        assert(!state.assets.has(name), 'Never overwrite an existing asset')
        const interrupted = state.failAfterOneUpload && state.uploads === 1
        state.assets.set(
          name,
          interrupted ? Buffer.alloc(0) : readFileSync(file),
        )
        state.assetMetadata.set(name, {
          id: state.nextAssetId++,
          state: interrupted ? 'starter' : 'uploaded',
        })
        if (interrupted) {
          throw new Error('Upload interrupted')
        }
        state.uploads++
      } else if (command === 'download') {
        if (state.failAssetDownload) {
          throw new Error('Asset transport failure')
        }
        const name = args[args.indexOf('--pattern') + 1]
        writeFileSync(
          path.join(args[args.indexOf('--dir') + 1], name),
          state.assets.get(name),
        )
      } else if (command === 'edit') {
        state.edits++
        state.release.draft = false
        state.tagSha = state.tagShaOnPublish
        state.release.immutable = state.immutableOnPublish
        if (state.corruptOnPublish) {
          state.assets.set(
            'cohort.json',
            Buffer.from('corrupted on publication'),
          )
        }
      } else {
        assert.fail(`Unexpected command: ${args}`)
      }
      return ''
    },
  }
  const clean = () =>
    assert.deepEqual(readdirSync(temporaryRoot), ['caller-owned.txt'])
  return { ...f, state, commands, clean }
}

test('replaces an interrupted starter asset, then leaves finalized bytes untouched', (context) => {
  const f = promotion(context)
  f.state.failAfterOneUpload = true
  assert.throws(
    () => publishCoreRelease('123', f.commands),
    /Upload interrupted/,
  )
  assert.equal(f.state.assets.size, 2)
  assert.equal(
    f.state.assetMetadata.get(f.cohort.package.archive).state,
    'starter',
  )
  assert.equal(f.state.release.draft, true)
  f.clean()
  f.state.failAfterOneUpload = false
  const url = publishCoreRelease('123', f.commands)
  assert.equal(
    url,
    `https://github.com/BleedingDev/router/releases/tag/ultramodern-router-core-${sha.slice(0, 12)}`,
  )
  assert.equal(f.state.deletes, 1)
  assert.equal(f.state.release.draft, false)
  assert.equal(f.state.release.immutable, true)
  f.clean()
  publishCoreRelease('123', f.commands)
  assert.equal(f.state.creates, 1)
  assert.equal(f.state.uploads, 2)
  assert.equal(f.state.edits, 1)
  assert.equal(f.state.deletes, 1)
  f.state.assets.set('cohort.json', Buffer.from('different remote bytes'))
  assert.throws(
    () => publishCoreRelease('123', f.commands),
    /Never replace release bytes/,
  )
  assert.equal(f.state.deletes, 1)
  f.clean()
})

test('a newer accepted attempt replaces only differing draft bytes and interrupted uploads', (context) => {
  const f = promotion(context)
  f.state.failAfterOneUpload = true
  assert.throws(
    () => publishCoreRelease('123', f.commands),
    /Upload interrupted/,
  )
  f.cohort.runAttempt = '2'
  f.save()
  f.state.jobs.at(-1).run_attempt = 2
  f.state.failAfterOneUpload = false
  publishCoreRelease('123', f.commands)
  assert.equal(f.state.deletes, 2)
  assert.equal(f.state.uploads, 3)
  assert.deepEqual(
    f.state.assets.get('cohort.json'),
    readFileSync(path.join(f.accepted, 'cohort.json')),
  )
  assert.deepEqual(
    f.state.assets.get(f.cohort.package.archive),
    readFileSync(path.join(f.accepted, f.cohort.package.archive)),
  )
  f.clean()
})

test('uploaded draft transport failures do not delete or replace assets', (context) => {
  const f = promotion(context)
  f.state.failAfterOneUpload = true
  assert.throws(
    () => publishCoreRelease('123', f.commands),
    /Upload interrupted/,
  )
  f.state.failAfterOneUpload = false
  f.state.failAssetDownload = true
  assert.throws(
    () => publishCoreRelease('123', f.commands),
    /Asset transport failure/,
  )
  assert.equal(f.state.deletes, 0)
  assert.equal(f.state.uploads, 1)
  assert.equal(f.state.edits, 0)
  f.clean()
})

test('publication readback rejects a moved tag, mutable release or differing bytes', (context) => {
  for (const [field, value, message] of [
    ['tagShaOnPublish', 'b'.repeat(40), /Release tag differs/],
    ['immutableOnPublish', false, /must be immutable/],
    ['corruptOnPublish', true, /Never replace release bytes/],
  ]) {
    const f = promotion(context)
    f.state[field] = value
    assert.throws(() => publishCoreRelease('123', f.commands), message)
    assert.equal(f.state.edits, 1)
    assert.equal(f.state.deletes, 0)
    f.clean()
  }
})

test('published fast return also requires immutable status without mutation', (context) => {
  const f = promotion(context)
  publishCoreRelease('123', f.commands)
  f.state.release.immutable = false
  assert.throws(
    () => publishCoreRelease('123', f.commands),
    /must be immutable/,
  )
  assert.equal(f.state.edits, 1)
  assert.equal(f.state.uploads, 2)
  assert.equal(f.state.deletes, 0)
  f.clean()
})

test('early download failure cleans only owned files; ancestry and tag mismatch cannot publish', (context) => {
  const f = promotion(context)
  f.state.failDownload = true
  assert.throws(
    () => publishCoreRelease('123', f.commands),
    /Download interrupted/,
  )
  f.clean()
  f.state.failDownload = false
  f.state.ancestryFailure = true
  assert.throws(() => publishCoreRelease('123', f.commands), /Not an ancestor/)
  f.clean()
  f.state.ancestryFailure = false
  f.state.tagSha = 'b'.repeat(40)
  assert.throws(
    () => publishCoreRelease('123', f.commands),
    /Release tag differs/,
  )
  assert.equal(f.state.creates, 0)
  f.clean()
})

test('published releases reject incomplete or unexpected assets without mutation', (context) => {
  const f = promotion(context)
  publishCoreRelease('123', f.commands)
  const archive = f.cohort.package.archive
  const accepted = f.state.assets.get(archive)
  f.state.assets.delete(archive)
  assert.throws(() => publishCoreRelease('123', f.commands), /incomplete/)
  f.state.assets.set(archive, accepted)
  f.state.assets.set('unaccepted.txt', Buffer.from('foreign'))
  assert.throws(
    () => publishCoreRelease('123', f.commands),
    /Unexpected release asset/,
  )
  assert.equal(f.state.edits, 1)
  assert.equal(f.state.uploads, 2)
  f.clean()
})

test('an archive attributed to another source fails before any release mutation', (context) => {
  const f = promotion(context)
  f.cohort.sourceSha = 'b'.repeat(40)
  f.save()
  assert.throws(() => publishCoreRelease('123', f.commands))
  assert.equal(f.state.creates, 0)
  assert.equal(f.state.uploads, 0)
  assert.equal(f.state.edits, 0)
  f.clean()
})
