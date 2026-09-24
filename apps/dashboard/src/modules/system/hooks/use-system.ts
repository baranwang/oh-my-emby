import type { MetadataProviderSettingsInput } from "@oh-my-emby/contracts"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import {
  outboxFailuresQueryOptions,
  metadataSettingsQueryOptions,
  systemQueryOptions,
  updateMetadataSettings
} from "@/modules/system/services/system-service"

export const useSystemStatus = () => {
  const queryClient = useQueryClient()
  return useQuery(systemQueryOptions(queryClient))
}

export const useOutboxFailures = () => {
  const queryClient = useQueryClient()
  return useQuery(outboxFailuresQueryOptions(queryClient))
}

export const useMetadataSettings = () => {
  const queryClient = useQueryClient()
  return useQuery(metadataSettingsQueryOptions(queryClient))
}

export const useUpdateMetadataSettings = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: MetadataProviderSettingsInput) => updateMetadataSettings(input, queryClient)
  })
}
