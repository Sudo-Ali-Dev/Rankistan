// The words Rank History shows: the marker under a rank and the sentences on a card, from a board
// row's `move` and a developer's history file (src/utils/rank-history-view.js). Pure. The sentences
// follow docs/rank-history-design.md. A card is read by anyone, so it says "the score", not "your
// score", and movement is never coloured: a fall is not a failure, and most of a rank's daily
// movement comes from other developers.

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
];

/** "17 October", from a Pakistan date. */
export function dayMonth(date) {
  const [, month, day] = String(date).split('-').map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

/** "17 OCT", for the mono labels. */
export function shortDate(date) {
  const [, month, day] = String(date).split('-').map(Number);
  return `${day} ${MONTHS[month - 1].slice(0, 3).toUpperCase()}`;
}

const HOURS = 60 * 60 * 1000;
const pktDate = (instant) => new Date(Date.parse(instant) + 5 * HOURS).toISOString().slice(0, 10);
/** Whether a board is so much older than a day that the comparison says which one it was. */
const longAgo = (since, generated) => Date.parse(generated) - Date.parse(since) > 36 * HOURS;

const places = (n) => `${n} ${n === 1 ? 'place' : 'places'}`;
const points = (n) => `${n.toFixed(2)} points`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The marker under a rank: `{text, label}`, `text` what is shown and `label` what a screen reader
 * says, or null for no marker. `move` is a board row's: places moved, 'new' or 'back'.
 */
export function moveMarker(move) {
  if (move === 'new') return { text: 'New', label: 'First day on the board' };
  if (move === 'back') return { text: 'Back', label: 'Back on the board after time away' };
  if (!Number.isInteger(move)) return null;
  if (move === 0) return { text: '=', label: 'Same rank as this time yesterday' };
  const n = Math.abs(move);
  return move > 0
    ? { text: `▲ ${n}`, label: `Up ${places(n)} since this time yesterday` }
    : { text: `▼ ${n}`, label: `Down ${places(n)} since this time yesterday` };
}

const FALL_NOTE =
  'A score covers the last 30 days, so it can fall when older active days leave that window.';

/** The sentences for a move since this time yesterday, as `splitMove` measured it. */
export function moveSentences({ places: p, own, others, score_then: before, score_now: after }) {
  const change = Math.round((after - before) * 100) / 100;
  const out = [];
  out.push(
    p > 0
      ? `Up ${places(p)} since this time yesterday.`
      : p < 0
        ? `Down ${places(-p)} since this time yesterday.`
        : 'Same rank as this time yesterday.'
  );

  if (change === 0) {
    out.push(
      p > 0
        ? 'The score did not change. Some developers who were ahead now score lower, or left the board.'
        : p < 0
          ? 'The score did not change. Other developers moved ahead.'
          : 'The score did not change.'
    );
    return out;
  }

  const rose = change > 0;
  const size = points(Math.abs(change));
  const verb = rose ? 'rose' : 'fell';
  const sameWay = (n) => (p > 0 ? n >= 0 : n <= 0);
  if (p === 0) {
    out.push(
      own === 0
        ? `The score ${verb} ${size}.`
        : rose
          ? `The score rose ${size}, and other developers rose as much.`
          : `The score fell ${size}, and the developers around it fell as much.`
    );
  } else if (rose && p < 0) {
    out.push(`The score rose ${size}, but other developers rose more.`);
  } else if (!rose && p > 0) {
    out.push(
      `The score fell ${size}, but some developers who were ahead fell further, or left the board.`
    );
  } else if (sameWay(own) && sameWay(others)) {
    // The common case: the developer's own change and everyone else's pushed the same way.
    if (own === 0) {
      out.push(
        `The score ${verb} ${size}. The places came from changes in other developers' scores.`
      );
    } else if (others === 0) {
      out.push(`The score ${verb} ${size}, which accounts for all of them.`);
    } else {
      out.push(`The score ${verb} ${size}, which accounts for ${Math.abs(own)} of them.`);
      out.push(`The other ${Math.abs(others)} came from changes in other developers' scores.`);
    }
  } else {
    // The two parts pulled opposite ways: say what each did, so they visibly add up.
    const way = (n) => (n > 0 ? 'up' : 'down');
    out.push(
      `On its own, the score's change would have moved it ${way(own)} ${places(Math.abs(own))}.`
    );
    out.push(`Other developers' changes moved it ${way(others)} ${places(Math.abs(others))}.`);
  }
  if (!rose) out.push(FALL_NOTE);
  return out;
}

/** The sentences on a card for a developer's history file. */
export function historySentences(file) {
  const m = file?.movement;
  if (!m) return ['There is no board from this time yesterday to compare with.'];
  if (m.kind === 'new') return ['First day on the board. Places moved show from tomorrow.'];
  if (m.kind === 'back') {
    const last = `Last here on ${dayMonth(m.last.d)} at rank ${m.last.rank}.`;
    return m.away_days > 0
      ? [`Back on the board after ${plural(m.away_days, 'day', 'days')} away. ${last}`]
      : [`Back on the board. ${last}`];
  }
  if (m.kind === 'scoring') {
    return [
      `Scoring changed on ${dayMonth(file.scoring.since)}. Places moved show again once a day has ` +
        'passed under the new scoring.'
    ];
  }
  const out = moveSentences(m);
  if (longAgo(m.since, file.generated)) {
    out.unshift(
      `Compared with the board of ${dayMonth(pktDate(m.since))}, the last one before today.`
    );
  }
  return out;
}

/** Register's one-line summary of a developer on the board, from their history file. */
export function registerSummary(file) {
  const now = file.points.at(-1)[1];
  const m = file.movement;
  const moved =
    m?.kind === 'move'
      ? m.places > 0
        ? `, up ${places(m.places)} since yesterday`
        : m.places < 0
          ? `, down ${places(-m.places)} since yesterday`
          : ', the same as yesterday'
      : '';
  const out = [`Rank ${now} today${moved}.`, `First on the board ${dayMonth(file.first)}.`];
  if (file.best) out.push(`Best rank ${file.best.rank} under the current scoring.`);
  return out.join(' ');
}

const LEFT = {
  cut: (d) => `Below the top 1,000 from ${dayMonth(d)}.`,
  rescored: (d) => `Left when scoring changed on ${dayMonth(d)}.`,
  unmeasured: (d) => `Not measured from ${dayMonth(d)}.`
};

/**
 * A developer's spells on the board under the current scoring, oldest first: `{from, to, best,
 * left}`, `left` the sentence for how the spell ended, null for the one still running. Days with
 * no board at all do not end a spell.
 */
export function boardSpells(file) {
  const gaps = new Set(file.gaps);
  const next = (d) =>
    new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const spells = [];
  for (const [d, rank] of file.points) {
    const last = spells.at(-1);
    let joined = false;
    if (last) {
      let day = next(last.to);
      while (day < d && gaps.has(day)) day = next(day);
      joined = day === d;
    }
    if (joined) {
      last.to = d;
      last.best = Math.min(last.best, rank);
    } else {
      spells.push({ from: d, to: d, best: rank, left: null });
    }
  }
  for (const spell of spells.slice(0, -1)) {
    const after = spell.to;
    const reason = file.left.find(([d]) => d > after)?.[1];
    const day = file.left.find(([d]) => d > after)?.[0] ?? next(after);
    spell.left = (LEFT[reason] ?? ((d) => `Not on the board from ${dayMonth(d)}.`))(day);
  }
  return spells;
}
