import { useEffect, useState } from "react";
import { GridReveal } from "@/components/ui/grid-reveal";
import type { VirtualLibraryView } from "@oh-my-emby/contracts";
import { ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";
import type { LibraryCoverPhase } from "../covers/coordinator";
export function LibraryCover({
  library,
  state = "idle",
  onGenerate,
}: {
  readonly library: VirtualLibraryView;
  readonly state?: LibraryCoverPhase;
  readonly onGenerate?: () => void;
}) {
  const busy = state !== "idle" && state !== "error";
  const [revealing, setRevealing] = useState(false);
  useEffect(() => {
    if (busy) setRevealing(true);
    else if (state === "error") setRevealing(false);
  }, [busy, state]);
  const imageUrl = library.cover
    ? `/api/dashboard/libraries/${encodeURIComponent(library.id)}/cover?tag=${library.cover.revision}`
    : null;
  return (
    <div className="space-y-3">
      <div className="bg-muted relative aspect-video overflow-hidden rounded-md">
        {library.cover ? (
          <img className="size-full object-cover" src={imageUrl!} alt={library.name} />
        ) : (
          <div className="text-muted-foreground flex size-full items-center justify-center">
            <ImageIcon className="size-10" aria-label={m.library_cover_missing()} />
          </div>
        )}
        {(busy || revealing) && state !== "error" && (
          <div
            className="bg-muted absolute inset-0"
            role="status"
            aria-label={m.library_cover_generating()}
          >
            <GridReveal
              src={busy ? null : imageUrl}
              alt={library.name}
              aspect={16 / 9}
              caption={m.library_cover_generating()}
              estimatedDuration={8000}
              onRevealComplete={() => setRevealing(false)}
              onError={() => setRevealing(false)}
            />
          </div>
        )}
      </div>
      {state === "error" && (
        <p role="alert" className="text-destructive text-sm">
          {m.library_cover_failed()}
        </p>
      )}
      {onGenerate && (
        <Button
          type="button"
          variant="outline"
          disabled={busy || !library.enabled}
          onClick={onGenerate}
        >
          {busy ? m.library_cover_generating() : m.library_cover_regenerate()}
        </Button>
      )}
    </div>
  );
}
