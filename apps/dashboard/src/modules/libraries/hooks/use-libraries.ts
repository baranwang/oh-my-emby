import type { ServerView, VirtualLibraryInput, VirtualLibraryView } from "@oh-my-emby/contracts"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"

import {
  createLibrary,
  deleteLibrary,
  librariesQueryOptions,
  libraryQueryOptions,
  updateLibrary
} from "@/modules/libraries/services/library-service"
import { serverLibrariesQueryOptions } from "@/modules/servers/services/server-service"

type LibraryId = VirtualLibraryView["id"]

export const useLibraries = () => {
  const queryClient = useQueryClient()
  return useQuery(librariesQueryOptions(queryClient))
}

export const useLibrary = (id: LibraryId) => {
  const queryClient = useQueryClient()
  return useQuery(libraryQueryOptions(id, queryClient))
}

export const useSourceLibraryGroups = (servers: ReadonlyArray<ServerView>, active = true) => {
  const queryClient = useQueryClient()
  const queries = useQueries({
    queries: servers.map((server) => {
      const eligible = server.enabled && server.health === "healthy"
      return { ...serverLibrariesQueryOptions(server.id, queryClient), enabled: active && eligible }
    })
  })

  return servers.map((server, index) => {
    const query = queries[index]!
    const eligible = server.enabled && server.health === "healthy"
    return {
      server,
      state: !eligible ? "unavailable" as const
        : query.isPending ? "pending" as const
        : query.isError ? "error" as const
        : "success" as const,
      sources: query.data ?? [],
      retry: query.refetch
    }
  })
}

export const useCreateLibrary = () => {
  const queryClient = useQueryClient()
  return useMutation({ mutationFn: (input: VirtualLibraryInput) => createLibrary(input, queryClient) })
}

export const useUpdateLibrary = (id: LibraryId) => {
  const queryClient = useQueryClient()
  return useMutation({ mutationFn: (input: VirtualLibraryInput) => updateLibrary(id, input, queryClient) })
}

export const useDeleteLibrary = (id: LibraryId) => {
  const queryClient = useQueryClient()
  return useMutation({ mutationFn: () => deleteLibrary(id, queryClient) })
}
