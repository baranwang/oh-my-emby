import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { LibraryForm } from "@/modules/libraries/components/library-form"
import { LibraryList } from "@/modules/libraries/components/library-list"
import { useCreateLibrary, useLibraries, useSourceLibraryGroups } from "@/modules/libraries/hooks/use-libraries"
import { useServers } from "@/modules/servers/hooks/use-servers"
import { m } from "@/paraglide/messages.js"

type LibrariesPageProps = {
  readonly creating: boolean
  readonly onAddServer: () => void
  readonly onCreatingChange: (creating: boolean) => void
}

export const LibrariesPage = ({ creating, onAddServer, onCreatingChange }: LibrariesPageProps) => {
  const libraries = useLibraries()
  const servers = useServers()
  const groups = useSourceLibraryGroups(servers.data ?? [], creating)
  const create = useCreateLibrary()

  return (
    <div className="max-w-5xl space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="font-heading text-2xl font-medium">{m.libraries()}</h1>
          <p className="max-w-prose text-sm leading-6 text-muted-foreground">{m.libraries_description()}</p>
        </div>
        {!creating && libraries.data?.length !== 0 && <Button onClick={() => onCreatingChange(true)}>{m.add_library()}</Button>}
      </header>
      {creating && (
        <section className="space-y-4 rounded-lg border p-5" aria-labelledby="library-create-title">
          <div className="flex items-center justify-between gap-4">
            <h2 id="library-create-title" className="font-heading text-xl font-medium">{m.library_create_title()}</h2>
            <Button variant="ghost" onClick={() => onCreatingChange(false)}>{m.cancel()}</Button>
          </div>
          {servers.isPending ? (
            <Skeleton aria-label={m.servers_loading()} className="h-24 w-full" />
          ) : servers.isError || !servers.data ? (
            <div role="alert" className="space-y-2">
              <p className="text-sm text-destructive">{m.servers_load_failed()}</p>
              <Button type="button" variant="outline" onClick={() => void servers.refetch()}>{m.retry()}</Button>
            </div>
          ) : servers.data.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{m.servers_empty()}</p>
              <Button type="button" onClick={onAddServer}>{m.add_server()}</Button>
            </div>
          ) : (
            <LibraryForm
              groups={groups}
              onSave={async (input) => {
                await create.mutateAsync(input)
                onCreatingChange(false)
              }}
            />
          )}
        </section>
      )}
      <LibraryList
        state={libraries.isPending ? "pending" : libraries.isError ? "error" : "success"}
        libraries={libraries.data ?? []}
        onRetry={() => void libraries.refetch()}
        onCreate={() => onCreatingChange(true)}
      />
    </div>
  )
}
