import { Await, createFileRoute } from '@tanstack/solid-router'
import { createServerFn } from '@tanstack/solid-start'
import { Show, Suspense, createResource, createSignal } from 'solid-js'
import { z } from 'zod'
import { Foo, RenderData, makeData } from '~/data'

const waitForLateData = createServerFn()
  .validator(z.string().uuid())
  .handler(async ({ data }) => {
    const { waitForLateStream } = await import('~/late-stream.server')
    return waitForLateStream(data)
  })

const releaseLateData = createServerFn({ method: 'POST' })
  .validator(z.string().uuid())
  .handler(async ({ data }) => {
    const { releaseLateStream } = await import('~/late-stream.server')
    releaseLateStream(data)
  })

export const Route = createFileRoute('/ssr/stream')({
  validateSearch: z.object({ late: z.string().uuid().optional() }),
  loader: () => {
    const dataPromise = new Promise<ReturnType<typeof makeData>>((r) =>
      setTimeout(() => r(makeData()), 1000),
    )
    return {
      someString: 'hello world',
      dataPromise,
    }
  },

  errorComponent: (e) => <div>{e.error.message} </div>,
  component: RouteComponent,
})

function RouteComponent() {
  const loaderData = Route.useLoaderData()
  const search = Route.useSearch()
  return (
    <div>
      <h3 data-testid="stream-heading">Stream</h3>
      <div data-testid="some-data">{loaderData().someString}</div>
      <Show when={search().late}>
        {(token) => <LateStream token={token()} />}
      </Show>
      <Suspense fallback={<div>Loading...</div>}>
        <Await promise={loaderData().dataPromise}>
          {(data) => <RenderData id="stream" data={data} />}
        </Await>
      </Suspense>
    </div>
  )
}

function LateStream(props: { token: string }) {
  const [count, setCount] = createSignal(0)
  const [data] = createResource(
    () => props.token,
    (token) => waitForLateData({ data: token }),
  )
  return (
    <section>
      <button data-testid="late-counter" onClick={() => setCount(count() + 1)}>
        Count: {count()}
      </button>
      <button
        data-testid="late-release"
        onClick={() => releaseLateData({ data: props.token })}
      >
        Release server resource
      </button>
      <Suspense
        fallback={<div data-testid="late-pending">Waiting for server</div>}
      >
        <Show when={data()}>{(value) => <LateData data={value()} />}</Show>
      </Suspense>
    </section>
  )
}

function LateData(props: { data: ReturnType<typeof makeData> }) {
  const [decoded, setDecoded] = createSignal('not checked')
  return (
    <div>
      <RenderData id="late" data={props.data} />
      <button
        data-testid="late-check-adapters"
        onClick={() =>
          setDecoded(
            `${props.data.foo.singleInstance instanceof Foo}:${props.data.car.singleInstance.honk().message}`,
          )
        }
      >
        Use decoded adapters
      </button>
      <div data-testid="late-decoded">{decoded()}</div>
    </div>
  )
}
