import { DashboardApi } from "@oh-my-emby/contracts"
import { Effect } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient"

const baseUrl = globalThis.location?.origin ?? "http://localhost"

export const apiClient = Effect.runSync(
  HttpApiClient.make(DashboardApi, { baseUrl }).pipe(
    Effect.provide(FetchHttpClient.layer)
  )
)
