import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { useLibraryCovers } from "../src/modules/libraries/hooks/use-library-covers";
const generate = vi.hoisted(() => vi.fn());
vi.mock("../src/modules/libraries/services/library-cover-service", () => ({
  generateLibraryCover: generate,
}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => generate.mockReset());
it("survives StrictMode replay, skips disabled libraries, aborts on close and retries on reopening", async () => {
  const signals: AbortSignal[] = [];
  generate.mockImplementation((_id, _client, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
  });
  const libraries = [
    { id: "active", enabled: true },
    { id: "disabled", enabled: false },
  ] as any;
  function Harness() {
    useLibraryCovers(libraries);
    return null;
  }
  const queryClient = new QueryClient();
  const render = () => (
    <QueryClientProvider client={queryClient}>
      <StrictMode>
        <Harness />
      </StrictMode>
    </QueryClientProvider>
  );
  const first = createRoot(document.createElement("div"));
  await act(async () => first.render(render()));
  expect(generate).toHaveBeenCalledTimes(1);
  expect(signals[0]?.aborted).toBe(false);
  await act(async () => first.unmount());
  expect(signals[0]?.aborted).toBe(true);
  const second = createRoot(document.createElement("div"));
  await act(async () => second.render(render()));
  expect(generate).toHaveBeenCalledTimes(2);
  expect(signals[1]?.aborted).toBe(false);
  await act(async () => second.unmount());
  queryClient.clear();
});
