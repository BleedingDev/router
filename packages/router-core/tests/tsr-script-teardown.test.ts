import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createSsrSerializedScriptTransformer } from '../src/ssr/server'
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
    const transform = createSsrSerializedScriptTransformer()
    const statement = (value: string) =>
      `self.__tsrAdapterValues.push($_TSR.t.get("test")(${JSON.stringify(value)}))`
    const first = transform(statement('early'))
    const second = transform(statement('queued'))
    expect(first).toContain(minifiedTsrBootStrapScript)
    expect(second).not.toContain(minifiedTsrBootStrapScript)
    new Function(first)()
    const initial = (window as any).$_TSR
    new Function(second)()
    expect((window as any).$_TSR).toBe(initial)
    const early = (window as any).$_TSR as TsrBootstrap
    const buffer = early.buffer
    expect((window as any).__tsrAdapterValues).toEqual([])
    expect(buffer).toHaveLength(2)

    expect(installBootstrap()).toBe(early)
    expect(early.buffer).toBe(buffer)
    const adapters = new Map([['test', (value: string) => `decoded:${value}`]])
    early.t = adapters
    // Mirror the existing hydrate() adapter admission, then execute later records.
    early.buffer.forEach((script) => script())
    early.initialized = true
    expect((window as any).__tsrAdapterValues).toEqual([
      'decoded:early',
      'decoded:queued',
    ])

    expect(installBootstrap()).toBe(early)
    expect(early.t).toBe(adapters)
    expect(early.initialized).toBe(true)
    const late = transform(statement('late'))
    expect(late).not.toContain(minifiedTsrBootStrapScript)
    new Function(late)()
    expect((window as any).__tsrAdapterValues).toEqual([
      'decoded:early',
      'decoded:queued',
      'decoded:late',
    ])

    early.h()
    expect((window as any).$_TSR).toBe(early)
    early.e()
    expect((window as any).$_TSR).toBeUndefined()
  })

  test('each request transformer bootstraps once without resetting an existing queue', () => {
    const firstRequest = createSsrSerializedScriptTransformer()
    const secondRequest = createSsrSerializedScriptTransformer()
    const first = firstRequest('self.__tsrAdapterValues.push("first")')
    const second = secondRequest('self.__tsrAdapterValues.push("second")')
    expect(first).toContain(minifiedTsrBootStrapScript)
    expect(second).toContain(minifiedTsrBootStrapScript)
    expect(firstRequest('void 0')).not.toContain(minifiedTsrBootStrapScript)
    expect(secondRequest('void 0')).not.toContain(minifiedTsrBootStrapScript)
    ;(window as any).__tsrAdapterValues = []
    new Function(first)()
    const tsr = (window as any).$_TSR as TsrBootstrap
    const buffer = tsr.buffer
    new Function(second)()
    expect((window as any).$_TSR).toBe(tsr)
    expect(tsr.buffer).toBe(buffer)
    expect(buffer).toHaveLength(2)
    expect((window as any).__tsrAdapterValues).toEqual([])
    buffer.forEach((script) => script())
    expect((window as any).__tsrAdapterValues).toEqual(['first', 'second'])
  })

  test('queued renderer statement failures remain observable without finishing hydration', () => {
    const transform = createSsrSerializedScriptTransformer()
    new Function(transform('throw new Error("adapter failed")'))()
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
