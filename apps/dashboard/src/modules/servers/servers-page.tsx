import { Button } from "@/components/ui/button"
import { ServerForm } from "@/modules/servers/components/server-form"
import { ServerList } from "@/modules/servers/components/server-list"
import { useCreateServer, useServers } from "@/modules/servers/hooks/use-servers"
import { m } from "@/paraglide/messages.js"

type ServersPageProps = {
  readonly creating: boolean
  readonly onCreatingChange: (creating: boolean) => void
}

export const ServersPage = ({ creating, onCreatingChange }: ServersPageProps) => {
  const servers = useServers()
  const create = useCreateServer()

  return (
    <div className="max-w-5xl space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="font-heading text-2xl font-medium">{m.servers()}</h1>
          <p className="max-w-prose text-sm leading-6 text-muted-foreground">{m.servers_description()}</p>
        </div>
        {!creating && servers.data?.length !== 0 && (
          <Button onClick={() => onCreatingChange(true)}>{m.add_server()}</Button>
        )}
      </header>
      {creating && (
        <section className="space-y-4 rounded-lg border p-5" aria-labelledby="server-create-title">
          <div className="flex items-center justify-between gap-4">
            <h2 id="server-create-title" className="font-heading text-xl font-medium">{m.server_create_title()}</h2>
            <Button variant="ghost" onClick={() => onCreatingChange(false)}>{m.cancel()}</Button>
          </div>
          <ServerForm
            onSave={async (input) => {
              await create.mutateAsync(input)
              onCreatingChange(false)
            }}
          />
        </section>
      )}
      <ServerList
        state={servers.isPending ? "pending" : servers.isError ? "error" : "success"}
        servers={servers.data ?? []}
        onRetry={() => void servers.refetch()}
        onCreate={() => onCreatingChange(true)}
      />
    </div>
  )
}
