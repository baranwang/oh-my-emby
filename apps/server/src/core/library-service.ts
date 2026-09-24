import type { VirtualLibraryInput, VirtualLibraryView } from "@oh-my-emby/contracts"
import { Context, Effect, Layer } from "effect"

import {
  LibraryNotFound,
  LibraryValidationFailed,
  type RepositoryError,
  type UpstreamFailure
} from "./errors.js"
import { MAX_CONFIGURED_UPSTREAMS } from "./limits.js"
import type { LibrarySource, ServerEligibilityFence, VirtualLibrary } from "./model.js"
import { Repositories } from "./repositories.js"
import { UpstreamClient, type SourceLibrary } from "./upstream-client.js"

export interface LibraryServiceApi {
  readonly list: () => Effect.Effect<ReadonlyArray<VirtualLibraryView>, RepositoryError>
  readonly get: (
    libraryId: string
  ) => Effect.Effect<VirtualLibraryView, LibraryNotFound | RepositoryError>
  readonly create: (
    input: VirtualLibraryInput
  ) => Effect.Effect<VirtualLibraryView, LibraryValidationFailed | RepositoryError | UpstreamFailure>
  readonly update: (
    libraryId: string,
    input: VirtualLibraryInput
  ) => Effect.Effect<VirtualLibraryView, LibraryNotFound | LibraryValidationFailed | RepositoryError | UpstreamFailure>
  readonly delete: (
    libraryId: string
  ) => Effect.Effect<void, LibraryNotFound | RepositoryError>
  readonly isSourceEligible: (
    serverId: string,
    sourceLibraryId: string
  ) => Effect.Effect<boolean, RepositoryError>
}

export class LibraryService extends Context.Service<LibraryService, LibraryServiceApi>()(
  "oh-my-emby/LibraryService"
) {}

const toView = (library: VirtualLibrary): VirtualLibraryView => ({
  id: library.id,
  name: library.name,
  mediaType: library.mediaType,
  enabled: library.enabled,
  sources: library.sources.map(({ serverId, sourceLibraryId, sourceLibraryName, enabled }) => ({
    serverId,
    sourceLibraryId,
    sourceLibraryName,
    enabled
  }))
})

export const makeLibraryServiceLayer: Layer.Layer<LibraryService, never, Repositories | UpstreamClient> =
  Layer.effect(LibraryService, Effect.gen(function*() {
    const repositories = yield* Repositories
    const upstream = yield* UpstreamClient

    const records = () => repositories.listVirtualLibraries()
    const getRecord = (libraryId: string) => records().pipe(Effect.flatMap((libraries) => {
      const library = libraries.find((item) => item.id === libraryId)
      return library === undefined
        ? Effect.fail(new LibraryNotFound({ libraryId }))
        : Effect.succeed(library)
    }))

    const list: LibraryServiceApi["list"] = () => records().pipe(
      Effect.map((libraries) => libraries.map(toView))
    )

    const get: LibraryServiceApi["get"] = (libraryId) => getRecord(libraryId).pipe(Effect.map(toView))

    const validateSources = (
      input: VirtualLibraryInput
    ): Effect.Effect<{
      readonly sources: ReadonlyArray<LibrarySource>
      readonly serverFences: ReadonlyArray<ServerEligibilityFence>
    }, LibraryValidationFailed | RepositoryError | UpstreamFailure> =>
      Effect.gen(function*() {
        if (input.sources.length === 0 || !input.sources.some((source) => source.enabled)) {
          return yield* Effect.fail(new LibraryValidationFailed({ field: "sources" }))
        }
        const keys = new Set<string>()
        for (const source of input.sources) {
          const key = `${source.serverId}\0${source.sourceLibraryId}`
          if (keys.has(key)) return yield* Effect.fail(new LibraryValidationFailed({ field: "sources" }))
          keys.add(key)
        }
        const serverIds = [...new Set(input.sources.map((source) => source.serverId))]
        if (serverIds.length > MAX_CONFIGURED_UPSTREAMS) {
          return yield* Effect.fail(new LibraryValidationFailed({ field: "sources" }))
        }
        const servers = yield* repositories.listServers()
        const discovered = new Map<string, SourceLibrary>()
        const serverFences: Array<ServerEligibilityFence> = []
        for (const serverId of serverIds) {
          const server = servers.find((item) => item.id === serverId)
          if (
            server === undefined || !server.enabled || server.health !== "healthy" || server.verifiedBaseUrl === null
          ) return yield* Effect.fail(new LibraryValidationFailed({ field: "sources" }))
          serverFences.push({ serverId: server.id, generation: server.generation })
          for (const source of yield* upstream.listSourceLibraries(serverId)) {
            discovered.set(`${serverId}\0${source.id}`, source)
          }
        }
        const sources: Array<LibrarySource> = []
        for (const [sourceOrder, binding] of input.sources.entries()) {
          const source = discovered.get(`${binding.serverId}\0${binding.sourceLibraryId}`)
          if (source === undefined || source.mediaType !== input.mediaType) {
            return yield* Effect.fail(new LibraryValidationFailed({ field: "sources" }))
          }
          sources.push({
            serverId: binding.serverId,
            sourceLibraryId: binding.sourceLibraryId,
            sourceLibraryName: source.name,
            mediaType: source.mediaType,
            sourceOrder,
            enabled: binding.enabled
          })
        }
        return { sources, serverFences }
      })

    const save = (
      id: VirtualLibraryView["id"],
      createdAtMs: number,
      input: VirtualLibraryInput
    ) => Effect.gen(function*() {
      const validated = yield* validateSources(input)
      const saved = yield* repositories.saveVirtualLibrary({
        id,
        name: input.name,
        mediaType: input.mediaType,
        enabled: input.enabled,
        sources: validated.sources,
        createdAtMs,
        updatedAtMs: Date.now()
      }, validated.serverFences)
      if (saved === null) return yield* Effect.fail(new LibraryValidationFailed({ field: "sources" }))
      return toView(saved)
    })

    const create: LibraryServiceApi["create"] = (input) => {
      const nowMs = Date.now()
      return save(crypto.randomUUID() as VirtualLibraryView["id"], nowMs, input)
    }

    const update: LibraryServiceApi["update"] = (libraryId, input) => Effect.gen(function*() {
      const current = yield* getRecord(libraryId)
      return yield* save(current.id, current.createdAtMs, input)
    })

    const remove: LibraryServiceApi["delete"] = (libraryId) => Effect.gen(function*() {
      yield* getRecord(libraryId)
      yield* repositories.deleteVirtualLibrary(libraryId)
    })

    return LibraryService.of({
      list,
      get,
      create,
      update,
      delete: remove,
      isSourceEligible: repositories.isSourceEligible
    })
  }))
