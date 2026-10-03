import { m } from "@/paraglide/messages.js";

const failureMessage = (error: Record<string, unknown>) => {
  if (error._tag === "Timeout") return m.server_connection_timeout();
  if (error._tag === "UpstreamUnavailable") return m.server_connection_unavailable();
  if (error._tag === "UpstreamRejected" && typeof error.status === "number") {
    switch (error.status) {
      case 497:
        return m.server_connection_https_required();
      case 401:
        return m.server_connection_unauthorized();
      case 403:
        return m.server_connection_forbidden();
      case 404:
        return m.server_connection_not_found();
      default:
        return m.server_connection_http_error({ status: error.status });
    }
  }
  return m.server_connection_check_settings();
};

export const ConnectionFailure = ({ error }: { readonly error: unknown }) => {
  const failure =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const rawDetail = typeof failure.detail === "string" ? failure.detail.trim() : "";
  // Older servers may still return entire proxy error pages. Never display their source.
  const detail = /<!doctype|<\/?[a-z][^>]*>/i.test(rawDetail) ? "" : rawDetail.slice(0, 4096);
  return (
    <div className="space-y-2">
      <p>{failureMessage(failure)}</p>
      {detail && (
        <details>
          <summary className="cursor-pointer">{m.server_test_response_details()}</summary>
          <pre className="mt-2 max-h-40 overflow-auto text-xs break-words whitespace-pre-wrap">
            {detail}
          </pre>
        </details>
      )}
    </div>
  );
};
