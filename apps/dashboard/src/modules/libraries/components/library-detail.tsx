import type { VirtualLibraryView } from "@oh-my-emby/contracts"
import { useNavigate } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { LibraryForm } from "@/modules/libraries/components/library-form"
import {
  useDeleteLibrary,
  useLibrary,
  useSourceLibraryGroups,
  useUpdateLibrary
} from "@/modules/libraries/hooks/use-libraries"
import { useServers } from "@/modules/servers/hooks/use-servers"
import { m } from "@/paraglide/messages.js"

type LibraryId = VirtualLibraryView["id"]

export const LibraryDetailPage = ({ id }: { readonly id: LibraryId }) => {
  const navigate = useNavigate()
  const library = useLibrary(id)
  const servers = useServers()
  const groups = useSourceLibraryGroups(servers.data ?? [])
  const update = useUpdateLibrary(id)
  const remove = useDeleteLibrary(id)

  if (library.isPending || servers.isPending) {
    return <div aria-label={m.loading()} className="max-w-3xl space-y-4"><Skeleton className="h-10 w-52" /><Skeleton className="h-96" /></div>
  }
  if (library.isError || servers.isError || !library.data) {
    return (
      <div role="alert" className="max-w-3xl space-y-3 rounded-lg border border-destructive/40 p-4">
        <p className="text-sm text-destructive">{m.libraries_load_failed()}</p>
        <Button variant="outline" onClick={() => { void library.refetch(); void servers.refetch() }}>{m.retry()}</Button>
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-heading text-2xl font-medium">{library.data.name}</h1>
        <p className="text-sm text-muted-foreground">{library.data.mediaType === "movies" ? m.media_movies() : m.media_series()}</p>
      </header>
      <section className="space-y-4 rounded-lg border p-5" aria-labelledby="library-edit-title">
        <h2 id="library-edit-title" className="font-heading text-xl font-medium">{m.library_edit_title()}</h2>
        <LibraryForm
          library={library.data}
          groups={groups}
          onSave={(input) => update.mutateAsync(input).then(() => undefined)}
        />
      </section>
      <section className="border-t pt-6">
        <Button
          variant="destructive"
          disabled={remove.isPending}
          onClick={async () => {
            if (!window.confirm(m.library_delete_confirm())) return
            try {
              await remove.mutateAsync()
              await navigate({ to: "/libraries", search: { new: false } })
            } catch {
              // Mutation state renders the localized failure below.
            }
          }}
        >
          {remove.isPending ? m.deleting() : m.delete()}
        </Button>
        {remove.isError && <p role="alert" className="mt-2 text-sm text-destructive">{m.library_delete_failed()}</p>}
      </section>
    </div>
  )
}
