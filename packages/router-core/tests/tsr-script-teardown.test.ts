import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { wrapSsrSerializedScript } from '../src/ssr/server'
import minifiedTsrBootStrapScript from '../src/ssr/tsrScript?script-string'

type TsrBootstrap = {
  h: () => void
  e: () => void
  c: () => void
  p: (script: () => void) => void
  buffer: Array<() => void>
  t?: Map<string, (value: string) => string>
  initialized?: boolean
}

// Assign `self.$_TSR`.
function installBootstrap(): TsrBootstrap {
  new Function(minifiedTsrBootStrapScript)()
  return (window as any).$_TSR
}

describe('$_TSR client teardown', () => {
  beforeEach(() => {
    ;(window as any).$R = { tsr: [] }
    delete (window as any).$_TSR
  })

  afterEach(() => {
    delete (window as any).$_TSR
    delete (window as any).$R
    delete (window as any).__tsrAdapterValues
  })

  test('early renderer statements survive normal bootstrap and deserialize exactly once', () => {
    ;(window as any).__tsrAdapterValues = []
    const emit = (value: string) =>
      new Function(
        wrapSsrSerializedScript(
          `self.__tsrAdapterValues.push($_TSR.t.get("test")(${JSON.stringify(value)}))`,
        ),
      )()

    emit('early')
    const early = (window as any).$_TSR as TsrBootstrap
    const buffer = early.buffer
    expect((window as any).__tsrAdapterValues).toEqual([])
    expect(buffer).toHaveLength(1)

    expect(installBootstrap()).toBe(early)
    expect(early.buffer).toBe(buffer)
    const adapters = new Map([['test', (value: string) => `decoded:${value}`]])
    early.t = adapters
    // Mirror the existing hydrate() adapter admission, then execute later records.
    early.buffer.forEach((script) => script())
    early.initialized = true
    expect((window as any).__tsrAdapterValues).toEqual(['decoded:early'])

    expect(installBootstrap()).toBe(early)
    expect(early.t).toBe(adapters)
    expect(early.initialized).toBe(true)
    emit('late')
    expect((window as any).__tsrAdapterValues).toEqual([
      'decoded:early',
      'decoded:late',
    ])

    early.h()
    expect((window as any).$_TSR).toBe(early)
    early.e()
    expect((window as any).$_TSR).toBeUndefined()
  })

  test('queued renderer statement failures remain observable without finishing hydration', () => {
    new Function(wrapSsrSerializedScript('throw new Error("adapter failed")'))()
    const tsr = (window as any).$_TSR as TsrBootstrap
    expect(installBootstrap()).toBe(tsr)
    expect(() => tsr.buffer.forEach((script) => script())).toThrow(
      'adapter failed',
    )
    expect((window as any).$_TSR).toBe(tsr)
    expect((window as any).$R.tsr).toEqual([])
  })

  test('does not tear down until both hydrated and streamEnded', () => {
    const tsr = installBootstrap()

    tsr.h()
    expect((window as any).$_TSR).toBeDefined()

    tsr.e()
    expect((window as any).$_TSR).toBeUndefined()
  })

  test('removes both $_TSR and $R[tsr] on teardown', () => {
    const tsr = installBootstrap()

    tsr.h()
    tsr.e()

    expect((window as any).$_TSR).toBeUndefined()
    expect((window as any).$R.tsr).toBeUndefined()
  })
})
