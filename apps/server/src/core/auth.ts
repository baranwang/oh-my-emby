import type { BootstrapView, SessionView } from "@oh-my-emby/contracts"
import { Context, Effect, Layer } from "effect"

import {
  AuthenticationChanged,
  InvalidCredentials,
  RateLimited,
  RepositoryError,
  type AuthError,
  type ClaimError,
  type LoginError
} from "./errors.js"
import {
  AUTH_RATE_BLOCK_MS,
  AUTH_RATE_MAX_ATTEMPTS,
  AUTH_RATE_WINDOW_MS,
  DASHBOARD_SESSION_IDLE_MS,
  PBKDF2_ITERATIONS
} from "./limits.js"
import type { PasswordRecord, UserRecord } from "./model.js"
import { Repositories } from "./repositories.js"

const encoder = new TextEncoder()
const tokenBytes = 32
const passwordSaltBytes = 16
const sessionRefreshAfterMs = DASHBOARD_SESSION_IDLE_MS / 2
const embyTokenExpiresAtMs = Number.MAX_SAFE_INTEGER

export interface Credentials {
  readonly username: string
  readonly password: string
}

export interface EmbyLoginInput extends Credentials {
  readonly deviceId: string
  readonly deviceName: string
}

export interface LoginOptions {
  readonly scopeKey: string
  readonly afterVerify?: Effect.Effect<void>
}

export interface DashboardSession {
  readonly token: string
  readonly expiresAtMs: number
  readonly view: SessionView
}

export interface EmbyTokenView {
  readonly accessToken: string
  readonly userId: string
  readonly expiresAtMs: number
}

export interface SessionPrincipal {
  readonly id: string
  readonly username: string
  readonly authGeneration: number
  readonly expiresAtMs: number
}

export interface EmbyPrincipal {
  readonly id: string
  readonly username: string
  readonly authGeneration: number
  readonly deviceId: string
  readonly deviceName: string
}

export interface ChangePasswordInput {
  readonly currentPassword: string
  readonly newPassword: string
}

export interface AuthService {
  readonly bootstrap: () => Effect.Effect<BootstrapView, RepositoryError>
  readonly claim: (
    input: Credentials,
    options: LoginOptions
  ) => Effect.Effect<DashboardSession, ClaimError | LoginError>
  readonly loginDashboard: (
    input: Credentials,
    options: LoginOptions
  ) => Effect.Effect<DashboardSession, LoginError>
  readonly loginEmby: (
    input: EmbyLoginInput,
    options: LoginOptions
  ) => Effect.Effect<EmbyTokenView, LoginError>
  readonly authenticateDashboard: (
    token: string
  ) => Effect.Effect<SessionPrincipal, InvalidCredentials | RepositoryError>
  readonly authenticateEmby: (
    token: string
  ) => Effect.Effect<EmbyPrincipal, InvalidCredentials | RepositoryError>
  readonly logoutDashboard: (principal: SessionPrincipal) => Effect.Effect<void, RepositoryError>
  readonly changePassword: (
    principal: SessionPrincipal,
    input: ChangePasswordInput
  ) => Effect.Effect<void, AuthError | InvalidCredentials>
}

export class Auth extends Context.Service<Auth, AuthService>()("oh-my-emby/Auth") {}

export interface AuthLayerConfig {
  readonly now?: () => number
}

const cryptoFailure = (operation: string, cause: unknown) => new RepositoryError({
  operation,
  message: cause instanceof Error ? cause.message : String(cause)
})

const derivePassword = (password: string, salt: Uint8Array, iterations: number) => Effect.tryPromise({
  try: async () => {
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"])
    const normalizedSalt = new Uint8Array(salt.byteLength)
    normalizedSalt.set(salt)
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: normalizedSalt, iterations },
      key,
      256
    ))
  },
  catch: (cause) => cryptoFailure("derivePassword", cause)
})

const hashToken = (token: string) => Effect.tryPromise({
  try: async () => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))),
  catch: (cause) => cryptoFailure("hashToken", cause)
})

const constantTimeEqual = (left: Uint8Array, right: Uint8Array): boolean => {
  let difference = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length))

const encodeToken = (value: Uint8Array): string => {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

const passwordRecord = (password: string) => {
  const salt = randomBytes(passwordSaltBytes)
  return derivePassword(password, salt, PBKDF2_ITERATIONS).pipe(
    Effect.map((hash): PasswordRecord => ({ hash, salt, iterations: PBKDF2_ITERATIONS }))
  )
}

const verifyPassword = (password: string, record: PasswordRecord) =>
  derivePassword(password, record.salt, record.iterations).pipe(
    Effect.map((hash) => constantTimeEqual(hash, record.hash))
  )

const dummyPassword: PasswordRecord = {
  hash: new Uint8Array(32),
  salt: new Uint8Array(16),
  iterations: PBKDF2_ITERATIONS
}

export const makeAuthLayer = (config: AuthLayerConfig = {}): Layer.Layer<Auth, never, Repositories> =>
  Layer.effect(Auth, Effect.gen(function*() {
    const repositories = yield* Repositories
    const now = config.now ?? Date.now

    const consumeAttempt = (scopeKey: string) => repositories.consumeAuthAttempt({
      scopeKey,
      nowMs: now(),
      windowMs: AUTH_RATE_WINDOW_MS,
      maxAttempts: AUTH_RATE_MAX_ATTEMPTS,
      blockMs: AUTH_RATE_BLOCK_MS
    }).pipe(Effect.flatMap((allowed) => allowed ? Effect.void : Effect.fail(new RateLimited())))

    const verifyCredentials = (input: Credentials, options: LoginOptions) => Effect.gen(function*() {
      yield* consumeAttempt(options.scopeKey)
      const user = yield* repositories.getUserByName(input.username)
      const matches = yield* verifyPassword(input.password, user?.password ?? dummyPassword)
      if (!user || !matches) return yield* Effect.fail(new InvalidCredentials())
      if (options.afterVerify) yield* options.afterVerify
      yield* repositories.clearAuthAttempts(options.scopeKey)
      return user
    })

    const issueDashboardSession = (user: UserRecord) => Effect.gen(function*() {
      const token = encodeToken(randomBytes(tokenBytes))
      const issuedAtMs = now()
      yield* repositories.issueDashboardSession({
        id: crypto.randomUUID(),
        tokenHash: yield* hashToken(token),
        expectedAuthGeneration: user.authGeneration,
        createdAtMs: issuedAtMs,
        lastSeenAtMs: issuedAtMs,
        expiresAtMs: issuedAtMs + DASHBOARD_SESSION_IDLE_MS
      })
      return {
        token,
        expiresAtMs: issuedAtMs + DASHBOARD_SESSION_IDLE_MS,
        view: { authenticated: true, username: user.username }
      } satisfies DashboardSession
    })

    const bootstrap: AuthService["bootstrap"] = () => repositories.getUser().pipe(
      Effect.map((user) => ({ initialized: user !== null }))
    )

    const claim: AuthService["claim"] = (input, options) => Effect.gen(function*() {
      yield* consumeAttempt(options.scopeKey)
      const user = yield* repositories.claimUser({
        username: input.username,
        password: yield* passwordRecord(input.password),
        nowMs: now()
      })
      yield* repositories.clearAuthAttempts(options.scopeKey)
      return yield* issueDashboardSession(user)
    })

    const loginDashboard: AuthService["loginDashboard"] = (input, options) =>
      verifyCredentials(input, options).pipe(Effect.flatMap(issueDashboardSession))

    const loginEmby: AuthService["loginEmby"] = (input, options) => Effect.gen(function*() {
      const user = yield* verifyCredentials(input, options)
      const accessToken = encodeToken(randomBytes(tokenBytes))
      const issuedAtMs = now()
      yield* repositories.issueEmbyToken({
        id: crypto.randomUUID(),
        tokenHash: yield* hashToken(accessToken),
        expectedAuthGeneration: user.authGeneration,
        deviceId: input.deviceId,
        deviceName: input.deviceName,
        createdAtMs: issuedAtMs,
        lastUsedAtMs: issuedAtMs,
        expiresAtMs: embyTokenExpiresAtMs
      })
      return { accessToken, userId: user.username, expiresAtMs: embyTokenExpiresAtMs }
    })

    const authenticateDashboard: AuthService["authenticateDashboard"] = (token) => Effect.gen(function*() {
      const session = yield* repositories.lookupDashboardSession({
        tokenHash: yield* hashToken(token),
        nowMs: now(),
        idleMs: DASHBOARD_SESSION_IDLE_MS,
        refreshAfterMs: sessionRefreshAfterMs
      })
      if (!session) return yield* Effect.fail(new InvalidCredentials())
      return {
        id: session.id,
        username: session.username,
        authGeneration: session.authGeneration,
        expiresAtMs: session.expiresAtMs
      }
    })

    const authenticateEmby: AuthService["authenticateEmby"] = (token) => Effect.gen(function*() {
      const record = yield* repositories.lookupEmbyToken({ tokenHash: yield* hashToken(token), nowMs: now() })
      if (!record) return yield* Effect.fail(new InvalidCredentials())
      return {
        id: record.id,
        username: record.username,
        authGeneration: record.authGeneration,
        deviceId: record.deviceId,
        deviceName: record.deviceName
      }
    })

    const logoutDashboard: AuthService["logoutDashboard"] = (principal) =>
      repositories.deleteDashboardSession(principal.id, principal.authGeneration)

    const changePassword: AuthService["changePassword"] = (principal, input) => Effect.gen(function*() {
      const user = yield* repositories.getUserByName(principal.username)
      const matches = user
        ? yield* verifyPassword(input.currentPassword, user.password)
        : false
      if (!user || !matches || user.authGeneration !== principal.authGeneration) {
        return yield* Effect.fail(new InvalidCredentials())
      }
      yield* repositories.revokeAuthentication({
        password: yield* passwordRecord(input.newPassword),
        expectedAuthGeneration: principal.authGeneration,
        updatedAtMs: now()
      })
    })

    return Auth.of({
      bootstrap,
      claim,
      loginDashboard,
      loginEmby,
      authenticateDashboard,
      authenticateEmby,
      logoutDashboard,
      changePassword
    })
  }))

export { AuthenticationChanged }
