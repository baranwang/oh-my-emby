import { Effect } from "effect";
import { expect, it } from "vitest";
import { makeLibraryCoverRepositories } from "../src/core/library-cover-repositories.js";
it("batches every summary within D1's 100 bound-parameter limit", async () => {
  const lengths: number[] = [];
  const repo = makeLibraryCoverRepositories({
    unsafe: <A extends object>(_sql: string, params: ReadonlyArray<unknown> = []) => {
      lengths.push(params.length);
      if (params.length > 100) return Effect.fail(new Error("too many SQL variables"));
      return Effect.succeed(
        params.map((id) => ({
          library_id: id,
          revision: "r",
          template_version: "v1",
          config_digest: "{}",
          width: 1920,
          height: 1080,
          updated_at_ms: 1,
        })) as A[],
      );
    },
    batch: () => Effect.void,
  });
  expect(
    await Effect.runPromise(
      repo.listLibraryCoverSummaries(Array.from({ length: 201 }, (_, i) => String(i))),
    ),
  ).toHaveLength(201);
  expect(lengths).toEqual([100, 100, 1]);
});
