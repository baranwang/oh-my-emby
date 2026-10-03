export type LibraryCoverPhase = "idle" | "preparing" | "rendering" | "uploading" | "error";
export class LibraryCoverCoordinator {
  private queue: string[] = [];
  private attempted = new Set<string>();
  private listeners = new Set<() => void>();
  private phases: Readonly<Record<string, LibraryCoverPhase>> = {};
  private active: AbortController | null = null;
  private running = false;
  constructor(
    private readonly generate: (
      id: string,
      signal: AbortSignal,
      onPhase: (phase: LibraryCoverPhase) => void,
    ) => Promise<unknown>,
  ) {}
  getSnapshot = () => this.phases;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private setPhase(id: string, phase: LibraryCoverPhase) {
    this.phases = { ...this.phases, [id]: phase };
    for (const listener of this.listeners) listener();
  }
  enqueue(id: string, mode: "automatic" | "manual") {
    if (mode === "automatic" && this.attempted.has(id)) return;
    if (
      this.queue.includes(id) ||
      ["preparing", "rendering", "uploading"].includes(this.phases[id] ?? "idle")
    )
      return;
    this.attempted.add(id);
    this.queue.push(id);
    void this.drain();
  }
  cancel() {
    this.queue = [];
    this.active?.abort();
  }
  private async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!,
          controller = new AbortController();
        this.active = controller;
        this.setPhase(id, "preparing");
        try {
          await this.generate(id, controller.signal, (p) => this.setPhase(id, p));
          this.setPhase(id, "idle");
        } catch {
          this.setPhase(id, controller.signal.aborted ? "idle" : "error");
        } finally {
          this.active = null;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
