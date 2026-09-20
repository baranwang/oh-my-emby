import type { OutboxFailureView } from "@oh-my-emby/contracts"

import { m } from "@/paraglide/messages.js"

const date = (value: number | null) => value === null
  ? m.diagnostic_not_scheduled()
  : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(value)

export const OutboxFailures = ({ failures }: { readonly failures: ReadonlyArray<OutboxFailureView> }) => {
  if (failures.length === 0) return <p className="text-sm text-muted-foreground">{m.outbox_failures_empty()}</p>

  return (
    <ul className="space-y-3">
      {failures.map((failure) => (
        <li key={`${failure.serverId}:${failure.failedAtMs}:${failure.code}`} className="rounded-lg border p-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div><dt className="text-muted-foreground">{m.diagnostic_server()}</dt><dd className="font-medium">{failure.serverId}</dd></div>
            <div><dt className="text-muted-foreground">{m.diagnostic_code()}</dt><dd className="font-medium">{failure.code}</dd></div>
            <div><dt className="text-muted-foreground">{m.diagnostic_attempt_count()}</dt><dd className="font-medium tabular-nums">{failure.attemptCount}</dd></div>
            <div><dt className="text-muted-foreground">{m.diagnostic_failed_at()}</dt><dd>{date(failure.failedAtMs)}</dd></div>
            <div><dt className="text-muted-foreground">{m.diagnostic_next_attempt()}</dt><dd>{date(failure.nextAttemptAtMs)}</dd></div>
            <div><dt className="text-muted-foreground">{m.diagnostic_uncertain_since()}</dt><dd>{date(failure.uncertainSinceMs)}</dd></div>
          </dl>
        </li>
      ))}
    </ul>
  )
}
