import type { MetadataProviderSettingsInput } from "@oh-my-emby/contracts"
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

export const metadataSettingsQueryOptions = (queryClient: QueryClient) => queryOptions({
  queryKey: queryKeys.metadataSettings,
  queryFn: () => runProtected(apiClient.system.getMetadataSettings(), queryClient)
})

export const updateMetadataSettings = async (
  input: MetadataProviderSettingsInput,
  queryClient: QueryClient
) => {
  const saved = await runProtected(apiClient.system.updateMetadataSettings({ payload: input }), queryClient)
  await queryClient.invalidateQueries({ queryKey: queryKeys.metadataSettings, exact: true })
  return saved
}
