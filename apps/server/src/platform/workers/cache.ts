import { Effect } from "effect"

import { MAX_IMAGE_BYTES } from "../../core/limits.js"
import {
  ResourceCacheError,
  type CachedResource,
  type ResourceCacheService
} from "../../core/resource-cache.js"

export interface WorkersCacheBinding {
  readonly match: (request: Request) => Promise<Response | undefined>
  readonly put: (request: Request, response: Response) => Promise<void>
  readonly delete: (request: Request) => Promise<boolean>
}

const cacheOrigin = "https://resource-cache.invalid/"
const expiresHeader = "x-oh-my-emby-expires-at"
const safeHeaders = ["content-type", "content-disposition", "etag", "last-modified"] as const

const failure = () => new ResourceCacheError({ message: "Workers resource cache operation failed" })

const cacheRequest = async (key: string): Promise<Request> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key))
  const encoded = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return new Request(`${cacheOrigin}${encoded}`)
}

const readBoundedBody = async (response: Response): Promise<Uint8Array> => {
  const declared = response.headers.get("content-length")
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_IMAGE_BYTES)) throw failure()
  if (response.body === null) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Array<Uint8Array> = []
  let length = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    length += next.value.byteLength
    if (length > MAX_IMAGE_BYTES) {
      await reader.cancel()
      throw failure()
    }
    chunks.push(next.value)
  }
  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

const headersFrom = (headers: Headers): ReadonlyArray<readonly [string, string]> =>
  safeHeaders.flatMap((name): ReadonlyArray<readonly [string, string]> => {
    const value = headers.get(name)
    return value === null ? [] : [[name, value]]
  })

export const makeWorkersResourceCache = (
  cache: WorkersCacheBinding
): ResourceCacheService => ({
  get: (key) => Effect.tryPromise({
    try: async (): Promise<CachedResource | null> => {
      const request = await cacheRequest(key)
      const response = await cache.match(request)
      if (response === undefined) return null
      const rawExpiresAtMs = response.headers.get(expiresHeader)
      if (rawExpiresAtMs === null || !/^\d+$/.test(rawExpiresAtMs)) {
        await cache.delete(request)
        return null
      }
      const expiresAtMs = Number(rawExpiresAtMs)
      if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= Date.now()) {
        await cache.delete(request)
        return null
      }
      return {
        status: response.status,
        headers: headersFrom(response.headers),
        body: await readBoundedBody(response),
        expiresAtMs
      }
    },
    catch: failure
  }),
  put: (key, resource, expiresAtMs) => Effect.tryPromise({
    try: async () => {
      if (resource.body.byteLength > MAX_IMAGE_BYTES || !Number.isSafeInteger(expiresAtMs)) throw failure()
      const request = await cacheRequest(key)
      const headers = new Headers(resource.headers.map(([name, value]) => [name, value]))
      for (const name of [...headers.keys()]) {
        if (!safeHeaders.includes(name as typeof safeHeaders[number])) headers.delete(name)
      }
      headers.set(expiresHeader, String(expiresAtMs))
      headers.set("cache-control", `public, max-age=${Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1_000))}`)
      headers.set("content-length", String(resource.body.byteLength))
      await cache.put(request, new Response(resource.body.slice(), {
        status: resource.status,
        headers
      }))
    },
    catch: failure
  }),
  prune: () => Effect.void
})
