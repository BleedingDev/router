import assert from 'node:assert/strict'

const repository = 'BleedingDev/router'
const acceptedJob = 'Qualify the exact Start package'
export const startProfiles = {
  storage: ['start-storage-context', '1.167.40'],
  client: ['start-client-core', '1.170.38'],
  server: ['start-server-core', '1.169.44'],
}

export function validateStartReleaseRun(run, jobs) {
  assert.equal(run.repository?.full_name, repository)
  assert.equal(run.head_repository?.full_name, repository)
  assert.match(
    run.path,
    /^\.github\/workflows\/start-package-qualification\.yml(?:@refs\/heads\/main)?$/,
  )
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.head_branch, 'main')
  assert.equal(run.status, 'completed')
  assert.equal(run.conclusion, 'success')
  assert.match(run.head_sha, /^[a-f0-9]{40}$/)
  assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0)
  assert(Number.isSafeInteger(run.id) && run.id > 0)
  assert(Number.isSafeInteger(run.repository.id) && run.repository.id > 0)
  assert.equal(run.head_repository.id, run.repository.id)
  const names = [acceptedJob]
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
  assert.equal(
    packageAttempt,
    run.run_attempt,
    'The latest run attempt must include successful exact-package acceptance',
  )
  // An earlier archive cannot attest a later rerun of any prerequisite.
  assert(latest.every((job) => job.run_attempt <= packageAttempt))
  return { sha: run.head_sha, packageAttempt }
}

export function validateStartReleaseArtifact(
  artifacts,
  runId,
  run,
  packageAttempt,
  profile,
) {
  assert(startProfiles[profile])
  const name = `start-package-${profile}-${runId}-${packageAttempt}`
  const matches = artifacts.filter((artifact) => artifact.name === name)
  assert.equal(matches.length, 1, 'Require one exact accepted artifact')
  const [artifact] = matches
  assert(Number.isSafeInteger(artifact.id) && artifact.id > 0)
  assert.equal(artifact.expired, false)
  assert(
    Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0,
  )
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(String(artifact.workflow_run?.id), runId)
  assert.equal(artifact.workflow_run.head_sha, run.head_sha)
  assert.equal(artifact.workflow_run.head_branch, 'main')
  assert.equal(artifact.workflow_run.repository_id, run.repository.id)
  assert.equal(artifact.workflow_run.head_repository_id, run.repository.id)
  return artifact
}
