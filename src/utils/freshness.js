// How old the published data is, in words the status line can show honestly.
//
// The leaderboard used to print `SYSTEM_STATUS: LIVE_SYNC` beside a pulsing
// dot unconditionally, and kept printing it through the eight days from
// 2026-10-05 when nothing published. A status light has to read the state it
// reports, so this derives it from `last_updated` instead.
//
// LIVE_MAX_HOURS matches the pipeline watchdog's SITE_STALE threshold: the
// worst gap in 83 days of normal operation was 3.2 h, so past 4 h something
// is wrong and the page should stop calling itself live.
export const FRESHNESS = {
  LIVE_MAX_HOURS: 4,
  DELAYED_MAX_HOURS: 24
};

export function formatAge(hours) {
  if (!Number.isFinite(hours) || hours < 0) return '';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}M`;
  if (hours < 48) return `${Math.round(hours)}H`;
  return `${Math.round(hours / 24)}D`;
}

function result(state, ageHours, status, detail) {
  return {
    state,
    ageHours,
    // Kept apart so the line can wrap between them on a phone rather than
    // mid-phrase; `label` is the one-line form.
    status,
    detail,
    label: detail ? `SYSTEM_STATUS: ${status} · ${detail}` : `SYSTEM_STATUS: ${status}`
  };
}

/**
 * @returns {{ state: 'live' | 'delayed' | 'stale' | 'unknown', ageHours: number|null,
 *             status: string, detail: string, label: string }}
 */
export function freshnessOf(lastUpdated, now = Date.now()) {
  const ts = Date.parse(lastUpdated);
  if (!Number.isFinite(ts)) return result('unknown', null, 'UNKNOWN', '');

  // A clock a little ahead of the server is not "updated in the future".
  const ageHours = Math.max(0, (now - ts) / 3_600_000);
  const age = formatAge(ageHours);

  if (ageHours <= FRESHNESS.LIVE_MAX_HOURS) {
    return result('live', ageHours, 'LIVE_SYNC', `UPDATED ${age} AGO`);
  }
  if (ageHours <= FRESHNESS.DELAYED_MAX_HOURS) {
    return result('delayed', ageHours, 'DELAYED', `UPDATED ${age} AGO`);
  }
  return result('stale', ageHours, 'STALE', `LAST SYNC ${age} AGO`);
}
