import type { ServerView } from "@oh-my-emby/contracts"
import { Link } from "@tanstack/react-router"
import { ArrowRightIcon, PlusIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
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

const policyLabel = (policy: ServerView["userAgentPolicy"]) => policy === "fixed"
  ? m.server_user_agent_fixed()
  : policy === "client-preferred" ? m.server_user_agent_client_preferred() : m.server_user_agent_passthrough()

export const ServerList = ({ state, servers, onRetry, onCreate }: ServerListProps) => {
  if (state === "pending") {
    return (
      <div aria-label={m.servers_loading()} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="h-52 w-full" />
        <Skeleton className="h-52 w-full" />
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

  return (
    <ul className="grid auto-rows-fr items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
      {servers.map((server) => (
        <li key={server.id}>
          <Card className="h-full min-h-52">
            <CardHeader>
              <CardTitle><span className="block truncate">{server.name}</span></CardTitle>
              <CardDescription><span className="block truncate">{server.endpoints[0]?.displayUrl}</span></CardDescription>
              <CardAction>
                <Badge variant={server.health === "healthy" ? "secondary" : server.health === "degraded" ? "destructive" : "outline"}>
                  {healthLabel(server.health)}
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="mt-auto">
              <dl className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">{m.server_endpoints()}</dt>
                  <dd>{m.server_endpoint_count({ count: server.endpoints.length })}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-muted-foreground">{m.server_catalog()}</dt>
                  <dd className="max-w-44 truncate">{server.verifiedCatalogId ?? m.server_catalog_unverified()}</dd>
                </div>
              </dl>
            </CardContent>
            <CardFooter>
              <div className="flex w-full items-center justify-between gap-3">
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {server.username} · {policyLabel(server.userAgentPolicy)}
                </span>
                <Button
                  nativeButton={false}
                  render={<Link to="/servers/$id" params={{ id: server.id }} />}
                  size="sm"
                  variant="outline"
                >
                  <span className="sr-only">{m.server_edit_action({ name: server.name })}</span>
                  <span aria-hidden="true">{m.server_edit_title()}</span>
                  <ArrowRightIcon />
                </Button>
              </div>
            </CardFooter>
          </Card>
        </li>
      ))}
      <li>
        <Button
          type="button"
          variant="outline"
          className="h-full min-h-52 w-full flex-col whitespace-normal"
          onClick={onCreate}
        >
          <PlusIcon />
          <span>{m.add_server()}</span>
          {servers.length === 0 && (
            <span className="max-w-xs text-balance text-xs font-normal text-muted-foreground">{m.servers_empty()}</span>
          )}
        </Button>
      </li>
    </ul>
  )
}
