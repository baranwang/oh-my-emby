export const queryKeys = {
  bootstrap: ["bootstrap"] as const,
  session: ["session"] as const,
  servers: ["servers"] as const,
  server: (id: string) => ["servers", id] as const,
  serverHealth: (id: string) => ["servers", id, "health"] as const,
  serverLibraries: (id: string) => ["servers", id, "libraries"] as const,
  libraries: ["libraries"] as const,
  library: (id: string) => ["libraries", id] as const,
  metadataSettings: ["metadata-settings"] as const,
  system: ["system"] as const,
  outboxFailures: ["system", "outbox-failures"] as const
}

export const protectedQueryFamilies = [
  queryKeys.servers,
  queryKeys.libraries,
  queryKeys.metadataSettings,
  queryKeys.system
] as const
