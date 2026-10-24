import { createHash, randomBytes } from 'node:crypto';

import { getSummary } from './analytics.ts';
import { getPool } from './db.ts';

/**
 * A server's public badge: one rounded figure for a README, served to anybody
 * holding its address, while its owner has it switched on.
 *
 * What it shows is what the server's own SDK reported, as everything in
 * mcpspan is: nothing here vouches for it, and nothing says it does.
 */

/** What a badge can show, each over the last seven days. */
export const BADGE_METRICS = ['calls', 'success', 'latency'] as const;
export type BadgeMetric = (typeof BADGE_METRICS)[number];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a figure is kept before it is worked out again, however often it is asked for. */
const CACHE_MS = 5 * 60 * 1000;

/** What a badge says beside the figure, so a reader knows where it comes from. */
const LABEL = 'mcpspan';

/** The badge's tooltip. "Reported", never "verified": the server sent these numbers itself. */
const TITLE = "Reported by this server's own mcpspan";

export interface Badge {
  message: string;
  color: string;
}

const NO_DATA: Badge = { message: 'no data', color: '#9f9f9f' };

/** Badge ids as minted below. Anything else is answered as no data without asking the database. */
const BADGE_ID = /^[A-Za-z0-9_-]{22}$/;

export function isBadgeMetric(value: string): value is BadgeMetric {
  return (BADGE_METRICS as readonly string[]).includes(value);
}

/** Switches a server's badge on, or gives it a new address, the old one ending at once. */
export async function enableBadge(serverIds: readonly string[], serverId: string): Promise<string | undefined> {
  if (!serverIds.includes(serverId)) return undefined;

  const badgeId = randomBytes(16).toString('base64url');

  return (await replaceBadge(serverId, badgeId)) ? badgeId : undefined;
}

export async function disableBadge(serverIds: readonly string[], serverId: string): Promise<boolean> {
  if (!serverIds.includes(serverId)) return false;

  return replaceBadge(serverId, null);
}

/**
 * Sets a server's badge address, and forgets every figure kept under the old
 * one, so a badge switched off or replaced stops answering at once rather
 * than when its five minutes run out.
 */
async function replaceBadge(serverId: string, badgeId: string | null): Promise<boolean> {
  const result = await getPool().query<{ old: string | null }>(
    `UPDATE servers s SET badge_id = $2
     FROM (SELECT badge_id AS old FROM servers WHERE id = $1) previous
     WHERE s.id = $1
     RETURNING previous.old`,
    [serverId, badgeId],
  );
  const row = result.rows[0];

  if (row === undefined) return false;

  if (row.old !== null) for (const metric of BADGE_METRICS) cache.delete(`${row.old}:${metric}`);

  return true;
}

const cache = new Map<string, { badge: Badge; until: number }>();

/**
 * What a badge says now: from a five-minute-old answer when there is one, so
 * a README in front of many readers costs one query every five minutes.
 */
export async function badgeFor(badgeId: string, metric: BadgeMetric, now = Date.now()): Promise<Badge> {
  if (!BADGE_ID.test(badgeId)) return NO_DATA;

  const key = `${badgeId}:${metric}`;
  const kept = cache.get(key);

  if (kept !== undefined && kept.until > now) return kept.badge;

  const server = await getPool().query<{ id: string }>('SELECT id FROM servers WHERE badge_id = $1', [badgeId]);
  const serverId = server.rows[0]?.id;

  // Not kept: a badge switched off or replaced must stop at once, and an
  // address nobody has is one index probe.
  if (serverId === undefined) {
    cache.delete(key);
    return NO_DATA;
  }

  const summary = await getSummary(serverId, { from: new Date(now - WEEK_MS), to: new Date(now) });
  const badge = describe(metric, summary.totalCalls, summary.errorRate, summary.durationMs.p50);

  if (cache.size > 10_000) cache.clear();
  cache.set(key, { badge, until: now + CACHE_MS });

  return badge;
}

/** Forgets every figure, for tests that change the data under a badge. */
export function clearBadgeCache(): void {
  cache.clear();
}

export function describe(metric: BadgeMetric, calls: number, errorRate: number, p50: number | null): Badge {
  if (calls === 0) return { message: metric === 'calls' ? '0 calls/week' : 'no calls yet', color: '#9f9f9f' };

  switch (metric) {
    case 'calls':
      return { message: `${compact(calls)} calls/week`, color: '#007ec6' };
    case 'success': {
      const percent = (1 - errorRate) * 100;
      // Never rounded up to a perfect score it did not reach.
      const shown = percent >= 99.95 && errorRate > 0 ? '99.9' : percent.toFixed(percent === 100 ? 0 : 1);

      return { message: `${shown}% success`, color: successColor(percent) };
    }
    case 'latency':
      return p50 === null ? NO_DATA : { message: `p50 ${duration(p50)}`, color: '#007ec6' };
  }
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;

  return `${trim(n / 1_000_000)}M`;
}

function trim(n: number): string {
  return n < 100 ? n.toFixed(1).replace(/\.0$/, '') : String(Math.round(n));
}

function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${trim(ms / 1000)} s`;
}

function successColor(percent: number): string {
  if (percent >= 99) return '#4c1';
  if (percent >= 95) return '#97ca00';
  if (percent >= 90) return '#dfb317';
  if (percent >= 80) return '#fe7d37';

  return '#e05d44';
}

/** The badge as shields.io's endpoint format, for anybody who wants it in their own style. */
export function badgeJson(badge: Badge): Record<string, unknown> {
  return { schemaVersion: 1, label: LABEL, message: badge.message, color: badge.color };
}

/**
 * The badge as an image, in the flat style READMEs are full of.
 *
 * Text widths are estimates from Verdana's at 11px; textLength makes every
 * renderer fit the text to them, so a wrong guess squeezes a little rather
 * than spilling over the edge.
 */
export function badgeSvg(badge: Badge): string {
  const left = textWidth(LABEL) + 10;
  const right = textWidth(badge.message) + 10;
  const width = left + right;
  // Ids of this badge's own, so several pasted into one page do not share one
  // clip and draw each other's corners.
  const id = createHash('sha256').update(`${badge.color}${badge.message}`).digest('hex').slice(0, 8);
  const text = (x: number, value: string, w: number) =>
    `<text x="${x * 10}" y="140" transform="scale(.1)" textLength="${(w - 10) * 10}" lengthAdjust="spacingAndGlyphs">${escape(value)}</text>`;
  const shadow = (x: number, value: string, w: number) =>
    `<text aria-hidden="true" x="${x * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(w - 10) * 10}" lengthAdjust="spacingAndGlyphs">${escape(value)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${escape(`${LABEL}: ${badge.message}`)}">
<title>${escape(`${TITLE}: ${badge.message}`)}</title>
<linearGradient id="s${id}" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r${id}"><rect width="${width}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r${id})"><rect width="${left}" height="20" fill="#555"/><rect x="${left}" width="${right}" height="20" fill="${badge.color}"/><rect width="${width}" height="20" fill="url(#s${id})"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
${shadow(left / 2, LABEL, left)}${text(left / 2, LABEL, left)}
${shadow(left + right / 2, badge.message, right)}${text(left + right / 2, badge.message, right)}
</g>
</svg>`;
}

/** Approximate advance widths of Verdana at 11px, by character class. */
function textWidth(value: string): number {
  let width = 0;

  for (const char of value) {
    if (/[0-9]/.test(char)) width += 7;
    else if (/[ilj.,:;'|!]/.test(char)) width += 3.5;
    else if (/[ frt/]/.test(char)) width += 4.5;
    else if (/[mw%]/.test(char)) width += 10.5;
    else if (/[A-Z]/.test(char)) width += 7.5;
    else width += 6.5;
  }

  return Math.ceil(width);
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
