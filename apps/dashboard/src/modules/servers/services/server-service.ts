import type { ServerInput, ServerView } from "@oh-my-emby/contracts"
import type { QueryClient, QueryKey } from "@tanstack/react-query"
import { queryOptions } from "@tanstack/react-query"

import { apiClient } from "@/lib/api-client"
import { queryKeys } from "@/lib/query-keys"
import { runProtected } from "@/modules/auth/services/auth-service"

type ServerId = ServerView["id"]

const invalidate = (queryClient: QueryClient, keys: ReadonlyArray<QueryKey>) => Promise.all(
  keys.map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true }))
)

export const serversQueryOptions = (queryClient: QueryClient) => queryOptions({
  queryKey: queryKeys.servers,
  queryFn: () => runProtected(apiClient.servers.listServers(), queryClient)
})

export const serverQueryOptions = (id: ServerId, queryClient: QueryClient) => queryOptions({
  queryKey: queryKeys.server(id),
  queryFn: () => runProtected(apiClient.servers.getServer({ params: { id } }), queryClient)
})

export const serverHealthRefetchInterval = (visibility: DocumentVisibilityState) =>
  visibility === "visible" ? 30_000 : false

export const serverHealthQueryOptions = (id: ServerId, queryClient: QueryClient) => queryOptions({
  queryKey: queryKeys.serverHealth(id),
  queryFn: () => runProtected(apiClient.servers.getServerHealth({ params: { id } }), queryClient)
})

export const serverLibrariesQueryOptions = (id: ServerId, queryClient: QueryClient) => queryOptions({
  queryKey: queryKeys.serverLibraries(id),
  queryFn: () => runProtected(apiClient.servers.listSourceLibraries({ params: { id } }), queryClient)
})

export const createServer = async (input: ServerInput, queryClient: QueryClient) => {
  const saved = await runProtected(apiClient.servers.createServer({ payload: input }), queryClient)
  await invalidate(queryClient, [
    queryKeys.servers,
    queryKeys.libraries,
    queryKeys.system,
    queryKeys.outboxFailures
  ])
  return saved
}

export const updateServer = async (id: ServerId, input: ServerInput, queryClient: QueryClient) => {
  const saved = await runProtected(apiClient.servers.updateServer({ params: { id }, payload: input }), queryClient)
  await invalidate(queryClient, [
    queryKeys.servers,
    queryKeys.server(id),
    queryKeys.serverHealth(id),
    queryKeys.serverLibraries(id),
    queryKeys.libraries,
    queryKeys.system,
    queryKeys.outboxFailures
  ])
  return saved
}

export const deleteServer = async (id: ServerId, queryClient: QueryClient) => {
  await runProtected(apiClient.servers.deleteServer({ params: { id } }), queryClient)
  await invalidate(queryClient, [
    queryKeys.servers,
    queryKeys.server(id),
    queryKeys.serverHealth(id),
    queryKeys.serverLibraries(id),
    queryKeys.libraries,
    queryKeys.system,
    queryKeys.outboxFailures
  ])
}

export const testServerConnection = async (id: ServerId, queryClient: QueryClient) => {
  try {
    return await runProtected(apiClient.servers.testServerConnection({ params: { id } }), queryClient)
  } finally {
    await invalidate(queryClient, [
      queryKeys.servers,
      queryKeys.server(id),
      queryKeys.serverHealth(id),
      queryKeys.serverLibraries(id),
      queryKeys.libraries,
      queryKeys.system,
      queryKeys.outboxFailures
    ])
  }
}
