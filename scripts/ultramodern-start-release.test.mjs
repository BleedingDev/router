import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  validateStartReleaseCohort,
  validateStartReleaseRun,
  validateStartReleaseArtifact,
  validateStartPromotionEnvironment,
} from './ultramodern-start-release.mjs'
const repository = { full_name: 'BleedingDev/router', id: 123 }
const run = {
  id: 456,
  repository,
  head_repository: repository,
  path: '.github/workflows/start-package-qualification.yml',
  event: 'workflow_dispatch',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  head_sha: 'a'.repeat(40),
  run_attempt: 2,
}
const job = {
  name: 'Qualify the exact Start package',
  run_attempt: 2,
  head_sha: run.head_sha,
  status: 'completed',
  conclusion: 'success',
}
const artifact = {
  id: 789,
  name: 'start-package-client-456-2',
  expired: false,
  size_in_bytes: 500,
  digest: 'sha256:' + 'b'.repeat(64),
  workflow_run: {
    id: 456,
    head_sha: run.head_sha,
    head_branch: 'main',
    repository_id: 123,
    head_repository_id: 123,
  },
}
test('manual/main exact latest-attempt acceptance binds source and profile artifact', () => {
  assert.deepEqual(
    validateStartReleaseRun(run, [
      { ...job, run_attempt: 1, conclusion: 'failure' },
      job,
    ]),
    { sha: run.head_sha, packageAttempt: 2 },
  )
  assert.equal(
    validateStartReleaseArtifact([artifact], '456', run, 2, 'client'),
    artifact,
  )
})
test('foreign repository, branch, workflow, event or incomplete acceptance cannot publish', () => {
  for (const change of [
    { repository: { ...repository, full_name: 'foreign/router' } },
    { head_repository: { ...repository, id: 124 } },
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { path: '.github/workflows/else.yml' },
    { status: 'in_progress' },
    { conclusion: 'failure' },
  ]) {
    assert.throws(() => validateStartReleaseRun({ ...run, ...change }, [job]))
  }
})
test('old, duplicate, missing and failed newest acceptance jobs fail closed', () => {
  for (const jobs of [
    [],
    [{ ...job, run_attempt: 1 }],
    [job, job],
    [job, { ...job, run_attempt: 3 }],
    [{ ...job, conclusion: 'failure' }],
    [{ ...job, head_sha: 'c'.repeat(40) }],
  ]) {
    assert.throws(() => validateStartReleaseRun(run, jobs))
  }
})
test('artifact binds exact profile attempt, source, repository and bytes digest', () => {
  for (const change of [
    { expired: true },
    { name: 'start-package-storage-456-2' },
    { digest: '' },
    { workflow_run: { ...artifact.workflow_run, head_sha: 'c'.repeat(40) } },
    { workflow_run: { ...artifact.workflow_run, head_repository_id: 124 } },
  ]) {
    assert.throws(() =>
      validateStartReleaseArtifact(
        [{ ...artifact, ...change }],
        '456',
        run,
        2,
        'client',
      ),
    )
  }
  assert.throws(() =>
    validateStartReleaseArtifact([artifact, artifact], '456', run, 2, 'client'),
  )
})
test('publication requires the fork manual main Actions environment', () => {
  const environment = {
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'BleedingDev/router',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main',
  }
  validateStartPromotionEnvironment(environment)
  for (const key of Object.keys(environment)) {
    assert.throws(() =>
      validateStartPromotionEnvironment({ ...environment, [key]: 'wrong' }),
    )
  }
})

test('accepted manifest preserves normal source identity and exact peers; tampering fails', () => {
  const temporaryRoot = process.env.RUNNER_TEMP ?? process.env.OWNED_TEMP_DIR
  assert(
    temporaryRoot,
    'Run lifecycle fixture under an operation-owned temporary root',
  )
  const directory = mkdtempSync(path.join(temporaryRoot, 'start-cohort-guard-'))
  try {
    const raw = path.join(directory, 'raw')
    mkdirSync(raw)
    mkdirSync(path.join(raw, 'package'))
    const output = path.join(directory, 'accepted')
    mkdirSync(output)
    const core = {
      name: '@tanstack/router-core',
      version: '1.171.38',
      archive: 'tanstack-router-core-1.171.38.tgz',
      sourceSha: 'b'.repeat(40),
      tag: 'ultramodern-router-core-' + 'b'.repeat(12),
      dependencies: { '@tanstack/history': '1.162.5' },
    }
    core.url = `https://github.com/BleedingDev/router/releases/download/${core.tag}/${core.archive}`
    const source = {
      name: '@tanstack/start-storage-context',
      version: '1.167.40',
      peerDependencies: { '@tanstack/router-core': 'workspace:*' },
      exports: {
        '.': { import: { types: './index.d.ts', default: './index.js' } },
      },
    }
    const packed = {
      ...source,
      peerDependencies: { '@tanstack/router-core': core.version },
    }
    for (const [name, bytes] of [
      ['package.json', JSON.stringify(packed)],
      ['index.js', 'export const context = true'],
      ['index.d.ts', 'export declare const context: boolean'],
    ]) {
      writeFileSync(path.join(raw, 'package', name), bytes)
    }
    const archive = 'tanstack-start-storage-context-1.167.40.tgz'
    execFileSync('tar', [
      '-czf',
      path.join(output, archive),
      '-C',
      raw,
      'package',
    ])
    const cohort = {
      schemaVersion: 1,
      contract: 'router-start-package-v1',
      repository: 'BleedingDev/router',
      sourceSha: run.head_sha,
      workflow: run.path,
      runId: '456',
      runAttempt: '2',
      event: 'workflow_dispatch',
      ref: 'refs/heads/main',
      profile: 'storage',
      tag: 'ultramodern-start-storage-' + run.head_sha.slice(0, 12),
      qualification: {
        scope: source.name,
        targets: ['build', 'test:eslint', 'test:types'],
        packageChecks: [
          'publint --strict',
          'attw --profile esm-only',
          'installed-esm-public-exports-and-strict-types',
          'installed-async-context-isolation',
        ],
      },
      package: {
        name: packed.name,
        version: packed.version,
        archive,
        integrity:
          'sha512-' +
          createHash('sha512')
            .update(readFileSync(path.join(output, archive)))
            .digest('base64'),
        dependencies: {},
        peerDependencies: packed.peerDependencies,
      },
      parents: [core],
      registry: [
        {
          name: '@tanstack/history',
          version: '1.162.5',
          evidence: {
            type: 'normal-workspace-pack-content-v1',
            payloadPolicy: 'runtime-manifest-fields-and-map-content-v1',
            workspaceSourceSha: run.head_sha,
            workspaceArchiveIntegrity: 'sha512-YQ==',
            fileCount: 3,
            payloadSha256: 'd'.repeat(64),
          },
          integrity: 'sha512-YQ==',
          tarball:
            'https://registry.npmjs.org/@tanstack/history/-/history-1.162.5.tgz',
        },
      ],
    }
    const versions = {
      '@tanstack/router-core': '1.171.38',
      '@tanstack/history': '1.162.5',
    }
    const validate = (value) => {
      writeFileSync(
        path.join(output, 'start-package.json'),
        JSON.stringify(value),
      )
      return validateStartReleaseCohort(output, '456', run, 2, source, versions)
    }
    assert.deepEqual(validate(cohort), ['start-package.json', archive])
    for (const mutate of [
      (c) => {
        c.sourceState = { dirty: true }
      },
      (c) => {
        c.contract = 'router-start-package-candidate-v1'
      },
      (c) => {
        c.parents[0].version = '1.171.37'
      },
      (c) => {
        c.registry[0].version = '1.162.4'
      },
      (c) => {
        delete c.registry[0].evidence
      },
      (c) => {
        c.registry[0].evidence.workspaceSourceSha = 'e'.repeat(40)
      },
      (c) => {
        c.registry[0].evidence.payloadPolicy = 'drop-unwanted-fields'
      },
      (c) => {
        c.package.integrity = 'sha512-invalid'
      },
      (c) => {
        c.qualification.packageChecks[1] = 'attw --profile node16'
      },
      (c) => {
        c.package.peerDependencies['@tanstack/router-core'] = '^1.171.38'
      },
      (c) => {
        c.package.dependencies['@tanstack/router-core'] = core.url
      },
    ]) {
      const changed = structuredClone(cohort)
      mutate(changed)
      assert.throws(() => validate(changed))
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
