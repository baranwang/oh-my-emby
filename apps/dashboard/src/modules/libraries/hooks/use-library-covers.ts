import type { VirtualLibraryView } from "@oh-my-emby/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LibraryCoverCoordinator } from "../covers/coordinator";
import { generateLibraryCover } from "../services/library-cover-service";
export function useLibraryCovers(libraries: ReadonlyArray<VirtualLibraryView>) {
  const queryClient = useQueryClient();
  const [coordinator] = useState(
    () =>
      new LibraryCoverCoordinator((id, signal, onPhase) =>
        generateLibraryCover(id, queryClient, signal, onPhase),
      ),
  );
  const phases = useSyncExternalStore(
    coordinator.subscribe,
    coordinator.getSnapshot,
    coordinator.getSnapshot,
  );
  const lifecycle = useRef(0);
  useEffect(() => {
    const epoch = ++lifecycle.current;
    return () => {
      queueMicrotask(() => {
        if (lifecycle.current === epoch) coordinator.cancel();
      });
    };
  }, [coordinator]);
  useEffect(() => {
    for (const library of libraries)
      if (library.enabled && (!library.cover || library.cover.stale))
        coordinator.enqueue(library.id, "automatic");
  }, [coordinator, libraries]);
  return { phases, regenerate: (id: string) => coordinator.enqueue(id, "manual") };
}
