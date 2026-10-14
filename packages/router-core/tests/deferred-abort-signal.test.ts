import { expect, test } from 'vitest'
import { createMemoryHistory } from '@tanstack/history'
import { BaseRootRoute, BaseRoute } from '../src'
import { createTestRouter } from './routerTestUtils'

function expectAbortError(signal: AbortSignal) {
  expect(signal.aborted).toBe(true)
  expect(signal.reason).toMatchObject({ name: 'AbortError', code: 20 })
}

// Public contract: a router abort controller whose signal is first read after
// the router retired it still exposes an aborted signal with the standard
// AbortError reason, and later public aborts cannot replace that reason.
test('retired controllers expose aborted signals when first read later', async () => {
  const loaderControllers: Array<AbortController> = []
  const beforeLoadControllers: Array<AbortController> = []
  const rootRoute = new BaseRootRoute({})
  const homeRoute = new BaseRoute({
    getParentRoute: () => rootRoute,
    path: '/',
  })
  const postRoute = new BaseRoute({
    getParentRoute: () => rootRoute,
    path: '/posts/$id',
    beforeLoad: ({ abortController }) => {
      beforeLoadControllers.push(abortController)
    },
    loader: ({ abortController }) => {
      loaderControllers.push(abortController)
      return 'data'
    },
  })
  const router = createTestRouter({
    routeTree: rootRoute.addChildren([homeRoute, postRoute]),
    history: createMemoryHistory({ initialEntries: ['/posts/1'] }),
  })

  await router.load()
  const presented = router.state.matches.at(-1)!.abortController
  await router.navigate({ to: '/posts/$id', params: { id: '2' } })
  await router.navigate({ to: '/' })

  expect(loaderControllers).toHaveLength(2)
  expect(beforeLoadControllers).toHaveLength(2)
  for (const controller of [
    ...loaderControllers,
    ...beforeLoadControllers,
    presented,
  ]) {
    controller.abort(new Error('late public abort'))
    expectAbortError(controller.signal)
  }
})

test('a signal read before retirement dispatches abort when retired', async () => {
  const events: Array<string> = []
  const rootRoute = new BaseRootRoute({})
  const homeRoute = new BaseRoute({
    getParentRoute: () => rootRoute,
    path: '/',
  })
  const postsRoute = new BaseRoute({
    getParentRoute: () => rootRoute,
    path: '/posts',
    loader: ({ abortController }) => {
      abortController.signal.addEventListener('abort', () => {
        events.push('loader')
        expectAbortError(abortController.signal)
      })
    },
  })
  const router = createTestRouter({
    routeTree: rootRoute.addChildren([homeRoute, postsRoute]),
    history: createMemoryHistory({ initialEntries: ['/posts'] }),
  })

  await router.load()
  expect(events).toEqual([])
  await router.navigate({ to: '/' })
  expect(events).toEqual(['loader'])
})
