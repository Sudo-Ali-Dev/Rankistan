import { describe, it, expect } from 'vitest';
import {
  AMBIGUOUS_TERMS,
  CITY_TERMS,
  COUNTRY_TERM,
  FOREIGN_MARKERS,
  cityTwinQuery,
  foreignMarker,
  locationTokens
} from './locations.js';
import { parseShardQuery, toQuery } from './partition.js';
import { makePopulation, matcher } from './fake-search.js';
import { SEARCH_BATCHES } from '../fetch-devs.js';

const MAIN_QUERIES = SEARCH_BATCHES.flatMap((b) => b.queries || [b.q]);
const TWIN_BASE = [
  ...CITY_TERMS.map((city) => `location:${city}`),
  '-location:pakistan',
  'type:user repos:>3'
].join(' ');

describe('the city list', () => {
  it('holds the fifteen measured cities, each one search token', () => {
    expect(CITY_TERMS).toHaveLength(15);
    expect(new Set(CITY_TERMS).size).toBe(15);
    for (const city of CITY_TERMS) expect(locationTokens(city)).toEqual([city]);
  });

  it('carries none of the ambiguous names, the country, or a foreign marker', () => {
    for (const term of [...AMBIGUOUS_TERMS, ...FOREIGN_MARKERS, COUNTRY_TERM]) {
      expect(CITY_TERMS).not.toContain(term);
    }
    expect(AMBIGUOUS_TERMS).toEqual(
      expect.arrayContaining(['hyderabad', 'punjab', 'kashmir', 'mirpur', 'gujrat', 'hub'])
    );
  });

  it('is frozen, so nothing can widen the search at run time', () => {
    expect(Object.isFrozen(CITY_TERMS)).toBe(true);
    expect(Object.isFrozen(FOREIGN_MARKERS)).toBe(true);
  });
});

describe('cityTwinQuery', () => {
  it('swaps location:pakistan for every city and its negation, and keeps the rest in place', () => {
    const main = SEARCH_BATCHES[22].q;
    expect(cityTwinQuery(main)).toBe(`${TWIN_BASE} followers:>1 created:2024-08-01..2024-12-31`);
  });

  it('gives every batch range a twin the partitioner accepts and rebuilds byte for byte', () => {
    expect(MAIN_QUERIES).toHaveLength(26);
    for (const main of MAIN_QUERIES) {
      const twin = cityTwinQuery(main);
      const { base, root } = parseShardQuery(twin);
      expect(base).toBe(TWIN_BASE);
      expect(toQuery(base, root)).toBe(twin);
      // The same range and follower floor as the main query: only the location clause differs.
      expect(root).toEqual(parseShardQuery(main).root);
    }
  });

  it("gives a multi-range batch's twins one shared base, as discoverBatch requires", () => {
    const bases = SEARCH_BATCHES[23].queries.map((q) => parseShardQuery(cityTwinQuery(q)).base);
    expect(new Set(bases).size).toBe(1);
  });

  it('refuses a query whose location clause is not exactly location:pakistan', () => {
    const tail = 'type:user repos:>3 followers:>1 created:2024-08-01..2024-12-31';
    expect(() => cityTwinQuery(tail)).toThrow(/exactly one location:pakistan/);
    expect(() => cityTwinQuery(`location:lahore ${tail}`)).toThrow(/exactly one/);
    expect(() => cityTwinQuery(`location:pakistan location:lahore ${tail}`)).toThrow(/exactly one/);
    expect(() => cityTwinQuery(`-location:pakistan ${tail}`)).toThrow(/exactly one/);
    // A twin is not a main query: twinning it again would be a different search.
    expect(() => cityTwinQuery(cityTwinQuery(`location:pakistan ${tail}`))).toThrow(/exactly one/);
  });
});

describe('the partitioner with the twin base', () => {
  const twin = cityTwinQuery(SEARCH_BATCHES[22].q);
  const { base, root } = parseShardQuery(twin);

  it('still refuses a second created:, which would make GitHub match everyone', () => {
    expect(() => parseShardQuery(`${twin} created:2024-09-01`)).toThrow(/repeats created/);
    expect(() => toQuery(`${base} created:2024-09-01`, root)).toThrow(/must not carry/);
  });

  it('still refuses a repeated followers:, which GitHub would OR', () => {
    expect(() => parseShardQuery(`${twin} followers:2..5`)).toThrow(/repeats followers/);
    expect(() => toQuery(`${base} followers:>1`, root)).toThrow(/must not carry/);
  });

  it('still emits exactly one created: and one followers: per slice', () => {
    const slice = { ...root, to: root.from + 3599, followers: [6, 13] };
    const tokens = toQuery(base, slice).split(' ');
    expect(tokens.filter((t) => t.startsWith('created:'))).toHaveLength(1);
    expect(tokens.filter((t) => t.startsWith('followers:'))).toHaveLength(1);
    expect(tokens.filter((t) => t.startsWith('location:'))).toHaveLength(15);
    expect(tokens.filter((t) => t === '-location:pakistan')).toHaveLength(1);
  });

  it('selects exactly the city-only developers the main query cannot see', () => {
    const where = [
      'Lahore',
      'Karachi,Sindh',
      'Islamabad / Rawalpindi',
      'Lahore, Pakistan',
      'Pakistan',
      'Hyderabad, Sindh',
      'Berlin',
      ''
    ];
    const people = makePopulation({
      n: where.length * 5,
      from: root.from,
      to: root.to,
      location: (_, i) => where[i % where.length]
    });
    const inTwin = people.filter(matcher(twin));
    const inMain = people.filter(matcher(SEARCH_BATCHES[22].q));
    expect(new Set(inTwin.map((u) => u.location))).toEqual(
      new Set(['Lahore', 'Karachi,Sindh', 'Islamabad / Rawalpindi'])
    );
    expect(new Set(inMain.map((u) => u.location))).toEqual(
      new Set(['Lahore, Pakistan', 'Pakistan'])
    );
    expect(inTwin.some((u) => inMain.includes(u))).toBe(false);
  });
});

describe('locationTokens', () => {
  it('splits on punctuation and whitespace, as GitHub search does', () => {
    expect(locationTokens('Karachi,Pakistan')).toEqual(['karachi', 'pakistan']);
    expect(locationTokens('  DHA Phase-6, Lahore. ')).toEqual(['dha', 'phase', '6', 'lahore']);
    expect(locationTokens('Islamabad🇵🇰')).toEqual(['islamabad']);
    expect(locationTokens(null)).toEqual([]);
  });
});

describe('foreignMarker', () => {
  it('passes Pakistani locations', () => {
    for (const location of [
      'Lahore',
      'Karachi, Sindh',
      'Islamabad / Rawalpindi',
      'Peshawar, KPK',
      'Multan, Punjab',
      'DHA Phase 6, Karachi',
      'Quetta, Balochistan',
      'Remote · Sialkot',
      '',
      null,
      undefined
    ]) {
      expect(foreignMarker(location)).toBeNull();
    }
  });

  it('rejects a location that also names a place outside Pakistan, in any case', () => {
    const cases = {
      'Hyderabad, India': 'india',
      'Islamabad, Telangana': 'telangana',
      'Vijayawada, Andhra Pradesh': 'andhra',
      'Ahmedabad, Gujarat': 'gujarat',
      Dhaka: 'dhaka',
      'Mirpur, Dhaka, Bangladesh': 'bangladesh',
      'Taipei, Taiwan': 'taiwan',
      Formosa: 'formosa',
      'Bangkok, THAILAND': 'thailand',
      'Lahore street, Warsaw, Poland': 'poland',
      'Karaj,Iran': 'iran',
      INDIA: 'india'
    };
    for (const [location, marker] of Object.entries(cases)) {
      expect(foreignMarker(location)).toBe(marker);
    }
  });

  it('matches whole tokens only', () => {
    expect(foreignMarker('Indianapolis, Indiana')).toBeNull();
    expect(foreignMarker('Iranian-born, Karachi')).toBeNull();
    expect(foreignMarker('Polandia')).toBeNull();
  });
});
