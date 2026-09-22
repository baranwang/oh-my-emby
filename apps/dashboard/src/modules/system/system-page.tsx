import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { OutboxFailures } from "@/modules/system/components/outbox-failures"
import { SystemStatus } from "@/modules/system/components/system-status"
import { useOutboxFailures, useSystemStatus } from "@/modules/system/hooks/use-system"
import { m } from "@/paraglide/messages.js"

export const SystemPage = () => {
  const status = useSystemStatus()
  const failures = useOutboxFailures()

  return (
    <div className="max-w-5xl space-y-10">
      <header className="space-y-2">
        <h1 className="font-heading text-2xl font-medium">{m.system()}</h1>
        <p className="max-w-prose text-sm leading-6 text-muted-foreground">{m.system_description()}</p>
      </header>
      <section className="space-y-4" aria-labelledby="system-status-title">
        <h2 id="system-status-title" className="font-heading text-xl font-medium">{m.system_status_title()}</h2>
        {status.isPending ? (
          <Skeleton aria-label={m.system_status_loading()} className="h-48" />
        ) : status.isError || !status.data ? (
          <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 p-4">
            <p className="text-sm text-destructive">{m.system_status_failed()}</p>
            <Button variant="outline" onClick={() => void status.refetch()}>{m.retry()}</Button>
          </div>
        ) : <SystemStatus status={status.data} />}
      </section>
      <section className="space-y-4" aria-labelledby="outbox-failures-title">
        <h2 id="outbox-failures-title" className="font-heading text-xl font-medium">{m.outbox_failures_title()}</h2>
        {failures.isPending ? (
          <Skeleton aria-label={m.outbox_failures_loading()} className="h-32" />
        ) : failures.isError ? (
          <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 p-4">
            <p className="text-sm text-destructive">{m.outbox_failures_load_failed()}</p>
            <Button variant="outline" onClick={() => void failures.refetch()}>{m.retry()}</Button>
          </div>
        ) : <OutboxFailures failures={failures.data ?? []} />}
      </section>
    </div>
  )
}
