import { describe, it, expect } from 'vitest';
import {
  DAY_SECONDS,
  PACK_TO,
  SPLIT_AT,
  assertTiling,
  createdQualifier,
  packLeaves,
  parseCreated,
  parseFollowers,
  parseShardQuery,
  partitionMany,
  partitionRoots,
  splitFollowers,
  splitSlice,
  toQuery
} from './partition.js';
import { makePopulation, matcher, MULTI_RANGE_QUERIES } from './fake-search.js';
import { SEARCH_BATCHES } from '../fetch-devs.js';

const BASE_QUERY =
  'location:pakistan type:user repos:>3 followers:>1 created:2022-12-01..2023-02-28';
const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 1000;

function counter(population) {
  const calls = { count: 0, slices: 0 };
  const count = async (queries) => {
    calls.count += 1;
    calls.slices += queries.length;
    return queries.map((q) => population.filter(matcher(q)).length);
  };
  return { count, calls };
}

/** How many leaves each developer falls in. A tiling puts every one in exactly one. */
function membership(population, base, leaves) {
  const hits = new Map(population.map((u) => [u.id, 0]));
  for (const leaf of leaves) {
    const match = matcher(toQuery(base, leaf.slice));
    for (const u of population) if (match(u)) hits.set(u.id, hits.get(u.id) + 1);
  }
  return new Set(hits.values());
}

// --- Parsing and query building ---------------------------------------------------------------

describe('parseShardQuery', () => {
  it('strips created: and followers: from the batch query and keeps the rest verbatim', () => {
    const { base, root } = parseShardQuery(BASE_QUERY);
    expect(base).toBe('location:pakistan type:user repos:>3');
    expect(root).toEqual({
      from: day('2022-12-01'),
      to: day('2023-03-01') - 1,
      followers: [2, Infinity]
    });
    expect(toQuery(base, root)).toBe(BASE_QUERY);
  });

  it('round-trips every SEARCH_BATCHES range byte for byte, so eligibility is unchanged', () => {
    const queries = SEARCH_BATCHES.flatMap((b) => b.queries || [b.q]);
    expect(queries).toHaveLength(24);
    for (const q of queries) {
      const { base, root } = parseShardQuery(q);
      expect(base).toBe('location:pakistan type:user repos:>3');
      expect(toQuery(base, root)).toBe(q);
    }
  });

  it('refuses a repeated qualifier, because GitHub does not intersect them', () => {
    expect(() => parseShardQuery(`${BASE_QUERY} followers:2..5`)).toThrow(/repeats followers/);
    expect(() => parseShardQuery(`${BASE_QUERY} created:2023-01-01`)).toThrow(/repeats created/);
    expect(() => parseShardQuery(`${BASE_QUERY} -created:2023-01-01`)).toThrow(/repeats created/);
  });

  it('refuses a negated or re-cased form it would otherwise misread', () => {
    expect(() => parseShardQuery('type:user -created:2023-01-01')).toThrow(/Unsupported form/);
    expect(() => parseShardQuery('type:user Followers:>1')).toThrow(/Unsupported form/);
  });

  it('rejects impossible dates instead of rolling them over', () => {
    expect(() => parseShardQuery('type:user created:2023-02-01..2023-02-30')).toThrow(
      /Invalid date/
    );
  });

  it('reads open-ended and single-value forms', () => {
    expect(parseCreated('2026-01-01..*').to).toBe(Date.UTC(2099, 11, 31, 23, 59, 59) / 1000);
    expect(parseCreated('2023-02-05')).toEqual({
      from: day('2023-02-05'),
      to: day('2023-02-06') - 1
    });
    expect(parseCreated('2023-02-05T01:49:20Z')).toEqual({
      from: day('2023-02-05') + 6560,
      to: day('2023-02-05') + 6560
    });
    expect(parseCreated('>2023-02-05').from).toBe(day('2023-02-06'));
    expect(parseFollowers('>1')).toEqual([2, Infinity]);
    expect(parseFollowers('2..5')).toEqual([2, 5]);
    expect(parseFollowers('<=5')).toEqual([0, 5]);
  });
});

describe('toQuery and the two-created: trap', () => {
  const slice = { from: day('2023-01-01'), to: day('2023-01-02') - 1, followers: [2, Infinity] };

  it('refuses a base that already carries created:, which would make GitHub match everyone', () => {
    expect(() => toQuery('type:user created:2020-01-01..2020-12-31', slice)).toThrow(
      /must not carry created/
    );
    expect(() => toQuery('type:user -created:2020-01-01', slice)).toThrow(/must not carry/);
    expect(() => toQuery('type:user CREATED:2020-01-01', slice)).toThrow(/must not carry/);
  });

  it('refuses a base that carries followers:, which GitHub would OR with the slice', () => {
    expect(() => toQuery('type:user followers:>1', slice)).toThrow(/must not carry/);
  });

  it('shows why: a doubled created: query matches the whole population', () => {
    const population = makePopulation({ n: 50, from: day('2020-01-01'), to: day('2024-01-01') });
    const doubled = `type:user created:2020-01-01..2020-01-02 ${createdQualifier(slice)}`;
    expect(population.filter(matcher(doubled))).toHaveLength(50);
    expect(population.filter(matcher(toQuery('type:user', slice))).length).toBeLessThan(50);
  });

  it('emits exactly one created: and at most one followers: for every slice shape', () => {
    const shapes = [
      slice,
      { ...slice, to: slice.from + 3599 },
      { from: slice.from, to: slice.from, followers: [6, 13] },
      { ...slice, followers: [0, Infinity] }
    ];
    for (const s of shapes) {
      const tokens = toQuery('location:pakistan type:user repos:>3', s).split(' ');
      expect(tokens.filter((t) => t.startsWith('created:'))).toHaveLength(1);
      expect(tokens.filter((t) => t.startsWith('followers:')).length).toBeLessThanOrEqual(1);
    }
  });
});

describe('createdQualifier', () => {
  it('uses dates for whole UTC days and second-precision datetimes otherwise', () => {
    const d = day('2022-12-01');
    expect(createdQualifier({ from: d, to: d + DAY_SECONDS - 1, followers: [2, Infinity] })).toBe(
      'created:2022-12-01..2022-12-01'
    );
    expect(createdQualifier({ from: d, to: d + 43199, followers: [2, Infinity] })).toBe(
      'created:2022-12-01T00:00:00Z..2022-12-01T11:59:59Z'
    );
  });

  it('refuses an inverted range, which GitHub would count as the forward one', () => {
    expect(() => createdQualifier({ from: 10, to: 5, followers: [0, Infinity] })).toThrow(
      /Inverted/
    );
  });
});

// --- Splitting --------------------------------------------------------------------------------

describe('splitSlice', () => {
  const { root } = parseShardQuery(BASE_QUERY);

  it('splits whole days into contiguous halves with no gap or overlap', () => {
    const [a, b] = splitSlice(root);
    expect(a.from).toBe(root.from);
    expect(b.to).toBe(root.to);
    expect(b.from).toBe(a.to + 1);
    expect((a.to + 1) % DAY_SECONDS).toBe(0);
  });

  it('goes intra-day below one day, then to followers, then gives up', () => {
    const oneDay = { from: day('2023-01-01'), to: day('2023-01-02') - 1, followers: [2, Infinity] };
    const [am, pm] = splitSlice(oneDay);
    expect(am.to - am.from + 1).toBe(43200);
    expect(pm.from).toBe(am.to + 1);

    const oneSecond = { from: 100, to: 100, followers: [2, Infinity] };
    expect(splitSlice(oneSecond).map((s) => s.followers)).toEqual([
      [2, 5],
      [6, Infinity]
    ]);
    expect(splitSlice({ from: 100, to: 100, followers: [3, 3] })).toBeNull();
  });

  it('splits follower ranges into exact halves', () => {
    expect(splitFollowers([2, 5])).toEqual([
      [2, 3],
      [4, 5]
    ]);
    expect(splitFollowers([2, 3])).toEqual([
      [2, 2],
      [3, 3]
    ]);
    expect(splitFollowers([7, 7])).toBeNull();
  });
});

// --- Partition --------------------------------------------------------------------------------

describe('partitionMany', () => {
  const { base, root } = parseShardQuery(BASE_QUERY);

  it('tiles the root with leaves under splitAt that hold every developer exactly once', async () => {
    const population = makePopulation({
      n: 4200,
      from: root.from,
      to: root.to,
      followers: (r) => 2 + Math.floor(r() * 40)
    });
    const { count } = counter(population);
    const { leaves, startCounts, stats } = await partitionMany([{ slice: root }], { base, count });

    expect(() => assertTiling(root, leaves)).not.toThrow();
    leaves.forEach((leaf) => expect(leaf.count).toBeLessThan(SPLIT_AT));
    expect(startCounts).toEqual([4200]);
    expect(leaves.reduce((s, l) => s + l.count, 0)).toBe(4200);
    expect(membership(population, base, leaves)).toEqual(new Set([1]));
    expect(stats.additivityMismatches).toEqual([]);
    expect(stats.additivityChecks).toBeGreaterThan(0);
    // Breadth-first: one count call per level, not one per slice.
    expect(stats.countCalls).toBe(stats.levels + 1);
  });

  it('stops after one call when the root is already under splitAt', async () => {
    const population = makePopulation({ n: 12, from: root.from, to: root.to });
    const { count, calls } = counter(population);
    const { leaves } = await partitionMany([{ slice: root }], { base, count });
    expect(leaves).toHaveLength(1);
    expect(calls.count).toBe(1);
  });

  it('uses a known start count without spending a request on it', async () => {
    const population = makePopulation({ n: 20, from: root.from, to: root.to });
    const { count, calls } = counter(population);
    await partitionMany([{ slice: root, count: 20 }], { base, count });
    expect(calls.count).toBe(0);
  });

  it('splits a day that is dense on its own intra-day, at second precision', async () => {
    const d = day('2023-01-10');
    const population = [
      ...makePopulation({ n: 150, from: d, to: d + DAY_SECONDS - 1, seed: 7 }),
      ...makePopulation({ n: 400, from: root.from, to: root.to, seed: 8 })
    ];
    const { leaves } = await partitionMany([{ slice: root }], { base, ...counter(population) });
    expect(leaves.some((l) => l.slice.to - l.slice.from + 1 < DAY_SECONDS)).toBe(true);
    expect(membership(population, base, leaves)).toEqual(new Set([1]));
  });

  it('falls back to followers ranges when a single second is still too full', async () => {
    const t = day('2023-01-10') + 3600;
    const population = makePopulation({
      n: 250,
      from: t,
      to: t,
      followers: (r) => 2 + Math.floor(r() * 30)
    });
    const { leaves } = await partitionMany([{ slice: root }], { base, ...counter(population) });
    const atT = leaves.filter((l) => l.slice.from === t);
    expect(atT.length).toBeGreaterThan(1);
    expect(atT.every((l) => l.slice.to === t)).toBe(true);
    expect(leaves.every((l) => l.count < SPLIT_AT)).toBe(true);
    expect(() => assertTiling(root, leaves)).not.toThrow();
    expect(membership(population, base, leaves)).toEqual(new Set([1]));
  });

  it('ends with an irreducible leaf when nothing can split a slice further', async () => {
    const t = day('2023-01-10');
    const population = makePopulation({ n: 150, from: t, to: t, followers: () => 3 });
    const { leaves } = await partitionMany([{ slice: root }], { base, ...counter(population) });
    const stuck = leaves.filter((l) => l.irreducible);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].slice).toEqual({ from: t, to: t, followers: [3, 3] });
    expect(stuck[0].count).toBe(150);
  });

  it('throws rather than looping when the counter returns a constant', async () => {
    const count = async (queries) => queries.map(() => 5000);
    await expect(partitionMany([{ slice: root }], { base, count })).rejects.toThrow(
      /budget exceeded/
    );
  });

  it('reports a split whose children do not add up to their parent', async () => {
    const population = makePopulation({ n: 200, from: root.from, to: root.to, seed: 4 });
    const honest = counter(population).count;
    let first = true;
    const count = async (queries) => {
      const totals = await honest(queries);
      if (!first) return totals;
      first = false;
      return totals.map((c) => c + 5); // the root reads high
    };
    const { stats } = await partitionMany([{ slice: root }], { base, count });
    expect(stats.additivityMismatches).toHaveLength(1);
    expect(stats.additivityMismatches[0].parent - stats.additivityMismatches[0].sum).toBe(5);
  });
});

// --- Tiling and packing -----------------------------------------------------------------------

describe('assertTiling', () => {
  const root = { from: 0, to: 99, followers: [2, Infinity] };
  const leaf = (from, to, followers = [2, Infinity]) => ({ slice: { from, to, followers } });

  it('accepts an exact tiling, in any order', () => {
    expect(assertTiling(root, [leaf(50, 99), leaf(0, 49)])).toBe(true);
    expect(
      assertTiling(root, [leaf(0, 49, [2, 5]), leaf(0, 49, [6, Infinity]), leaf(50, 99)])
    ).toBe(true);
  });

  it('rejects gaps, overlaps and overruns in either dimension', () => {
    expect(() => assertTiling(root, [leaf(0, 48), leaf(50, 99)])).toThrow(/Gap/);
    expect(() => assertTiling(root, [leaf(0, 50), leaf(50, 99)])).toThrow(/Overlap/);
    expect(() => assertTiling(root, [leaf(0, 49), leaf(50, 98)])).toThrow(/Gap/);
    expect(() => assertTiling(root, [leaf(0, 49), leaf(50, 100)])).toThrow(/past the root/);
    expect(() =>
      assertTiling(root, [leaf(0, 49, [2, 5]), leaf(0, 49, [7, Infinity]), leaf(50, 99)])
    ).toThrow(/Gap in followers/);
    expect(() =>
      assertTiling(root, [leaf(0, 49, [2, 5]), leaf(0, 49, [5, Infinity]), leaf(50, 99)])
    ).toThrow(/Overlap in followers/);
    expect(() => assertTiling(root, [leaf(0, 49, [2, 5]), leaf(50, 99)])).toThrow(/stops short/);
  });
});

describe('packLeaves', () => {
  const root = { from: 0, to: 399, followers: [2, Infinity] };
  const leaf = (from, to, count, followers = [2, Infinity]) => ({
    slice: { from, to, followers },
    count
  });

  it('packs neighbours up to the limit and keeps the tiling', () => {
    const packed = packLeaves(
      root,
      [leaf(0, 99, 30), leaf(100, 199, 40), leaf(200, 299, 50), leaf(300, 399, 10)],
      80
    );
    expect(packed.map((l) => [l.slice.from, l.slice.to, l.count])).toEqual([
      [0, 199, 70],
      [200, 399, 60]
    ]);
  });

  it('merges followers sub-ranges back before merging across time', () => {
    const packed = packLeaves(
      root,
      [leaf(0, 99, 10, [2, 5]), leaf(0, 99, 5, [6, Infinity]), leaf(100, 399, 20)],
      PACK_TO
    );
    expect(packed.map((l) => [l.slice.from, l.slice.to, l.slice.followers, l.count])).toEqual([
      [0, 399, [2, Infinity], 35]
    ]);
  });

  it('never merges an irreducible leaf', () => {
    const stuck = { ...leaf(0, 0, 120, [3, 3]), irreducible: true };
    const packed = packLeaves(
      { from: 0, to: 99, followers: [2, Infinity] },
      [leaf(0, 0, 1, [2, 2]), stuck, leaf(0, 0, 2, [4, Infinity]), leaf(1, 99, 5)],
      PACK_TO
    );
    expect(packed.find((l) => l.irreducible).count).toBe(120);
    expect(packed).toHaveLength(4);
  });
});

describe('partitionRoots', () => {
  const { base } = parseShardQuery(BASE_QUERY);
  const ranges = MULTI_RANGE_QUERIES.map((q) => parseShardQuery(q).root);

  it('partitions several ranges in one breadth-first pass and packs each into single pages', async () => {
    const population = ranges.flatMap((r, i) =>
      makePopulation({
        n: 900 + 400 * i,
        from: r.from,
        to: Math.min(r.to, day('2026-10-13')),
        seed: 30 + i,
        followers: (rand) => 2 + Math.floor(rand() * 20)
      })
    );
    const { count, calls } = counter(population);
    const { roots, stats } = await partitionRoots(ranges, { base, count });

    expect(roots.map((r) => r.count)).toEqual([900, 1300, 1700]);
    // One count call per level across all three ranges, not per range.
    expect(calls.count).toBe(stats.levels + 1);
    for (const r of roots) {
      expect(r.leaves.every((l) => l.count <= PACK_TO)).toBe(true);
      expect(r.leaves.length).toBeGreaterThanOrEqual(Math.ceil(r.count / PACK_TO));
      expect(r.leaves.length).toBeLessThan(r.fineLeaves);
      expect(r.leaves.reduce((s, l) => s + l.count, 0)).toBe(r.count);
    }
    expect(
      membership(
        population,
        base,
        roots.flatMap((r) => r.leaves)
      )
    ).toEqual(new Set([1]));
  });

  it('refuses overlapping ranges, which would list a developer twice', async () => {
    const overlapping = [ranges[0], { ...ranges[1], from: ranges[0].to }];
    await expect(partitionRoots(overlapping, { base, ...counter([]) })).rejects.toThrow(/overlap/);
  });
});
