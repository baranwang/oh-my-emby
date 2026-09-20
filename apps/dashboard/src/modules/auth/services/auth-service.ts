import type { QueryClient } from "@tanstack/react-query"
import { queryOptions } from "@tanstack/react-query"
import { Effect, Result } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { apiClient } from "@/lib/api-client"
import { protectedQueryFamilies, queryKeys } from "@/lib/query-keys"

type Credentials = {
  readonly username: string
  readonly password: string
}

const run = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(
    effect.pipe(Effect.provideService(
      FetchHttpClient.Fetch,
      (...input) => globalThis.fetch(...input)
    ))
  ))
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const isUnauthorized = (error: unknown): error is { readonly _tag: "Unauthorized" } =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "Unauthorized"

export const bootstrapQueryOptions = queryOptions({
  queryKey: queryKeys.bootstrap,
  queryFn: () => run(apiClient.bootstrap.getBootstrap())
})

export const sessionQueryOptions = queryOptions({
  queryKey: queryKeys.session,
  queryFn: () => run(apiClient.auth.getSession())
})

const clearProtectedQueries = (queryClient: QueryClient) => {
  for (const queryKey of protectedQueryFamilies) {
    queryClient.removeQueries({ queryKey })
  }
}

export const handleUnauthorized = async (queryClient: QueryClient) => {
  clearProtectedQueries(queryClient)
  await queryClient.refetchQueries({ queryKey: queryKeys.session, exact: true, type: "all" })
}

export const runProtected = async <A, E>(
  effect: Effect.Effect<A, E>,
  queryClient: QueryClient
): Promise<A> => {
  try {
    return await run(effect)
  } catch (error) {
    if (isUnauthorized(error)) await handleUnauthorized(queryClient)
    throw error
  }
}

export const claim = async (credentials: Credentials, queryClient: QueryClient) => {
  const session = await run(apiClient.auth.claim({ payload: credentials }))
  queryClient.setQueryData(queryKeys.bootstrap, { initialized: true })
  queryClient.setQueryData(queryKeys.session, session)
  return session
}

export const login = async (credentials: Credentials, queryClient: QueryClient) => {
  const session = await run(apiClient.auth.login({ payload: credentials }))
  queryClient.setQueryData(queryKeys.session, session)
  return session
}

export const logout = async (queryClient: QueryClient) => {
  await run(apiClient.auth.logout())
  clearProtectedQueries(queryClient)
  await queryClient.refetchQueries({ queryKey: queryKeys.session, exact: true, type: "all" })
}
