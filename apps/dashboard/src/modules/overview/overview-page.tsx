import type { ServerView, VirtualLibraryView } from "@oh-my-emby/contracts"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  LibraryIcon,
  ServerIcon
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { librariesQueryOptions } from "@/modules/libraries/services/library-service"
import { serversQueryOptions } from "@/modules/servers/services/server-service"
import {
  outboxFailuresQueryOptions,
  systemQueryOptions
} from "@/modules/system/services/system-service"
import { m } from "@/paraglide/messages.js"

const hasUsableSource = (
  library: VirtualLibraryView,
  servers: ReadonlyArray<ServerView>
) => library.sources.some((source) => {
  const server = servers.find(({ id }) => id === source.serverId)
  return source.enabled && server?.enabled === true && server.health === "healthy"
})

const ActionLink = ({
  children,
  to
}: {
  readonly children: React.ReactNode
  readonly to: "/servers" | "/libraries" | "/system"
}) => (
  <Button nativeButton={false} render={<Link to={to} />} variant="outline">
    {children}
  </Button>
)

export const OverviewPage = () => {
  const queryClient = useQueryClient()
  const servers = useQuery(serversQueryOptions(queryClient))
  const libraries = useQuery(librariesQueryOptions(queryClient))
  const system = useQuery(systemQueryOptions(queryClient))
  const failures = useQuery(outboxFailuresQueryOptions(queryClient))
  const queries = [servers, libraries, system, failures]

  if (queries.some(({ isPending }) => isPending)) {
    return (
      <div aria-label={m.overview_loading()} className="max-w-5xl space-y-6">
        <Skeleton className="h-16 max-w-xl" />
        <Skeleton className="h-40" />
      </div>
    )
  }

  if (queries.some(({ isError, data }) => isError || data === undefined)) {
    return (
      <div className="max-w-5xl space-y-8">
        <header className="space-y-2">
          <h1 className="font-heading text-2xl font-medium">{m.overview()}</h1>
          <p className="max-w-prose text-sm leading-6 text-muted-foreground">{m.overview_description()}</p>
        </header>
        <div role="alert" className="space-y-3 rounded-lg border border-destructive/40 p-4">
          <p className="text-sm text-destructive">{m.overview_load_failed()}</p>
          <Button variant="outline" onClick={() => void Promise.all(queries.map(({ refetch }) => refetch()))}>
            {m.retry()}
          </Button>
        </div>
      </div>
    )
  }

  const serverData = servers.data ?? []
  const libraryData = libraries.data ?? []
  const systemData = system.data!
  const failureData = failures.data ?? []

  if (serverData.length === 0) {
    return (
      <OverviewFrame>
        <SetupState
          icon={ServerIcon}
          title={m.overview_setup_server_title()}
          description={m.overview_setup_server_description()}
        >
          <Button nativeButton={false} render={<Link to="/servers" search={{ new: true }} />}>
            {m.add_server()}
          </Button>
        </SetupState>
      </OverviewFrame>
    )
  }

  if (libraryData.length === 0) {
    return (
      <OverviewFrame>
        <SetupState
          icon={LibraryIcon}
          title={m.overview_setup_library_title()}
          description={m.overview_setup_library_description()}
        >
          <Button nativeButton={false} render={<Link to="/libraries" search={{ new: true }} />}>
            {m.add_library()}
          </Button>
        </SetupState>
      </OverviewFrame>
    )
  }

  const serverExceptions = serverData.filter((server) => server.enabled && (
    server.health !== "healthy" || server.verifiedCatalogId === null
  ))
  const libraryExceptions = libraryData.filter((library) =>
    library.enabled && !hasUsableSource(library, serverData)
  )
  const hasSyncException = failureData.length > 0 || systemData.outboxFailed > 0 || systemData.outboxUncertain > 0

  if (serverExceptions.length === 0 && libraryExceptions.length === 0 && !hasSyncException) {
    return (
      <OverviewFrame>
        <section className="flex max-w-3xl flex-col gap-5 rounded-xl border p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <CheckCircle2Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
            <div>
              <h2 className="font-medium">{m.overview_healthy_title()}</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{m.overview_healthy_description()}</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <ActionLink to="/servers">{m.servers()}</ActionLink>
            <ActionLink to="/libraries">{m.libraries()}</ActionLink>
          </div>
        </section>
      </OverviewFrame>
    )
  }

  return (
    <OverviewFrame>
      <section className="space-y-4" aria-labelledby="overview-attention-title">
        <div className="flex gap-3">
          <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <div>
            <h2 id="overview-attention-title" className="font-heading text-xl font-medium">
              {m.overview_attention_title()}
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{m.overview_attention_description()}</p>
          </div>
        </div>
        <ul className="divide-y rounded-xl border">
          {serverExceptions.map((server) => (
            <li key={server.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate font-medium">{server.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">{m.overview_server_attention_title()}</p>
              </div>
              <Badge variant="destructive">
                {server.verifiedCatalogId === null ? m.overview_server_unverified() : server.health === "degraded"
                  ? m.status_degraded()
                  : m.status_unknown()}
              </Badge>
              <Button nativeButton={false} render={<Link to="/servers/$id" params={{ id: server.id }} />} variant="outline">
                {m.servers()}
              </Button>
            </li>
          ))}
          {libraryExceptions.map((library) => (
            <li key={library.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate font-medium">{library.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">{m.overview_library_attention_title()}</p>
              </div>
              <Button nativeButton={false} render={<Link to="/libraries/$id" params={{ id: library.id }} />} variant="outline">
                {m.libraries()}
              </Button>
            </li>
          ))}
          {hasSyncException && (
            <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium">{m.overview_sync_attention_title()}</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{m.overview_sync_attention_description()}</p>
              </div>
              <ActionLink to="/system">{m.system()}</ActionLink>
            </li>
          )}
        </ul>
      </section>
    </OverviewFrame>
  )
}

const OverviewFrame = ({ children }: { readonly children: React.ReactNode }) => (
  <div className="max-w-5xl space-y-8">
    <header className="space-y-2">
      <h1 className="font-heading text-2xl font-medium">{m.overview()}</h1>
      <p className="max-w-prose text-sm leading-6 text-muted-foreground">{m.overview_description()}</p>
    </header>
    {children}
  </div>
)

const SetupState = ({
  children,
  description,
  icon: Icon,
  title
}: {
  readonly children: React.ReactNode
  readonly description: string
  readonly icon: typeof ServerIcon
  readonly title: string
}) => (
  <section className="max-w-3xl space-y-5 rounded-xl border border-dashed p-6">
    <div className="flex gap-3">
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
    </div>
    {children}
  </section>
)
