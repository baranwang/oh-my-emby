import type { ServerView } from "@oh-my-emby/contracts"
import { Link } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { m } from "@/paraglide/messages.js"

type ServerListProps = {
  readonly state: "pending" | "error" | "success"
  readonly servers: ReadonlyArray<ServerView>
  readonly onRetry: () => void
  readonly onCreate: () => void
}

const healthLabel = (health: ServerView["health"]) => health === "healthy"
  ? m.status_healthy()
  : health === "degraded" ? m.status_degraded() : m.status_unknown()

export const ServerList = ({ state, servers, onRetry, onCreate }: ServerListProps) => {
  if (state === "pending") {
    return (
      <div aria-label={m.servers_loading()} className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (state === "error") {
    return (
      <div role="alert" className="space-y-3 rounded-lg border border-destructive/40 p-4">
        <p className="text-sm text-destructive">{m.servers_load_failed()}</p>
        <Button type="button" variant="outline" onClick={onRetry}>{m.retry()}</Button>
      </div>
    )
  }

  if (servers.length === 0) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed p-6">
        <p className="text-sm text-muted-foreground">{m.servers_empty()}</p>
        <Button type="button" onClick={onCreate}>{m.add_server()}</Button>
      </div>
    )
  }

  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {servers.map((server) => (
        <li key={server.id} className="rounded-lg border bg-card p-4 text-card-foreground">
          <Link
            className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            to="/servers/$id"
            params={{ id: server.id }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="truncate font-medium">{server.name}</h2>
                <p className="truncate text-sm text-muted-foreground">{server.baseUrl}</p>
              </div>
              <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-xs">
                {healthLabel(server.health)}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}
