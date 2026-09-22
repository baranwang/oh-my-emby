import { useState } from "react"
import type { MetadataProviderSettingsView } from "@oh-my-emby/contracts"
import { CheckIcon, CopyIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle
} from "@/components/ui/drawer"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { MetadataProviderEditor } from "@/modules/system/components/metadata-provider-editor"
import { MetadataProviders } from "@/modules/system/components/metadata-providers"
import { OutboxFailures } from "@/modules/system/components/outbox-failures"
import { Preferences } from "@/modules/system/components/preferences"
import { SystemStatus } from "@/modules/system/components/system-status"
import { useMetadataSettings, useOutboxFailures, useSystemStatus } from "@/modules/system/hooks/use-system"
import { m } from "@/paraglide/messages.js"

type Provider = MetadataProviderSettingsView["providers"][number]

export const SystemPage = () => {
  const metadata = useMetadataSettings()
  const status = useSystemStatus()
  const failures = useOutboxFailures()
  const [provider, setProvider] = useState<Provider | null>(null)
  const [copied, setCopied] = useState(false)
  const endpoint = globalThis.location.origin
  const outboxNeedsAttention = (status.data?.outboxFailed ?? 0) > 0 || (status.data?.outboxUncertain ?? 0) > 0

  const copyEndpoint = async () => {
    if (!globalThis.navigator.clipboard) return
    try {
      await globalThis.navigator.clipboard.writeText(endpoint)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="max-w-5xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-heading text-2xl font-medium">{m.system()}</h1>
        <p className="max-w-prose text-sm leading-6 text-muted-foreground">{m.system_description()}</p>
      </header>

      <section className="space-y-4" aria-labelledby="metadata-providers-title">
        <h2 id="metadata-providers-title" className="font-heading text-xl font-medium">{m.metadata_providers_title()}</h2>
        {metadata.isPending ? (
          <Skeleton aria-label={m.metadata_loading()} className="h-36" />
        ) : metadata.isError || !metadata.data ? (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-destructive">{m.metadata_load_failed()}</p>
            <Button variant="outline" onClick={() => void metadata.refetch()}>{m.retry()}</Button>
          </div>
        ) : (
          <MetadataProviders settings={metadata.data} onEdit={setProvider} />
        )}
      </section>

      <Separator />

      <section className="space-y-4" aria-labelledby="client-endpoint-title">
        <h2 id="client-endpoint-title" className="font-heading text-xl font-medium">{m.client_endpoint_title()}</h2>
        <p className="text-sm text-muted-foreground">{m.client_endpoint_description()}</p>
        <div className="flex max-w-2xl gap-2">
          <Input aria-label={m.client_endpoint_title()} value={endpoint} readOnly />
          <Button type="button" variant="outline" onClick={() => void copyEndpoint()}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? m.copied() : m.copy()}
          </Button>
        </div>
      </section>

      <Separator />

      <section className="space-y-4" aria-labelledby="runtime-status-title">
        <h2 id="runtime-status-title" className="font-heading text-xl font-medium">{m.runtime_status_title()}</h2>
        {status.isPending ? (
          <Skeleton aria-label={m.system_status_loading()} className="h-48" />
        ) : status.isError || !status.data ? (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-destructive">{m.system_status_failed()}</p>
            <Button variant="outline" onClick={() => void status.refetch()}>{m.retry()}</Button>
          </div>
        ) : <SystemStatus status={status.data} />}
      </section>

      <Separator />

      <section className="space-y-4" aria-labelledby="preferences-title">
        <h2 id="preferences-title" className="font-heading text-xl font-medium">{m.preferences_title()}</h2>
        <Preferences />
      </section>

      <Separator />

      <section className="space-y-4" aria-labelledby="advanced-diagnostics-title">
        <h2 id="advanced-diagnostics-title" className="font-heading text-xl font-medium">{m.advanced_diagnostics_title()}</h2>
        <details open={outboxNeedsAttention}>
          <summary className="cursor-pointer rounded-md py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {m.outbox_failures_title()}
          </summary>
          <div className="pt-3">
            {failures.isPending ? (
              <Skeleton aria-label={m.outbox_failures_loading()} className="h-24" />
            ) : failures.isError ? (
              <div role="alert" className="space-y-2">
                <p className="text-sm text-destructive">{m.outbox_failures_load_failed()}</p>
                <Button variant="outline" onClick={() => void failures.refetch()}>{m.retry()}</Button>
              </div>
            ) : <OutboxFailures failures={failures.data ?? []} />}
          </div>
        </details>
      </section>

      <Drawer open={provider !== null} onOpenChange={(open) => { if (!open) setProvider(null) }} swipeDirection="right">
        <DrawerContent className="[--drawer-inset:--spacing(2)] data-[swipe-axis=x]:sm:[--drawer-content-width:32rem]">
          <DrawerHeader>
            <DrawerTitle>{provider?.id === "tmdb" ? m.metadata_tmdb_title() : m.metadata_trakt_title()}</DrawerTitle>
            <DrawerDescription>{m.metadata_editor_description()}</DrawerDescription>
          </DrawerHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              {provider && metadata.data && (
                <MetadataProviderEditor
                  key={provider.id}
                  provider={provider}
                  settings={metadata.data}
                  onClose={() => setProvider(null)}
                />
              )}
            </div>
          </ScrollArea>
        </DrawerContent>
      </Drawer>
    </div>
  )
}
