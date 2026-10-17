import { getRequest } from '@tanstack/solid-start/server'
import { makeData } from './data'

type Gate = { release: () => void }
const gates = new Map<string, Gate>()

export async function waitForLateStream(token: string) {
  const signal = getRequest().signal
  let release!: () => void
  let reject!: (reason: unknown) => void
  const ready = new Promise<void>((resolve, rejectPromise) => {
    release = resolve
    reject = rejectPromise
  })
  const gate = { release }
  gates.set(token, gate)
  const abort = () => reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => {
    reject(new Error('Late stream test gate was not released'))
  }, 30_000)
  try {
    if (signal.aborted) {
      abort()
    }
    await ready
    return makeData()
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    if (gates.get(token) === gate) {
      gates.delete(token)
    }
  }
}

export function releaseLateStream(token: string) {
  const gate = gates.get(token)
  if (!gate) {
    throw new Error('Late stream test gate is not waiting')
  }
  gate.release()
}
