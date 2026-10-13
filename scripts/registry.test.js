import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import yaml from 'js-yaml';
import {
  rowGithubId,
  intentOf,
  resolveIntents,
  readRegistry,
  loadRegistry,
  emptyRegistry,
  applyOptOuts,
  withoutOptedOut,
  batchForCreatedAt,
  rangeForCreatedAt,
  registrationGates,
  passesRegistrationGates,
  resolveRegistered,
  joinRegistry,
  admitFetched,
  GHOST_ACCOUNT_ID,
  NODES_PER_REQUEST,
  REGISTRATION_LABEL,
  OPT_OUT_LABEL
} from './registry.js';
import { SEARCH_BATCHES } from './fetch-devs.js';
import { parseShardQuery } from './discovery/partition.js';
import { BATCH_RANGES } from './discovery/batches.js';
import { MULTI_RANGE_QUERIES } from './discovery/fake-search.js';

const quiet = { log: () => {}, warn: () => {} };
const capture = () => {
  const lines = [];
  return { lines, log: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)) };
};

let nextNumber = 1;
function issue(
  { id, label = REGISTRATION_LABEL, at = '2026-10-01T00:00:00Z', ...over } = {},
  user = {}
) {
  return {
    number: nextNumber++,
    created_at: at,
    state: 'closed',
    state_reason: 'completed',
    labels: [{ name: label }],
    user: { id, login: `user${id}`, node_id: `U_${id}`, type: 'User', ...user },
    ...over
  };
}

describe('rowGithubId', () => {
  it('prefers the published github_id', () => {
    expect(
      rowGithubId({
        github_id: 42,
        avatar_url: 'https://avatars.githubusercontent.com/u/7?v=4'
      })
    ).toBe(42);
  });

  it('reads the id out of the avatar URL when the row predates github_id', () => {
    expect(rowGithubId({ avatar_url: 'https://avatars.githubusercontent.com/u/1234567?v=4' })).toBe(
      1234567
    );
    expect(rowGithubId({ avatar_url: 'https://avatars2.githubusercontent.com/u/99' })).toBe(99);
  });

  it('returns null rather than guess', () => {
    expect(rowGithubId({})).toBeNull();
    expect(rowGithubId({ github_id: 0, avatar_url: '' })).toBeNull();
    expect(rowGithubId({ github_id: '42' })).toBeNull();
    expect(rowGithubId({ avatar_url: 'https://example.com/u/5' })).toBeNull();
    expect(rowGithubId({ avatar_url: 'https://avatars.githubusercontent.com/u/12abc' })).toBeNull();
  });
});

describe('resolveIntents', () => {
  it('keeps each author latest intent: an opt-out after a registration removes them', () => {
    const { registered, optedOut } = resolveIntents([
      issue({ id: 1, at: '2026-10-01T00:00:00Z' }),
      issue({ id: 1, label: OPT_OUT_LABEL, at: '2026-10-02T00:00:00Z' })
    ]);
    expect(registered).toEqual([]);
    expect([...optedOut]).toEqual([1]);
  });

  it('and a registration after an opt-out brings them back', () => {
    const later = issue({ id: 2, at: '2026-10-03T00:00:00Z' });
    const { registered, optedOut } = resolveIntents([
      later,
      issue({ id: 2, label: OPT_OUT_LABEL, at: '2026-10-02T00:00:00Z' })
    ]);
    expect(optedOut.size).toBe(0);
    expect(registered).toEqual([
      { id: 2, nodeId: 'U_2', login: 'user2', issueNumber: later.number, at: later.created_at }
    ]);
  });

  it('breaks a tie inside one second on the issue number', () => {
    const at = '2026-10-02T00:00:00Z';
    const first = issue({ id: 3, at });
    const second = issue({ id: 3, label: OPT_OUT_LABEL, at });
    expect(resolveIntents([second, first]).optedOut.has(3)).toBe(true);
  });

  it('rejects a registration closed as not_planned, without undoing an earlier opt-out', () => {
    const { registered, optedOut, counts } = resolveIntents([
      issue({ id: 4, label: OPT_OUT_LABEL, at: '2026-10-01T00:00:00Z' }),
      issue({ id: 4, at: '2026-10-02T00:00:00Z', state_reason: 'not_planned' }),
      issue({ id: 5, state_reason: 'not_planned' })
    ]);
    expect(registered).toEqual([]);
    expect([...optedOut]).toEqual([4]);
    expect(counts.rejected).toBe(2);
  });

  it('honours an opt-out however it was closed, and an open or completed registration', () => {
    const { registered, optedOut } = resolveIntents([
      issue({ id: 6, label: OPT_OUT_LABEL, state_reason: 'not_planned' }),
      issue({ id: 7, state: 'open', state_reason: null }),
      issue({ id: 8, state_reason: 'completed' })
    ]);
    expect([...optedOut]).toEqual([6]);
    expect(registered.map((r) => r.id)).toEqual([7, 8]);
  });

  it('ignores pull requests, non-user authors and the ghost account', () => {
    const { registered, optedOut, counts } = resolveIntents([
      issue({ id: 9, pull_request: { url: 'x' } }),
      issue({ id: 10 }, { type: 'Bot' }),
      issue({ id: 11, label: OPT_OUT_LABEL }, { type: 'Organization' }),
      issue({ id: GHOST_ACCOUNT_ID, label: OPT_OUT_LABEL }, { login: 'ghost' })
    ]);
    expect(registered).toEqual([]);
    expect(optedOut.size).toBe(0);
    expect(counts.ignored).toBe(4);
  });

  it('reads an issue carrying both labels as an opt-out, and one listed twice once', () => {
    const both = issue({ id: 12 });
    both.labels = [{ name: REGISTRATION_LABEL }, { name: OPT_OUT_LABEL }];
    const { optedOut, counts } = resolveIntents([both, both]);
    expect([...optedOut]).toEqual([12]);
    expect(counts.issues).toBe(1);
    expect(intentOf({ labels: ['registration'] })).toBe('register');
    expect(intentOf({ labels: [] })).toBeNull();
  });

  it('throws on an issue it cannot attribute, rather than read it as nobody', () => {
    expect(() => resolveIntents([issue({ id: 13 }, { id: null })])).toThrow(/account id/);
    expect(() => resolveIntents([{ ...issue({ id: 14 }), created_at: 'never' }])).toThrow(
      /created_at/
    );
    expect(() => resolveIntents([issue({ id: 15 }, { node_id: '' })])).toThrow(/node_id/);
  });
});

/** A REST client over fixed pages per label, recording every route. */
function fakeApi(pagesByLabel, { fail = null } = {}) {
  const routes = [];
  return {
    routes,
    async json(method, route) {
      routes.push(`${method} ${route}`);
      if (fail) throw fail;
      const label = decodeURIComponent(/labels=([^&]+)/.exec(route)[1]);
      const page = Number(/[?&]page=(\d+)/.exec(route)[1]);
      return pagesByLabel[label]?.[page - 1] ?? [];
    }
  };
}

describe('readRegistry', () => {
  it('lists each label once when it fits one page: two requests', async () => {
    const api = fakeApi({
      [REGISTRATION_LABEL]: [[issue({ id: 20 })]],
      [OPT_OUT_LABEL]: [[issue({ id: 21, label: OPT_OUT_LABEL })]]
    });
    const registry = await readRegistry({ api });
    expect(registry.complete).toBe(true);
    expect(registry.requests).toBe(2);
    expect(registry.registered.map((r) => r.id)).toEqual([20]);
    expect([...registry.optedOut]).toEqual([21]);
    expect(api.routes).toEqual([
      'GET /issues?labels=registration&state=all&sort=created&direction=asc&per_page=100&page=1',
      'GET /issues?labels=opt-out&state=all&sort=created&direction=asc&per_page=100&page=1'
    ]);
  });

  it('reads on past a full page', async () => {
    const full = [issue({ id: 30 }), issue({ id: 31 })];
    const api = fakeApi({ [REGISTRATION_LABEL]: [full, [issue({ id: 32 })]] });
    const registry = await readRegistry({ api, perPage: 2 });
    expect(registry.requests).toBe(3);
    expect(registry.registered.map((r) => r.id)).toEqual([30, 31, 32]);
  });

  it('throws when the API fails, or answers with something other than a list', async () => {
    await expect(
      readRegistry({ api: fakeApi({}, { fail: new Error('HTTP 502') }) })
    ).rejects.toThrow('HTTP 502');
    await expect(readRegistry({ api: { json: async () => ({ message: 'x' }) } })).rejects.toThrow(
      /not a list/
    );
  });
});

describe('loadRegistry', () => {
  it('stops the run with an Actions error when the registry cannot be read', async () => {
    const out = capture();
    await expect(
      loadRegistry(async () => {
        throw new Error('HTTP 503');
      }, out)
    ).rejects.toThrow(/saves and publishes nothing: HTTP 503/);
    expect(out.lines[0]).toMatch(/^::error title=REGISTRY_UNREADABLE::Could not read/);
  });

  it('refuses a run that was given no reader, or an incomplete registry', async () => {
    await expect(loadRegistry(undefined, quiet)).rejects.toThrow(/no registry reader/);
    await expect(
      loadRegistry(async () => ({ ...emptyRegistry(), complete: false }), quiet)
    ).rejects.toThrow(/other than a complete registry/);
  });

  it('returns the registry and says what it holds', async () => {
    const out = capture();
    const registry = await loadRegistry(async () => emptyRegistry(), out);
    expect(registry.optedOut.size).toBe(0);
    expect(out.lines).toEqual([
      'Registry: 0 registered, 0 opted out, from 0 issue(s) in 0 request(s).'
    ]);
  });
});

describe('applyOptOuts', () => {
  const rows = [
    { username: 'a', batch_index: 3, github_id: 1 },
    { username: 'b', batch_index: 7, avatar_url: 'https://avatars.githubusercontent.com/u/2?v=4' },
    { username: 'c', batch_index: 7, github_id: 3 }
  ];

  it('removes by account id from any batch, with the reason the guard needs', () => {
    const { kept, removed } = applyOptOuts(rows, new Set([1, 2]), quiet);
    expect(kept.map((r) => r.username)).toEqual(['c']);
    expect(removed).toEqual([
      { username: 'a', batch_index: 3, reason: 'opted_out' },
      { username: 'b', batch_index: 7, reason: 'opted_out' }
    ]);
    expect(withoutOptedOut(rows, new Set([3])).map((r) => r.username)).toEqual(['a', 'b']);
  });

  it('warns about a row no opt-out could reach', () => {
    const out = capture();
    applyOptOuts([...rows, { username: 'd', batch_index: 1 }], new Set(), out);
    expect(out.lines).toEqual([expect.stringMatching(/^::warning title=Registry::1 row\(s\)/)]);
  });
});

describe('batchForCreatedAt', () => {
  const iso = (seconds) => new Date(seconds * 1000).toISOString();
  const ranges = SEARCH_BATCHES.flatMap((batch, index) =>
    (batch.queries || [batch.q]).map((query) => ({ index, ...parseShardQuery(query).root }))
  );

  it('places both ends of every range, and the second either side of it', () => {
    ranges.forEach(({ index, from, to }, i) => {
      expect(batchForCreatedAt(iso(from), SEARCH_BATCHES)).toBe(index);
      expect(batchForCreatedAt(iso(to), SEARCH_BATCHES)).toBe(index);
      expect(batchForCreatedAt(iso(from - 1), SEARCH_BATCHES)).toBe(
        i === 0 ? null : ranges[i - 1].index
      );
      expect(batchForCreatedAt(iso(to + 1), SEARCH_BATCHES)).toBe(
        i === ranges.length - 1 ? null : ranges[i + 1].index
      );
    });
  });

  it('leaves no gap between consecutive ranges', () => {
    for (let i = 1; i < ranges.length; i += 1) {
      expect(ranges[i].from).toBe(ranges[i - 1].to + 1);
    }
  });

  it('sends every range of a multi-range batch to that batch, and says which range', () => {
    const batches = [
      { label: 'old', q: SEARCH_BATCHES[0].q },
      { label: 'multi', queries: MULTI_RANGE_QUERIES }
    ];
    for (const at of [
      '2025-01-01T00:00:00Z',
      '2025-06-30T23:59:59Z',
      '2025-07-01T00:00:00Z',
      '2025-12-31T23:59:59Z',
      '2026-01-01T00:00:00Z',
      '2026-10-13T12:00:00Z'
    ]) {
      expect(batchForCreatedAt(at, batches)).toBe(1);
    }
    expect(rangeForCreatedAt('2025-07-01T00:00:00Z', batches).query).toBe(MULTI_RANGE_QUERIES[1]);
  });

  it('reads the dates as UTC days, as search does', () => {
    expect(batchForCreatedAt('2014-12-31T23:59:59Z', SEARCH_BATCHES)).toBe(0);
    expect(batchForCreatedAt('2015-01-01T00:00:00Z', SEARCH_BATCHES)).toBe(1);
    // 04:59 in Karachi on 1 January is still 31 December in UTC.
    expect(batchForCreatedAt('2015-01-01T04:59:59+05:00', SEARCH_BATCHES)).toBe(0);
    expect(batchForCreatedAt('2024-12-31T23:59:59Z', SEARCH_BATCHES)).toBe(20);
  });

  it('returns null outside every range, or for a date it cannot read', () => {
    expect(batchForCreatedAt('1999-12-31T23:59:59Z', SEARCH_BATCHES)).toBeNull();
    expect(batchForCreatedAt('2100-01-01T00:00:00Z', SEARCH_BATCHES)).toBeNull();
    expect(batchForCreatedAt('not a date', SEARCH_BATCHES)).toBeNull();
  });
});

describe('registrationGates', () => {
  it('reads repos:>3 and followers:>1 from every batch query', () => {
    for (const batch of SEARCH_BATCHES) {
      for (const query of batch.queries || [batch.q]) {
        expect(registrationGates(query)).toEqual({
          repos: [4, Infinity],
          followers: [2, Infinity]
        });
      }
    }
  });

  it('skips only location, and refuses a qualifier it cannot apply', () => {
    expect(
      registrationGates(
        'location:"Dera Ghazi Khan" type:user repos:>3 created:2020-01-01..2020-02-01'
      )
    ).toEqual({ repos: [4, Infinity], followers: [0, Infinity] });
    expect(() =>
      registrationGates('location:pakistan language:go created:2020-01-01..2020-02-01')
    ).toThrow(/cannot apply the search qualifier language:go/);
  });

  it('applies them on the published profile numbers, at the boundary', () => {
    const gates = registrationGates(SEARCH_BATCHES[5].q);
    expect(passesRegistrationGates({ public_repos: 4, followers: 2 }, gates)).toBe(true);
    expect(passesRegistrationGates({ public_repos: 3, followers: 50 }, gates)).toBe(false);
    expect(passesRegistrationGates({ public_repos: 50, followers: 1 }, gates)).toBe(false);
    expect(passesRegistrationGates({}, gates)).toBe(false);
  });
});

const user = (id, createdAt, extra = {}) => ({
  __typename: 'User',
  databaseId: id,
  login: `Now${id}`,
  createdAt,
  location: 'Dubai',
  ...extra
});
const entry = (id) => ({ id, nodeId: `U_${id}`, login: `user${id}`, issueNumber: id, at: 'x' });

/** A GraphQL transport answering nodes(ids:) from a table, with scripted faults. */
function fakeNodes(table, { faults = [] } = {}) {
  const calls = [];
  return {
    calls,
    sleep: async () => {},
    async query(document, { ids }) {
      calls.push(ids.length);
      expect(document).toContain('nodes(ids: $ids)');
      const fault = faults.shift();
      if (fault) return fault;
      const errors = [];
      const nodes = ids.map((nodeId, i) => {
        const node = table[nodeId];
        if (node === undefined) {
          errors.push({ type: 'NOT_FOUND', path: ['nodes', i], message: 'Could not resolve' });
          return null;
        }
        return node;
      });
      return errors.length
        ? { kind: 'partial', data: { nodes }, errors }
        : { kind: 'ok', data: { nodes } };
    }
  };
}

describe('resolveRegistered', () => {
  it('returns the current login and createdAt, and sets aside accounts that are gone', async () => {
    const graphql = fakeNodes({
      U_1: user(1, '2019-06-01T00:00:00Z'),
      U_3: { __typename: 'Organization' }
    });
    const { resolved, unresolved, requests } = await resolveRegistered({
      graphql,
      registered: [entry(1), entry(2), entry(3)]
    });
    expect(requests).toBe(1);
    expect(resolved).toEqual([
      { id: 1, login: 'Now1', createdAt: '2019-06-01T00:00:00Z', location: 'Dubai', issueNumber: 1 }
    ]);
    expect(unresolved.map((u) => [u.id, u.reason])).toEqual([
      [2, 'the account no longer exists'],
      [3, 'it is now a Organization, not a user']
    ]);
  });

  it(`asks for at most ${NODES_PER_REQUEST} ids at a time`, async () => {
    const table = {};
    const registered = [];
    for (let id = 1; id <= 150; id += 1) {
      table[`U_${id}`] = user(id, '2020-01-01T00:00:00Z');
      registered.push(entry(id));
    }
    const graphql = fakeNodes(table);
    const { resolved } = await resolveRegistered({ graphql, registered });
    expect(graphql.calls).toEqual([100, 50]);
    expect(resolved).toHaveLength(150);
  });

  it('retries a gateway failure, and gives up after the retries', async () => {
    const gateway = { kind: 'gateway', reason: 'HTTP 502' };
    const table = { U_1: user(1, '2020-01-01T00:00:00Z') };
    const retried = fakeNodes(table, { faults: [gateway, gateway] });
    expect(
      (await resolveRegistered({ graphql: retried, registered: [entry(1)] })).resolved
    ).toHaveLength(1);
    const down = fakeNodes(table, { faults: [gateway, gateway, gateway] });
    await expect(resolveRegistered({ graphql: down, registered: [entry(1)] })).rejects.toThrow(
      /HTTP 502/
    );
  });

  it('throws on anything it cannot read as a fact about the account', async () => {
    const bad = (outcome) =>
      resolveRegistered({ graphql: fakeNodes({}, { faults: [outcome] }), registered: [entry(1)] });
    await expect(
      bad({ kind: 'partial', data: null, errors: [{ type: 'RESOURCE_LIMITS_EXCEEDED' }] })
    ).rejects.toThrow(/RESOURCE_LIMITS_EXCEEDED/);
    await expect(bad({ kind: 'ok', data: { nodes: [null] } })).rejects.toThrow(
      /null with no error/
    );
    await expect(
      bad({ kind: 'ok', data: { nodes: [user(99, '2020-01-01T00:00:00Z')] } })
    ).rejects.toThrow(/resolved to account 99, not 1/);
    await expect(bad({ kind: 'ok', data: { nodes: [] } })).rejects.toThrow(/no node for each/);
  });
});

describe('joinRegistry', () => {
  // Noon on the first day of each batch's range, read from the current table.
  const inBatch5 = `${BATCH_RANGES[5].from}T12:00:00Z`;
  const inBatch9 = `${BATCH_RANGES[9].from}T12:00:00Z`;
  const registry = (registered, optedOut = []) => ({
    ...emptyRegistry(),
    registered,
    optedOut: new Set(optedOut)
  });

  it('adds registered developers in this batch range, by id, and withholds opt-outs', async () => {
    const graphql = fakeNodes({
      U_10: user(10, inBatch5),
      U_11: user(11, inBatch9),
      U_12: user(12, inBatch5)
    });
    const joined = await joinRegistry({
      discovered: [
        { id: 12, login: 'Searched12', source: 'pakistan' },
        { id: 13, login: 'Quitter', source: 'pakistan' },
        { id: 14, login: 'Stays', source: 'pakistan' }
      ],
      registry: registry([entry(10), entry(11), entry(12)], [13]),
      batchIndex: 5,
      batches: SEARCH_BATCHES,
      graphql,
      log: quiet
    });
    expect(joined.complete).toBe(true);
    // 12 was found by search, so it keeps search's entry and source; 11 belongs to batch 9; 13
    // opted out.
    expect(joined.candidates).toEqual([
      { id: 12, login: 'Searched12', source: 'pakistan' },
      { id: 14, login: 'Stays', source: 'pakistan' },
      { id: 10, login: 'Now10', source: 'registered' }
    ]);
    expect([...joined.registered.keys()]).toEqual([10]);
    expect(graphql.calls).toEqual([3]);
  });

  it('never lets the city re-check rule out someone who registered', async () => {
    const joined = await joinRegistry({
      discovered: [
        { id: 20, login: 'ByCity', source: 'city' },
        { id: 21, login: 'ByCountry', source: 'pakistan' },
        { id: 22, login: 'CityOnly', source: 'city' }
      ],
      registry: registry([entry(20), entry(21)]),
      batchIndex: 5,
      batches: SEARCH_BATCHES,
      graphql: fakeNodes({ U_20: user(20, inBatch5), U_21: user(21, inBatch5) }),
      log: quiet
    });
    expect(joined.candidates.map((c) => [c.id, c.source])).toEqual([
      [20, 'registered'],
      [21, 'pakistan'],
      [22, 'city']
    ]);
    // Search applied its own repos:/followers: gates to both, so neither is gated again.
    expect(joined.registered.size).toBe(0);
  });

  it('makes no GraphQL request when nobody is registered', async () => {
    const graphql = fakeNodes({});
    const joined = await joinRegistry({
      discovered: [{ id: 1, login: 'a' }],
      registry: registry([]),
      batchIndex: 0,
      batches: SEARCH_BATCHES,
      graphql,
      log: quiet
    });
    expect(graphql.calls).toEqual([]);
    expect(joined.candidates).toEqual([{ id: 1, login: 'a' }]);
  });

  it('reports the batch short, rather than fail it, when registrations cannot be resolved', async () => {
    const out = capture();
    const graphql = fakeNodes(
      {},
      { faults: Array(3).fill({ kind: 'gateway', reason: 'HTTP 502' }) }
    );
    const joined = await joinRegistry({
      discovered: [{ id: 1, login: 'a' }],
      registry: registry([entry(10)]),
      batchIndex: 5,
      batches: SEARCH_BATCHES,
      graphql,
      log: out
    });
    expect(joined.complete).toBe(false);
    expect(joined.candidates).toEqual([{ id: 1, login: 'a' }]);
    expect(out.lines.some((l) => l.startsWith('::warning title=Registration::'))).toBe(true);
  });

  it('takes every batch range when no batch is given', async () => {
    const joined = await joinRegistry({
      discovered: [],
      registry: registry([entry(10), entry(11)]),
      batches: SEARCH_BATCHES,
      graphql: fakeNodes({ U_10: user(10, inBatch5), U_11: user(11, inBatch9) }),
      log: quiet
    });
    expect(joined.candidates.map((c) => c.id)).toEqual([10, 11]);
  });
});

describe('admitFetched', () => {
  const gates = registrationGates(SEARCH_BATCHES[5].q);
  const joined = {
    ids: new Set([1, 2]),
    registered: new Map([[2, { id: 2, gates }]])
  };

  it('tags a registered developer who meets the search gates', () => {
    const dev = { username: 'two', github_id: 2, public_repos: 9, followers: 9 };
    expect(admitFetched(joined, dev, quiet)).toEqual({
      admit: { ...dev, discovery_source: 'registered' }
    });
  });

  it('rejects one below them, as evaluated and ineligible', () => {
    const verdict = admitFetched(
      joined,
      { username: 'two', github_id: 2, public_repos: 2, followers: 9 },
      quiet
    );
    expect(verdict.reject).toMatch(/below this batch's search gates/);
  });

  it('passes a discovered developer through untouched', () => {
    const dev = { username: 'one', github_id: 1, public_repos: 0, followers: 0 };
    expect(admitFetched(joined, dev, quiet)).toEqual({ admit: dev });
  });

  it('skips a login that now belongs to an account nobody chose', () => {
    expect(admitFetched(joined, { username: 'two', github_id: 77 }, quiet).skip).toMatch(
      /now account 77/
    );
  });
});

const read = (path) => yaml.load(fs.readFileSync(new URL(path, import.meta.url), 'utf8'));

describe('the issue forms and their workflow', () => {
  it('labels each form with the label the pipeline reads', () => {
    const register = read('../.github/ISSUE_TEMPLATE/register.yml');
    const removeMe = read('../.github/ISSUE_TEMPLATE/remove-me.yml');
    expect(register.labels).toEqual([REGISTRATION_LABEL]);
    expect(removeMe.labels).toEqual([OPT_OUT_LABEL]);
    const attestation = register.body.find((field) => field.id === 'attestation');
    expect(attestation.attributes.options).toEqual([
      { label: 'I am Pakistani, or I live in Pakistan', required: true }
    ]);
    // Neither form asks for a username: the author is the account.
    for (const form of [register, removeMe]) {
      expect(form.body.filter((f) => f.type === 'input' || f.type === 'textarea')).toEqual([]);
    }
    expect(read('../.github/ISSUE_TEMPLATE/config.yml').blank_issues_enabled).toBe(true);
  });

  it('answers only labelled issues, with issues: write and nothing else', () => {
    const workflow = read('../.github/workflows/registration.yml');
    expect(workflow.on).toEqual({ issues: { types: ['opened'] } });
    expect(workflow.permissions).toEqual({ issues: 'write' });
    const job = workflow.jobs.acknowledge;
    expect(job.if).toContain(`'${REGISTRATION_LABEL}'`);
    expect(job.if).toContain(`'${OPT_OUT_LABEL}'`);
    const script = job.steps[0].with.script;
    // Identity from the event's issue.user alone; the title and body are never read.
    expect(script).toContain('const issue = context.payload.issue;');
    expect(script).toContain('const { id, type, login } = issue.user;');
    expect(script).not.toMatch(/\.(title|body)\b/);
    expect(script).toContain('state_reason: reason');
  });

  it('lets the pipeline read the issues it fails closed on', () => {
    const pipeline = read('../.github/workflows/update-digest.yml');
    expect(['read', 'write']).toContain(pipeline.permissions.issues);
  });

  it('expands no event field into a shell command, in any workflow', () => {
    const dir = new URL('../.github/workflows/', import.meta.url);
    const files = fs.readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
    expect(files).toContain('registration.yml');
    for (const name of files) {
      const workflow = yaml.load(fs.readFileSync(new URL(name, dir), 'utf8'));
      for (const [jobName, job] of Object.entries(workflow.jobs || {})) {
        for (const step of job.steps || []) {
          if (typeof step.run !== 'string') continue;
          const expressions = step.run.match(/\$\{\{[^}]*\}\}/g) || [];
          for (const expression of expressions) {
            expect(
              expression,
              `${name} ${jobName}: ${step.name || 'a step'} expands ${expression} in run:`
            ).not.toMatch(/github\.event\.(issue|comment|pull_request|review)/);
          }
        }
      }
    }
  });
});
