import type { ServerInput, ServerView } from "@oh-my-emby/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";

import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { runProtected } from "@/modules/auth/services/auth-service";

type ServerId = ServerView["id"];

const invalidateServer = (id: ServerId, queryClient: QueryClient) =>
  Promise.all(
    [
      queryKeys.servers,
      queryKeys.server(id),
      queryKeys.serverHealth(id),
      queryKeys.serverLibraries(id),
      queryKeys.libraries,
      queryKeys.system,
      queryKeys.outboxFailures,
    ].map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true })),
  );

export class ServerDiscoveryError extends Error {
  constructor(
    readonly server: ServerView,
    readonly stage: "connection" | "libraries",
    cause: unknown,
  ) {
    super("Server saved, but discovery failed", { cause });
  }
}

export const serversQueryOptions = (queryClient: QueryClient) =>
  queryOptions({
    queryKey: queryKeys.servers,
    queryFn: () => runProtected(apiClient.servers.listServers(), queryClient),
  });

export const serverQueryOptions = (id: ServerId, queryClient: QueryClient) =>
  queryOptions({
    queryKey: queryKeys.server(id),
    queryFn: () => runProtected(apiClient.servers.getServer({ params: { id } }), queryClient),
  });

export const serverHealthRefetchInterval = (visibility: DocumentVisibilityState) =>
  visibility === "visible" ? 30_000 : false;

export const serverHealthQueryOptions = (id: ServerId, queryClient: QueryClient) =>
  queryOptions({
    queryKey: queryKeys.serverHealth(id),
    queryFn: () => runProtected(apiClient.servers.getServerHealth({ params: { id } }), queryClient),
  });

export const serverLibrariesQueryOptions = (id: ServerId, queryClient: QueryClient) =>
  queryOptions({
    queryKey: queryKeys.serverLibraries(id),
    queryFn: () =>
      runProtected(apiClient.servers.listSourceLibraries({ params: { id } }), queryClient),
  });

const discoverSavedServer = async (saved: ServerView, queryClient: QueryClient) => {
  let stage: ServerDiscoveryError["stage"] = "connection";
  try {
    if (!saved.enabled) {
      await invalidateServer(saved.id, queryClient);
      return saved;
    }
    const connection = await testServerConnection(saved.id, queryClient);
    if (!connection.reachable) throw new Error("No reachable server endpoints");
    stage = "libraries";
    await queryClient.fetchQuery({
      ...serverLibrariesQueryOptions(saved.id, queryClient),
      staleTime: 0,
      retry: false,
    });
    return saved;
  } catch (cause) {
    throw new ServerDiscoveryError(saved, stage, cause);
  }
};

export const createServer = async (input: ServerInput, queryClient: QueryClient) => {
  const saved = await runProtected(apiClient.servers.createServer({ payload: input }), queryClient);
  return discoverSavedServer(saved, queryClient);
};

export const updateServer = async (id: ServerId, input: ServerInput, queryClient: QueryClient) => {
  const saved = await runProtected(
    apiClient.servers.updateServer({ params: { id }, payload: input }),
    queryClient,
  );
  return discoverSavedServer(saved, queryClient);
};

export const deleteServer = async (id: ServerId, queryClient: QueryClient) => {
  await runProtected(apiClient.servers.deleteServer({ params: { id } }), queryClient);
  await invalidateServer(id, queryClient);
};

export const testServerConnection = async (id: ServerId, queryClient: QueryClient) => {
  try {
    return await runProtected(
      apiClient.servers.testServerConnection({ params: { id } }),
      queryClient,
    );
  } finally {
    await invalidateServer(id, queryClient);
  }
};
