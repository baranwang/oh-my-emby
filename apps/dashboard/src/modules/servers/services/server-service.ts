import type { ServerInput, ServerView } from "@oh-my-emby/contracts"
import type { QueryClient } from "@tanstack/react-query"
import { queryOptions } from "@tanstack/react-query"

import { apiClient } from "@/lib/api-client"
import { queryKeys } from "@/lib/query-keys"
import { runProtected } from "@/modules/auth/services/auth-service"

type ServerId = ServerView["id"]

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
  await queryClient.invalidateQueries({ queryKey: queryKeys.servers })
  return saved
}

export const updateServer = async (id: ServerId, input: ServerInput, queryClient: QueryClient) => {
  const saved = await runProtected(apiClient.servers.updateServer({ params: { id }, payload: input }), queryClient)
  await queryClient.invalidateQueries({ queryKey: queryKeys.server(id) })
  await queryClient.invalidateQueries({ queryKey: queryKeys.servers })
  return saved
}

export const deleteServer = async (id: ServerId, queryClient: QueryClient) => {
  await runProtected(apiClient.servers.deleteServer({ params: { id } }), queryClient)
  await queryClient.invalidateQueries({ queryKey: queryKeys.server(id) })
  await queryClient.invalidateQueries({ queryKey: queryKeys.servers })
}

export const testServerConnection = async (id: ServerId, queryClient: QueryClient) => {
  const result = await runProtected(apiClient.servers.testServerConnection({ params: { id } }), queryClient)
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.server(id) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.servers })
  ])
  return result
}
