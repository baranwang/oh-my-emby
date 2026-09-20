import { useQuery, useQueryClient } from "@tanstack/react-query"

import {
  outboxFailuresQueryOptions,
  systemQueryOptions
} from "@/modules/system/services/system-service"

export const useSystemStatus = () => {
  const queryClient = useQueryClient()
  return useQuery(systemQueryOptions(queryClient))
}

export const useOutboxFailures = () => {
  const queryClient = useQueryClient()
  return useQuery(outboxFailuresQueryOptions(queryClient))
}
