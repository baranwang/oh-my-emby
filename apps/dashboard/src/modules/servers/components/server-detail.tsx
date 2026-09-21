import { useEffect, useState } from "react"
import type { ServerHealthView, SourceLibraryView } from "@oh-my-emby/contracts"
import { useNavigate } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ServerForm } from "@/modules/servers/components/server-form"
import {
  useDeleteServer,
  useServer,
  useServerHealth,
  useServerLibraries,
  useTestServerConnection,
  useUpdateServer
} from "@/modules/servers/hooks/use-servers"
import { m } from "@/paraglide/messages.js"

const STALE_HEALTH_MS = 60_000

const healthLabel = (health: ServerHealthView["health"]) => health === "healthy"
  ? m.status_healthy()
  : health === "degraded" ? m.status_degraded() : m.status_unknown()

export const ServerHealthStatus = ({
  health,
  nowMs
}: {
  readonly health: ServerHealthView
  readonly nowMs?: number
}) => {
  const [currentNowMs, setCurrentNowMs] = useState(() => nowMs ?? Date.now())
  const effectiveNowMs = nowMs ?? currentNowMs

  useEffect(() => {
    if (nowMs !== undefined || health.lastSuccessAtMs === null) return
    const delay = health.lastSuccessAtMs + STALE_HEALTH_MS + 1 - Date.now()
    if (delay <= 0) return
    const timeoutId = window.setTimeout(() => setCurrentNowMs(Date.now()), delay)
    return () => window.clearTimeout(timeoutId)
  }, [health.lastSuccessAtMs, nowMs])

  const freshness = health.lastSuccessAtMs === null
    ? m.health_missing()
    : effectiveNowMs - health.lastSuccessAtMs > STALE_HEALTH_MS ? m.health_stale() : m.health_current()

  return (
    <div className="space-y-2 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-medium">{m.server_health()}</h2>
        <span className="rounded-md bg-muted px-2 py-1 text-xs">{healthLabel(health.health)}</span>
      </div>
      <p className="text-sm text-muted-foreground">{freshness}</p>
      {health.lastSuccessAtMs !== null && (
        <p className="text-sm text-muted-foreground">
          {m.last_success()}: {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(health.lastSuccessAtMs)}
        </p>
      )}
    </div>
  )
}

const SourceLibraries = ({ sources }: { readonly sources: ReadonlyArray<SourceLibraryView> }) => (
  <section className="space-y-3" aria-labelledby="source-libraries-title">
    <h2 id="source-libraries-title" className="font-heading text-xl font-medium">{m.source_libraries()}</h2>
    {sources.length === 0 ? (
      <p className="text-sm text-muted-foreground">{m.source_libraries_empty()}</p>
    ) : (
      <ul className="grid gap-2 sm:grid-cols-2">
        {sources.map((source) => (
          <li key={source.id} className="rounded-lg border px-3 py-2">
            <p className="font-medium">{source.name}</p>
            <p className="text-sm text-muted-foreground">
              {source.mediaType === "movies" ? m.media_movies() : m.media_series()}
            </p>
          </li>
        ))}
      </ul>
    )}
  </section>
)

export const ServerDetailPage = ({ id }: { readonly id: Parameters<typeof useServer>[0] }) => {
  const navigate = useNavigate()
  const server = useServer(id)
  const health = useServerHealth(id)
  const update = useUpdateServer(id)
  const remove = useDeleteServer(id)
  const connection = useTestServerConnection(id)
  const eligible = server.data?.enabled === true && server.data.health === "healthy"
  const sources = useServerLibraries(id, eligible)

  if (server.isPending) {
    return <div aria-label={m.loading()} className="max-w-3xl space-y-4"><Skeleton className="h-10 w-52" /><Skeleton className="h-96 w-full" /></div>
  }
  if (server.isError || !server.data) {
    return (
      <div role="alert" className="max-w-3xl space-y-3 rounded-lg border border-destructive/40 p-4">
        <p className="text-sm text-destructive">{m.servers_load_failed()}</p>
        <Button variant="outline" onClick={() => void server.refetch()}>{m.retry()}</Button>
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-heading text-2xl font-medium">{server.data.name}</h1>
        <p className="text-sm text-muted-foreground">
          {m.server_catalog()}: {server.data.verifiedCatalogId ?? m.server_catalog_unverified()}
        </p>
      </header>
      {health.isPending ? (
        <Skeleton aria-label={m.server_health_loading()} className="h-28 w-full" />
      ) : health.isError || !health.data ? (
        <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 p-4">
          <p className="text-sm text-destructive">{m.server_health_failed()}</p>
          <Button variant="outline" onClick={() => void health.refetch()}>{m.retry()}</Button>
        </div>
      ) : <ServerHealthStatus health={health.data} />}
      <section className="space-y-4 rounded-lg border p-5" aria-labelledby="server-edit-title">
        <h2 id="server-edit-title" className="font-heading text-xl font-medium">{m.server_edit_title()}</h2>
        <ServerForm
          server={server.data}
          onSave={(input) => update.mutateAsync(input).then(() => undefined)}
          onTestConnection={() => connection.mutateAsync()}
        />
      </section>
      {!eligible ? (
        <p className="rounded-lg border p-4 text-sm text-muted-foreground">{m.source_libraries_unavailable()}</p>
      ) : sources.isPending ? (
        <Skeleton aria-label={m.source_libraries_loading()} className="h-24 w-full" />
      ) : sources.isError ? (
        <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 p-4">
          <p className="text-sm text-destructive">{m.source_libraries_failed()}</p>
          <Button variant="outline" onClick={() => void sources.refetch()}>{m.retry()}</Button>
        </div>
      ) : <SourceLibraries sources={sources.data ?? []} />}
      <section className="border-t pt-6">
        <Button
          variant="destructive"
          disabled={remove.isPending}
          onClick={async () => {
            if (!window.confirm(m.server_delete_confirm())) return
            try {
              await remove.mutateAsync()
              await navigate({ to: "/servers", search: { new: false } })
            } catch {
              // Mutation state renders the localized failure below.
            }
          }}
        >
          {remove.isPending ? m.deleting() : m.delete()}
        </Button>
        {remove.isError && <p role="alert" className="mt-2 text-sm text-destructive">{m.server_delete_failed()}</p>}
      </section>
    </div>
  )
}
