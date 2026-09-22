import type {
  MetadataProviderSettingsInput,
  MetadataProviderSettingsView,
  SecretPatch
} from "@oh-my-emby/contracts"
import { Context, Effect, Layer } from "effect"

import { RepositoryError } from "./errors.js"
import type { MetadataProviderSetting } from "./model.js"
import { Repositories } from "./repositories.js"

export interface MetadataSettingsApi {
  readonly get: () => Effect.Effect<MetadataProviderSettingsView, RepositoryError>
  readonly update: (
    input: MetadataProviderSettingsInput
  ) => Effect.Effect<MetadataProviderSettingsView, RepositoryError>
}

export class MetadataSettings extends Context.Service<MetadataSettings, MetadataSettingsApi>()(
  "oh-my-emby/MetadataSettings"
) {}

const applySecret = (current: string | null, patch: SecretPatch): string | null => {
  switch (patch._tag) {
    case "Preserve": return current
    case "Set": return patch.value
    case "Clear": return null
  }
}

const toProviderView = ({ id, enabled, order, language, credential, status }: MetadataProviderSetting) => ({
  id,
  enabled,
  order,
  language,
  hasCredential: credential !== null,
  status
})

const toView = (
  providers: readonly [MetadataProviderSetting, MetadataProviderSetting]
): MetadataProviderSettingsView => ({
  providers: [toProviderView(providers[0]), toProviderView(providers[1])]
})

const invalidInput = () => new RepositoryError({
  operation: "updateMetadataSettings",
  message: "metadata settings must contain TMDB and Trakt once with unique order"
})

export const makeMetadataSettingsLayer: Layer.Layer<MetadataSettings, never, Repositories> =
  Layer.effect(MetadataSettings, Effect.gen(function*() {
    const repositories = yield* Repositories

    const get: MetadataSettingsApi["get"] = () => repositories.readMetadataSettings().pipe(
      Effect.map(toView)
    )

    const update: MetadataSettingsApi["update"] = (input) => Effect.gen(function*() {
      const providers = [...input.providers].sort((left, right) => left.order - right.order)
      if (
        providers.length !== 2 ||
        providers[0]?.order !== 0 ||
        providers[1]?.order !== 1 ||
        new Set(providers.map(({ id }) => id)).size !== 2 ||
        !providers.some(({ id }) => id === "tmdb") ||
        !providers.some(({ id }) => id === "trakt")
      ) return yield* Effect.fail(invalidInput())

      const current = yield* repositories.readMetadataSettings()
      const nowMs = Date.now()
      const settings = providers.map((provider) => {
        const previous = current.find(({ id }) => id === provider.id)!
        const credential = applySecret(previous.credential, provider.credential)
        return {
          id: provider.id,
          enabled: provider.enabled,
          order: provider.order,
          language: provider.language,
          credential,
          status: credential === null
            ? "unconfigured" as const
            : provider.credential._tag === "Preserve" && previous.status === "degraded"
              ? "degraded" as const
              : "ready" as const,
          updatedAtMs: nowMs
        }
      }) as [MetadataProviderSetting, MetadataProviderSetting]

      return toView(yield* repositories.writeMetadataSettings(settings))
    })

    return MetadataSettings.of({ get, update })
  }))
