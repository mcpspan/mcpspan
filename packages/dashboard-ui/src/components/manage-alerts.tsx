'use client';

import { BellRing, CheckCircle2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { LocalTime } from './local-time';
import { Button } from './ui/button';
import { Field } from './ui/field';
import type { AlertEvent, AlertRule, Alerts, ServerRecord } from '../lib/api';

/**
 * Where alerts go, which rules raise them, and what they said lately.
 *
 * Like the server list, every change goes through this app's proxy and the
 * page is refreshed after it rather than patched in place.
 */
export function ManageAlerts({
  alerts,
  servers,
  toolsByServer,
  preset,
}: {
  alerts: Alerts;
  servers: ServerRecord[];
  /** Tool names seen lately on each server, to choose from. */
  toolsByServer: Record<string, string[]>;
  /** What the new-rule form starts on, when a tool's page sent somebody here. */
  preset: { serverId: string | undefined; toolName: string | undefined };
}) {
  const router = useRouter();
  const [failure, setFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string>();

  async function act(
    id: string,
    request: () => Promise<Response>,
  ): Promise<Record<string, unknown> | undefined> {
    setBusy(id);
    setFailure(undefined);
    setNotice(undefined);

    try {
      const response = await request();
      const body =
        response.status === 204
          ? {}
          : ((await response.json().catch(() => ({}))) as Record<string, unknown>);

      if (!response.ok) {
        setFailure(typeof body['error'] === 'string' ? body['error'] : 'That did not work.');
        return undefined;
      }

      router.refresh();
      return body;
    } catch {
      setFailure('Could not reach the server.');
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`/api/alerts${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });

  return (
    <div className="space-y-6">
      <Webhook
        webhook={alerts.webhook}
        busy={busy === 'webhook'}
        onSave={async (url) => {
          await act('webhook', () => send('PUT', '/webhook', { url }));
        }}
        onRemove={async () => {
          await act('webhook', () => send('DELETE', '/webhook'));
        }}
        onTest={async () => {
          const outcome = await act('webhook', () => send('POST', '/webhook/test'));

          if (outcome === undefined) return;

          if (outcome['ok'] === true) {
            setNotice('Test notification delivered.');
          } else {
            setFailure(
              typeof outcome['error'] === 'string' ? outcome['error'] : 'The test did not arrive.',
            );
          }
        }}
      />

      <div>
        <h3 className="mb-2 text-sm font-medium text-ink">Rules</h3>

        {alerts.rules.length === 0 ? (
          <p className="mb-3 text-sm text-ink-muted">No rules yet.</p>
        ) : (
          <ul className="mb-3 divide-y divide-border">
            {alerts.rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                email={alerts.email}
                busy={busy === rule.id}
                onToggle={async () => {
                  await act(rule.id, () =>
                    send('PATCH', `/rules/${rule.id}`, { enabled: !rule.enabled }),
                  );
                }}
                onNotifyResolved={async (notifyResolved) => {
                  await act(rule.id, () =>
                    send('PATCH', `/rules/${rule.id}`, { notifyResolved }),
                  );
                }}
                onChannels={async (channels) => {
                  await act(rule.id, () => send('PATCH', `/rules/${rule.id}`, channels));
                }}
                onRemove={async () => {
                  await act(rule.id, () => send('DELETE', `/rules/${rule.id}`));
                }}
              />
            ))}
          </ul>
        )}

        <AddRule
          email={alerts.email}
          hasWebhook={alerts.webhook !== null}
          servers={servers}
          toolsByServer={toolsByServer}
          preset={preset}
          busy={busy === 'new-rule'}
          onAdd={async (rule) => {
            await act('new-rule', () => send('POST', '/rules', rule));
          }}
        />
      </div>

      {alerts.events.length === 0 ? null : (
        <RecentEvents events={alerts.events} mailable={alerts.email !== null} />
      )}

      {failure === undefined ? null : (
        <p role="alert" className="text-sm text-status-critical">
          {failure}
        </p>
      )}
      {notice === undefined ? null : (
        <p role="status" className="flex items-center gap-1.5 text-sm text-ink">
          <CheckCircle2 aria-hidden className="size-4 text-status-good" />
          {notice}
        </p>
      )}
    </div>
  );
}

function Webhook({
  webhook,
  busy,
  onSave,
  onRemove,
  onTest,
}: {
  webhook: Alerts['webhook'];
  busy: boolean;
  onSave: (url: string) => Promise<void>;
  onRemove: () => Promise<void>;
  onTest: () => Promise<void>;
}) {
  const [url, setUrl] = useState(webhook?.url ?? '');

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(url);
      }}
    >
      <Field
        id="webhook-url"
        label="Webhook"
        type="url"
        placeholder="https://hooks.slack.com/services/..."
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <p className="text-xs text-ink-muted">
        A Slack or Discord incoming webhook shows the message as it is. Anything else receives the
        same JSON with the details beside it.
      </p>

      {webhook?.lastAttemptAt ? (
        <p className="text-xs text-ink-muted">
          Last delivery <LocalTime iso={webhook.lastAttemptAt} />:{' '}
          {webhook.lastError === null ? (
            <span className="text-ink">delivered</span>
          ) : (
            <span className="text-status-critical">{webhook.lastError}</span>
          )}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || url.trim().length === 0}>
          Save
        </Button>
        {webhook === null ? null : (
          <>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void onTest()}>
              Send a test
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => void onRemove()}
            >
              Remove
            </Button>
          </>
        )}
      </div>
    </form>
  );
}

function RuleRow({
  rule,
  email,
  busy,
  onToggle,
  onNotifyResolved,
  onChannels,
  onRemove,
}: {
  rule: AlertRule;
  email: string | null;
  busy: boolean;
  onToggle: () => Promise<void>;
  onNotifyResolved: (notifyResolved: boolean) => Promise<void>;
  onChannels: (channels: { notifyEmail: boolean; notifyWebhook: boolean }) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
      <div className="min-w-0">
        <p className="text-ink">
          {rule.firing && rule.enabled ? (
            <BellRing aria-hidden className="mr-1.5 inline size-4 text-status-critical" />
          ) : null}
          {describeRule(rule)}
        </p>
        <p className="mt-0.5 text-xs text-ink-muted">
          {rule.serverName}
          {', '}
          {!rule.enabled
            ? 'off'
            : rule.firing
              ? rule.firingTools.length > 0
                ? `firing now for ${rule.firingTools.join(', ')}`
                : 'firing now'
              : // On and watching, with nothing wrong. Not "quiet": on a rule
                // about calls stopping, that reads as the alarm itself.
                'all clear'}
        </p>
        <label className="mt-1.5 flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={rule.notifyResolved}
            disabled={busy}
            onChange={(event) => void onNotifyResolved(event.target.checked)}
            className="size-3.5 accent-ink"
          />
          Also tell me when it ends
        </label>
        {email === null ? null : (
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
            {/* The last one ticked cannot be unticked: a rule has to send somewhere. */}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={rule.notifyEmail}
                disabled={busy || (rule.notifyEmail && !rule.notifyWebhook)}
                title={rule.notifyEmail && !rule.notifyWebhook ? 'A rule has to send its alerts somewhere' : undefined}
                onChange={(event) =>
                  void onChannels({ notifyEmail: event.target.checked, notifyWebhook: rule.notifyWebhook })
                }
                className="size-3.5 accent-ink"
              />
              By email
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={rule.notifyWebhook}
                disabled={busy || (rule.notifyWebhook && !rule.notifyEmail)}
                title={rule.notifyWebhook && !rule.notifyEmail ? 'A rule has to send its alerts somewhere' : undefined}
                onChange={(event) =>
                  void onChannels({ notifyEmail: rule.notifyEmail, notifyWebhook: event.target.checked })
                }
                className="size-3.5 accent-ink"
              />
              To the webhook
            </label>
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Button
          variant="secondary"
          className="h-8 px-3"
          disabled={busy}
          onClick={() => void onToggle()}
        >
          {rule.enabled ? 'Turn off' : 'Turn on'}
        </Button>
        <Button
          variant="secondary"
          className="h-8 px-2"
          disabled={busy}
          onClick={() => void onRemove()}
          aria-label="Remove this rule"
        >
          <Trash2 aria-hidden className="size-4" />
        </Button>
      </div>
    </li>
  );
}

function AddRule({
  email,
  hasWebhook,
  servers,
  toolsByServer,
  preset,
  busy,
  onAdd,
}: {
  email: string | null;
  hasWebhook: boolean;
  servers: ServerRecord[];
  toolsByServer: Record<string, string[]>;
  preset: { serverId: string | undefined; toolName: string | undefined };
  busy: boolean;
  onAdd: (rule: Record<string, unknown>) => Promise<void>;
}) {
  const initialServer = servers.some((server) => server.id === preset.serverId)
    ? (preset.serverId as string)
    : (servers[0]?.id ?? '');
  const [serverId, setServerId] = useState(initialServer);
  const [chosen, setChosen] = useState<string[]>(
    preset.toolName === undefined ? [] : [preset.toolName],
  );

  // A tool named in the address stays on offer even if the lookback has not
  // seen it, so a link from its page always lands on it.
  const tools = [...(toolsByServer[serverId] ?? [])];
  for (const name of chosen) if (!tools.includes(name)) tools.unshift(name);
  const [kind, setKind] = useState<'error_rate' | 'silence'>('error_rate');
  const [threshold, setThreshold] = useState('20');
  const [windowMinutes, setWindowMinutes] = useState('15');
  const [minCalls, setMinCalls] = useState('10');
  const [notifyResolved, setNotifyResolved] = useState(true);
  // Mail where it can be sent, since it needs nothing set up; the webhook
  // as well once there is one.
  const [notifyEmail, setNotifyEmail] = useState(email !== null);
  const [notifyWebhook, setNotifyWebhook] = useState(email === null || hasWebhook);

  return (
    <form
      className="grid grid-cols-1 gap-3 rounded-lg border border-border p-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void onAdd({
          serverId,
          ...(chosen.length === 0 ? {} : { toolNames: chosen }),
          kind,
          windowMinutes: Number(windowMinutes),
          notifyResolved,
          ...(email === null ? {} : { notifyEmail, notifyWebhook }),
          ...(kind === 'error_rate'
            ? { threshold: Number(threshold) / 100, minCalls: Number(minCalls) }
            : {}),
        });
      }}
    >
      <Select
        id="rule-server"
        label="Server"
        value={serverId}
        onChange={(value) => {
          setServerId(value);
          setChosen([]);
        }}
        options={servers.map((server) => ({ value: server.id, label: server.name }))}
      />
      <ToolPicker tools={tools} chosen={chosen} onChange={setChosen} />
      <Select
        id="rule-kind"
        label="When"
        value={kind}
        onChange={(value) => {
          setKind(value as 'error_rate' | 'silence');
          setWindowMinutes(value === 'silence' ? '60' : '15');
        }}
        options={[
          { value: 'error_rate', label: 'Error rate reaches a threshold' },
          { value: 'silence', label: 'No calls for a while' },
        ]}
      />

      {kind === 'error_rate' ? (
        <>
          <Field
            id="rule-threshold"
            label="Threshold, %"
            type="number"
            min={1}
            max={100}
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
          />
          <Field
            id="rule-min-calls"
            label="At least this many calls"
            type="number"
            min={1}
            value={minCalls}
            onChange={(event) => setMinCalls(event.target.value)}
          />
        </>
      ) : null}

      <Field
        id="rule-window"
        label={kind === 'silence' ? 'Quiet for, minutes' : 'Over the last, minutes'}
        type="number"
        min={1}
        value={windowMinutes}
        onChange={(event) => setWindowMinutes(event.target.value)}
      />

      <label className="flex items-center gap-2 self-end pb-2.5 text-sm text-ink">
        <input
          type="checkbox"
          checked={notifyResolved}
          onChange={(event) => setNotifyResolved(event.target.checked)}
          className="size-4 accent-ink"
        />
        Also tell me when it ends
      </label>

      {email === null ? null : (
        <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
          <legend className="mb-1.5 text-sm font-medium text-ink">Send to</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex min-w-0 items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={notifyEmail}
                onChange={(event) => setNotifyEmail(event.target.checked)}
                className="size-4 shrink-0 accent-ink"
              />
              <span className="truncate">Email, {email}</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={notifyWebhook}
                onChange={(event) => setNotifyWebhook(event.target.checked)}
                className="size-4 shrink-0 accent-ink"
              />
              Webhook
            </label>
          </div>
          {notifyWebhook && !hasWebhook ? (
            <p className="text-xs text-ink-muted">No webhook is set yet: add its address above.</p>
          ) : null}
        </fieldset>
      )}

      <div className="flex items-end sm:col-span-2">
        <Button
          type="submit"
          disabled={busy || serverId === '' || (email !== null && !notifyEmail && !notifyWebhook)}
        >
          Add rule
        </Button>
      </div>
    </form>
  );
}

const SELECT_CLASS =
  'h-10 rounded-lg border border-border bg-raised px-3 text-sm text-ink ' +
  'outline-offset-2 focus-visible:outline-2 focus-visible:outline-ink';

/**
 * Which tools a rule watches, any number of them.
 *
 * Checkboxes rather than a multiple select, which needs a modifier key to
 * pick a second item and gives no sign that it can. None ticked is the whole
 * server, said in words next to the list so it is not mistaken for nothing.
 */
const TOOL_GRID =
  'grid max-h-48 grid-cols-1 gap-x-4 gap-y-1 overflow-y-auto rounded-lg border ' +
  'border-border p-2 sm:grid-cols-2';

function ToolPicker({
  tools,
  chosen,
  onChange,
}: {
  tools: string[];
  chosen: string[];
  onChange: (chosen: string[]) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-1.5 sm:col-span-2">
      <legend className="mb-1.5 text-sm font-medium text-ink">Tools</legend>

      <p className="text-xs text-ink-muted">
        {chosen.length === 0
          ? 'None ticked: the whole server, all tools together.'
          : `Each of the ${chosen.length} ticked is watched on its own, ` +
            'and a message names the one that broke.'}
      </p>

      {tools.length === 0 ? (
        <p className="text-xs text-ink-muted">No tools have been called on this server lately.</p>
      ) : (
        <div className={TOOL_GRID}>
          {tools.map((tool) => (
            <label key={tool} className="flex min-w-0 items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={chosen.includes(tool)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...chosen, tool]
                      : chosen.filter((name) => name !== tool),
                  )
                }
                className="size-4 shrink-0 accent-ink"
              />
              <span className="truncate font-mono text-xs">{tool}</span>
            </label>
          ))}
        </div>
      )}

      {chosen.length === 0 ? null : (
        <button
          type="button"
          onClick={() => onChange([])}
          className="self-start text-xs text-ink underline underline-offset-2"
        >
          Clear, watch the whole server
        </button>
      )}
    </fieldset>
  );
}

function Select({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={SELECT_CLASS}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function RecentEvents({ events, mailable }: { events: AlertEvent[]; mailable: boolean }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-ink">Recent alerts</h3>
      <ul className="divide-y divide-border text-sm">
        {events.map((event) => (
          <li key={event.id} className="py-2">
            <p className={event.kind === 'firing' ? 'text-ink' : 'text-ink-muted'}>
              {event.serverName}
              {event.toolName === null ? '' : `, ${event.toolName}`}: {describeEvent(event)}
            </p>
            <p className="mt-0.5 text-xs text-ink-muted">
              <LocalTime iso={event.occurredAt} />
              {', '}
              {mailable ? (
                <Delivery event={event} />
              ) : event.deliveredAt !== null ? (
                'sent'
              ) : event.notWanted ? (
                'not sent, this rule sends starts only'
              ) : event.error !== null ? (
                <span className="text-status-critical">not sent: {event.error}</span>
              ) : (
                'not sent, no webhook was set'
              )}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How an alert went out by each way it was owed, where mail is one of them. */
function Delivery({ event }: { event: AlertEvent }) {
  if (event.notWanted) return <>not sent, this rule sends starts only</>;

  const parts: { text: string; failed: boolean }[] = [];

  if (event.emailWanted) {
    parts.push(
      event.emailDeliveredAt !== null
        ? { text: 'emailed', failed: false }
        : event.emailError !== null
          ? { text: `not emailed: ${event.emailError}`, failed: true }
          : { text: 'email on its way', failed: false },
    );
  }

  if (event.webhookWanted) {
    parts.push(
      event.deliveredAt !== null
        ? { text: 'sent to the webhook', failed: false }
        : event.error !== null
          ? { text: `not sent to the webhook: ${event.error}`, failed: true }
          : { text: 'not sent to the webhook, none was set', failed: false },
    );
  }

  return (
    <>
      {parts.map((part, index) => (
        <span key={part.text} className={part.failed ? 'text-status-critical' : undefined}>
          {index === 0 ? '' : '; '}
          {part.text}
        </span>
      ))}
    </>
  );
}

function describeRule(rule: AlertRule): string {
  const tools = rule.toolNames === null ? null : listTools(rule.toolNames);
  const scope = tools === null ? '' : ` to ${tools}`;

  if (rule.kind === 'silence') return `No calls${scope} for ${minutes(rule.windowMinutes)}`;

  const of = tools === null ? '' : ` of ${tools}`;
  const threshold = Math.round((rule.threshold ?? 0) * 100);
  const calls = `${rule.minCalls} call${rule.minCalls === 1 ? '' : 's'}`;

  const window = minutes(rule.windowMinutes);

  return `Error rate${of} at or above ${threshold}% over ${window}, from ${calls}`;
}

/** A few names in full, a long list shortened, so a row stays one row. */
function listTools(names: string[]): string {
  if (names.length <= 3) return names.join(', ');

  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

function describeEvent(event: AlertEvent): string {
  if (event.ruleKind === 'silence') {
    return event.kind === 'firing' ? 'went quiet' : 'receiving calls again';
  }

  const rate = `${Math.round((event.value ?? 0) * 100)}%`;

  return event.kind === 'firing' ? `error rate reached ${rate}` : `error rate back to ${rate}`;
}

function minutes(count: number): string {
  if (count % 1440 === 0) return `${count / 1440} day${count === 1440 ? '' : 's'}`;
  if (count % 60 === 0) return `${count / 60} hour${count === 60 ? '' : 's'}`;

  return `${count} minute${count === 1 ? '' : 's'}`;
}
