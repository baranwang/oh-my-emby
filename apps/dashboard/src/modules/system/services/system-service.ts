import type { QueryClient } from "@tanstack/react-query"
import { queryOptions } from "@tanstack/react-query"

import { apiClient } from "@/lib/api-client"
import { queryKeys } from "@/lib/query-keys"
import { runProtected } from "@/modules/auth/services/auth-service"

export const systemQueryOptions = (queryClient: QueryClient) => queryOptions({
  queryKey: queryKeys.system,
  queryFn: () => runProtected(apiClient.system.getSystemStatus(), queryClient)
})

export const outboxFailuresQueryOptions = (queryClient: QueryClient) => queryOptions({
  queryKey: queryKeys.outboxFailures,
  queryFn: () => runProtected(apiClient.system.listOutboxFailures(), queryClient)
})
