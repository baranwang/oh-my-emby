import { LibraryCover } from "./library-cover";
import type { LibraryCoverPhase } from "../covers/coordinator";
import type { VirtualLibraryView } from "@oh-my-emby/contracts";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages.js";

type LibraryListProps = {
  readonly state: "pending" | "error" | "success";
  readonly libraries: ReadonlyArray<VirtualLibraryView>;
  readonly coverPhases?: Readonly<Record<string, LibraryCoverPhase>>;
  readonly onRetry: () => void;
  readonly onCreate: () => void;
};

export const LibraryList = ({
  state,
  libraries,
  onRetry,
  onCreate,
  coverPhases,
}: LibraryListProps) => {
  if (state === "pending") {
    return (
      <div aria-label={m.libraries_loading()} className="space-y-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (state === "error") {
    return (
      <div role="alert" className="border-destructive/40 space-y-3 rounded-lg border p-4">
        <p className="text-destructive text-sm">{m.libraries_load_failed()}</p>
        <Button variant="outline" onClick={onRetry}>
          {m.retry()}
        </Button>
      </div>
    );
  }
  if (libraries.length === 0) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed p-6">
        <p className="text-muted-foreground text-sm">{m.libraries_empty()}</p>
        <Button onClick={onCreate}>{m.add_library()}</Button>
      </div>
    );
  }
  return (
    <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
      {libraries.map((library) => (
        <li key={library.id} className="min-w-0">
          <Link
            className="focus-visible:ring-ring block h-full rounded-lg outline-none focus-visible:ring-2"
            to="/libraries/$id"
            params={{ id: library.id }}
          >
            {/* oxlint-disable-next-line shadcn/no-restyle -- Match the user-provided CardImage demo's flush cover. */}
            <Card className="h-full pt-0">
              <LibraryCover
                library={library}
                state={coverPhases?.[library.id] ?? "idle"}
                imageClassName="rounded-none"
              />
              <CardHeader>
                <CardAction>
                  <Badge variant="secondary">{library.enabled ? m.enabled() : m.disabled()}</Badge>
                </CardAction>
                <CardTitle className="min-w-0 break-words">
                  <h2>{library.name}</h2>
                </CardTitle>
                <CardDescription>
                  {library.mediaType === "movies" ? m.media_movies() : m.media_series()}
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
};
