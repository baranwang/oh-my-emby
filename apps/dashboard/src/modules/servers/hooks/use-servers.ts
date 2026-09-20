import { useEffect, useState } from "react"
import type { ServerInput, ServerView } from "@oh-my-emby/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import {
  createServer,
  deleteServer,
  serverHealthQueryOptions,
  serverHealthRefetchInterval,
  serverLibrariesQueryOptions,
  serverQueryOptions,
  serversQueryOptions,
  testServerConnection,
  updateServer
} from "@/modules/servers/services/server-service"

type ServerId = ServerView["id"]

export const useServers = () => {
  const queryClient = useQueryClient()
  return useQuery(serversQueryOptions(queryClient))
}

export const useServer = (id: ServerId) => {
  const queryClient = useQueryClient()
  return useQuery(serverQueryOptions(id, queryClient))
}

export const useServerHealth = (id: ServerId) => {
  const queryClient = useQueryClient()
  const [visibility, setVisibility] = useState<DocumentVisibilityState>(() => document.visibilityState)

  useEffect(() => {
    const update = () => setVisibility(document.visibilityState)
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])

  return useQuery({
    ...serverHealthQueryOptions(id, queryClient),
    refetchInterval: serverHealthRefetchInterval(visibility)
  })
}

export const useServerLibraries = (id: ServerId, enabled = true) => {
  const queryClient = useQueryClient()
  return useQuery({ ...serverLibrariesQueryOptions(id, queryClient), enabled })
}

export const useCreateServer = () => {
  const queryClient = useQueryClient()
  return useMutation({ mutationFn: (input: ServerInput) => createServer(input, queryClient) })
}

export const useUpdateServer = (id: ServerId) => {
  const queryClient = useQueryClient()
  return useMutation({ mutationFn: (input: ServerInput) => updateServer(id, input, queryClient) })
}

export const useDeleteServer = (id: ServerId) => {
  const queryClient = useQueryClient()
  return useMutation({ mutationFn: () => deleteServer(id, queryClient) })
}

export const useTestServerConnection = (id: ServerId) => {
  const queryClient = useQueryClient()
  return useMutation({ mutationFn: () => testServerConnection(id, queryClient) })
}
