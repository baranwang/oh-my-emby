import type { SystemStatusView } from "@oh-my-emby/contracts"

import { m } from "@/paraglide/messages.js"

const statusLabel = (status: SystemStatusView["database"]) => status === "healthy"
  ? m.status_healthy()
  : m.status_degraded()

export const SystemStatus = ({ status }: { readonly status: SystemStatusView }) => {
  const diagnostics = [
    [m.database_status(), statusLabel(status.database)],
    [m.cache_entries(), status.cacheEntries],
    [m.maintenance_last_run(), status.maintenanceLastRunAtMs === null
      ? m.maintenance_never_run()
      : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(status.maintenanceLastRunAtMs)],
    [m.outbox_pending(), status.outboxPending],
    [m.outbox_failed(), status.outboxFailed],
    [m.outbox_uncertain(), status.outboxUncertain],
    [m.upstream_healthy(), status.upstreamHealthy],
    [m.upstream_degraded(), status.upstreamDegraded],
    [m.upstream_unknown(), status.upstreamUnknown]
  ] as const

  return (
    <dl className="divide-y">
      {diagnostics.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-4 py-3 first:pt-0">
          <dt className="text-sm text-muted-foreground">{label}</dt>
          <dd className="text-sm font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  )
}
