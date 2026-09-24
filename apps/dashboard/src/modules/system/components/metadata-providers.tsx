import type { MetadataProviderSettingsInput, MetadataProviderSettingsView } from "@oh-my-emby/contracts"
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { useUpdateMetadataSettings } from "@/modules/system/hooks/use-system"
import { m } from "@/paraglide/messages.js"

type Provider = MetadataProviderSettingsView["providers"][number]

const inputProvider = (provider: Provider, order: number): MetadataProviderSettingsInput["providers"][number] => ({
  id: provider.id,
  enabled: provider.enabled,
  order,
  language: provider.language,
  credential: { _tag: "Preserve" }
})

const providerName = (id: Provider["id"]) => id === "tmdb" ? "TMDB" : "Trakt"

export const MetadataProviders = ({
  settings,
  onEdit
}: {
  readonly settings: MetadataProviderSettingsView
  readonly onEdit: (provider: Provider) => void
}) => {
  const update = useUpdateMetadataSettings()
  const providers = [...settings.providers].sort((left, right) => left.order - right.order)

  const move = async (index: number, target: number) => {
    const next = [...providers]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    try {
      await update.mutateAsync({
        providers: [inputProvider(next[0]!, 0), inputProvider(next[1]!, 1)]
      })
    } catch {
      // Mutation state renders the localized failure below.
    }
  }

  return (
    <ol className="divide-y">
      {providers.map((provider, index) => (
        <li key={provider.id} data-provider-row className="flex flex-wrap items-center gap-3 py-4 first:pt-0">
          <div className="min-w-36 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">{providerName(provider.id)}</h3>
              <Badge variant="outline">{provider.hasCredential ? m.metadata_configured() : m.metadata_not_configured()}</Badge>
              <Badge variant="secondary">{provider.enabled ? m.enabled() : m.disabled()}</Badge>
            </div>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={() => onEdit(provider)}>
            {m.settings()}
          </Button>
          <ButtonGroup>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label={m.metadata_move_up({ provider: providerName(provider.id) })}
              disabled={index === 0 || update.isPending}
              onClick={() => void move(index, index - 1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label={m.metadata_move_down({ provider: providerName(provider.id) })}
              disabled={index === providers.length - 1 || update.isPending}
              onClick={() => void move(index, index + 1)}
            >
              <ArrowDownIcon />
            </Button>
          </ButtonGroup>
        </li>
      ))}
      <li data-provider-row className="flex flex-wrap items-center gap-3 py-4">
        <div className="min-w-36 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium">{m.metadata_upstream_server()}</h3>
            <Badge variant="outline">{m.metadata_fallback()}</Badge>
            <Badge variant="secondary">{m.enabled()}</Badge>
          </div>
        </div>
      </li>
      {update.isError && <li role="alert" className="py-3 text-sm text-destructive">{m.metadata_save_failed()}</li>}
    </ol>
  )
}
