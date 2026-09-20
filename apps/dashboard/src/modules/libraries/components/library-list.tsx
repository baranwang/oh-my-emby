import type { VirtualLibraryView } from "@oh-my-emby/contracts"
import { Link } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { m } from "@/paraglide/messages.js"

type LibraryListProps = {
  readonly state: "pending" | "error" | "success"
  readonly libraries: ReadonlyArray<VirtualLibraryView>
  readonly onRetry: () => void
  readonly onCreate: () => void
}

export const LibraryList = ({ state, libraries, onRetry, onCreate }: LibraryListProps) => {
  if (state === "pending") {
    return <div aria-label={m.libraries_loading()} className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
  }
  if (state === "error") {
    return (
      <div role="alert" className="space-y-3 rounded-lg border border-destructive/40 p-4">
        <p className="text-sm text-destructive">{m.libraries_load_failed()}</p>
        <Button variant="outline" onClick={onRetry}>{m.retry()}</Button>
      </div>
    )
  }
  if (libraries.length === 0) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed p-6">
        <p className="text-sm text-muted-foreground">{m.libraries_empty()}</p>
        <Button onClick={onCreate}>{m.add_library()}</Button>
      </div>
    )
  }
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {libraries.map((library) => (
        <li key={library.id} className="rounded-lg border bg-card p-4 text-card-foreground">
          <Link className="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" to="/libraries/$id" params={{ id: library.id }}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-medium">{library.name}</h2>
                <p className="text-sm text-muted-foreground">{library.mediaType === "movies" ? m.media_movies() : m.media_series()}</p>
              </div>
              <span className="rounded-md bg-muted px-2 py-1 text-xs">{library.enabled ? m.enabled() : m.disabled()}</span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}
