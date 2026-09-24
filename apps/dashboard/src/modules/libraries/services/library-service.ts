import type { VirtualLibraryInput, VirtualLibraryView } from "@oh-my-emby/contracts"
import type { QueryClient } from "@tanstack/react-query"
import { queryOptions } from "@tanstack/react-query"

import { apiClient } from "@/lib/api-client"
import { queryKeys } from "@/lib/query-keys"
import { runProtected } from "@/modules/auth/services/auth-service"

type LibraryId = VirtualLibraryView["id"]

export const librariesQueryOptions = (queryClient: QueryClient) => queryOptions({
  queryKey: queryKeys.libraries,
  queryFn: () => runProtected(apiClient.libraries.listVirtualLibraries(), queryClient)
})

export const libraryQueryOptions = (id: LibraryId, queryClient: QueryClient) => queryOptions({
  queryKey: queryKeys.library(id),
  queryFn: () => runProtected(apiClient.libraries.getVirtualLibrary({ params: { id } }), queryClient)
})

export const createLibrary = async (input: VirtualLibraryInput, queryClient: QueryClient) => {
  const saved = await runProtected(apiClient.libraries.createVirtualLibrary({ payload: input }), queryClient)
  await queryClient.invalidateQueries({ queryKey: queryKeys.libraries })
  return saved
}

export const updateLibrary = async (
  id: LibraryId,
  input: VirtualLibraryInput,
  queryClient: QueryClient
) => {
  const saved = await runProtected(
    apiClient.libraries.updateVirtualLibrary({ params: { id }, payload: input }),
    queryClient
  )
  await queryClient.invalidateQueries({ queryKey: queryKeys.library(id) })
  await queryClient.invalidateQueries({ queryKey: queryKeys.libraries })
  return saved
}

export const deleteLibrary = async (id: LibraryId, queryClient: QueryClient) => {
  await runProtected(apiClient.libraries.deleteVirtualLibrary({ params: { id } }), queryClient)
  await queryClient.invalidateQueries({ queryKey: queryKeys.library(id) })
  await queryClient.invalidateQueries({ queryKey: queryKeys.libraries })
}
