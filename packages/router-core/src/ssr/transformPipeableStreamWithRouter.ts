import { Readable } from 'node:stream'
import { transformReadableStreamWithRouter } from './transformStreamWithRouter'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { AnyRouter } from '../router'
import type { TransformStreamWithRouterOptions } from './transformStreamWithRouter'

export function transformPipeableStreamWithRouter(
  router: AnyRouter,
  routerStream: Readable,
  opts?: TransformStreamWithRouterOptions,
) {
  return Readable.fromWeb(
    transformReadableStreamWithRouter(
      router,
      Readable.toWeb(routerStream),
      opts,
    ) as NodeReadableStream<Uint8Array>,
  )
}
