/**
 * A fake GitHub GraphQL endpoint answering every document of the contributions measurement
 * (scripts/measure/contributions.js), for tests only: the measurement's own tests and the
 * Worker's score preview, which runs the same measurement.
 */
import { RATE_LIMIT, respond } from '../discovery/fake-search.js';
import { measurementWindow, windowDate } from '../../src/model/measurement.js';

export const NOW = Date.parse('2026-10-14T09:30:00Z');
export const W = measurementWindow(NOW);

/** The instant of 10:00 Pakistan time on the window's day `offset`. */
export const at = (offset) => `${windowDate(W, offset)}T05:00:00Z`;
export const repo = (name, { fork = false, stars = 0, org = false, hidden = false } = {}) => ({
  nameWithOwner: name,
  isFork: fork,
  isPrivate: hidden,
  stargazerCount: stars,
  owner: { __typename: org ? 'Organization' : 'User', login: name.split('/')[0] }
});
export const page = (nodes, next = null) => ({
  totalCount: nodes.length + (next ? 1 : 0),
  pageInfo: { hasNextPage: Boolean(next), endCursor: next },
  nodes
});

/**
 * One developer as GitHub would answer every document of the measurement. `commits` maps a
 * repository to commits by window day (day -1 is the date before the window, which the query
 * range also returns).
 */
export function person(login, options = {}) {
  const {
    id = 1,
    commits = { [`${login}/app`]: { 0: 3, 4: 2 } },
    stars = {},
    prs = [],
    issues = [],
    reviews = [],
    accepted = [],
    maintained = [],
    future = [],
    history = {},
    restricted = 0,
    commitRepositories,
    prPages = [],
    acceptedPages = []
  } = options;
  const commitEntries = Object.entries(commits).map(([name, byDay]) => ({
    repository: repo(name, { stars: stars[name] ?? 0 }),
    contributions: {
      totalCount: Object.values(byDay).reduce((a, b) => a + b, 0),
      nodes: Object.entries(byDay).map(([offset, commitCount]) => ({
        occurredAt: `${windowDate(W, Number(offset))}T07:00:00Z`,
        commitCount
      }))
    }
  }));
  return {
    main: {
      login,
      databaseId: id,
      id: `U_${login}`,
      c: {
        restrictedContributionsCount: restricted,
        totalRepositoriesWithContributedCommits: commitRepositories ?? commitEntries.length,
        commitContributionsByRepository: commitEntries,
        pullRequestContributions: page(prs, prPages.length ? 'p1' : null),
        issueContributions: page(issues),
        pullRequestReviewContributions: page(reviews)
      },
      f: {
        commitContributionsByRepository: future.map((name) => ({
          repository: { nameWithOwner: name }
        }))
      }
    },
    prPages,
    accepted: {
      issueCount: accepted.length,
      pageInfo: { hasNextPage: acceptedPages.length > 0, endCursor: 'a1' },
      nodes: accepted
    },
    acceptedPages,
    maintained: {
      issueCount: maintained.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: maintained
    },
    history
  };
}

export const prNode = (offset, name, { merged = false, state = 'OPEN', number = 1 } = {}) => ({
  occurredAt: at(offset),
  pullRequest: { number, state, merged, repository: repo(name) }
});
export const reviewNode = (offset, name, author, number = 1, association = 'CONTRIBUTOR') => ({
  occurredAt: at(offset),
  pullRequestReview: { authorAssociation: association },
  pullRequest: {
    number,
    author: author
      ? { __typename: 'User', login: author, createdAt: '2015-01-01T00:00:00Z' }
      : null,
    repository: repo(name, { stars: 10 })
  }
});
export const mergedNode = (
  offset,
  name,
  merger,
  { number = 1, additions = 10, deletions = 2, files = 2, stars = 100, approvers = [] } = {}
) => ({
  number,
  reviews: {
    nodes: approvers.map(([login, createdAt]) => ({
      author: { __typename: 'User', login, createdAt }
    }))
  },
  mergedAt: at(offset),
  additions,
  deletions,
  changedFiles: files,
  mergedBy: merger
    ? { __typename: 'User', login: merger, createdAt: '2014-05-05T00:00:00Z' }
    : null,
  author: { __typename: 'User', login: merger || 'someone', createdAt: '2014-05-05T00:00:00Z' },
  repository: {
    ...repo(name, { stars }),
    owner: {
      __typename: 'Organization',
      login: name.split('/')[0],
      createdAt: '2016-01-01T00:00:00Z'
    }
  }
});

/** A fake GraphQL endpoint answering every document of the measurement from `people`. */
export function fakeGitHub(people, { onRequest } = {}) {
  const calls = [];
  const byLogin = (login) => people[String(login).toLowerCase()];
  async function fetchImpl(_url, init) {
    const { query, variables } = JSON.parse(init.body);
    const kind = query.includes('fragment Measure')
      ? 'main'
      : query.includes('contributionCalendar')
        ? 'calendar'
        : query.includes('history(')
          ? 'integrity'
          : query.includes('$after') && query.includes('user(login: $login)')
            ? 'page'
            : query.includes('$after')
              ? 'search-page'
              : 'search';
    const call = { kind, variables, query };
    calls.push(call);
    const override = onRequest?.({ ...call, n: calls.length });
    if (override) return override;
    const data = { rateLimit: RATE_LIMIT };
    const errors = [];
    if (kind === 'main' || kind === 'calendar') {
      Object.keys(variables)
        .filter((k) => /^l\d+$/.test(k))
        .forEach((k) => {
          const alias = `u${k.slice(1)}`;
          const p = byLogin(variables[k]);
          if (!p) {
            data[alias] = null;
            errors.push({ type: 'NOT_FOUND', path: [alias] });
          } else if (kind === 'main') {
            data[alias] = p.main;
          } else {
            const days = (p.calendar || [1, 0, 2]).map((n, i) => ({
              date: `d${i}`,
              contributionCount: n
            }));
            data[alias] = {
              login: p.main.login,
              databaseId: p.main.databaseId,
              c: { contributionCalendar: { weeks: [{ contributionDays: days }] } }
            };
          }
        });
    } else if (kind === 'page') {
      const p = byLogin(variables.login);
      const next = p.prPages.shift();
      data.u0 = {
        login: p.main.login,
        c: {
          pullRequestContributions: page(
            next || [],
            p.prPages.length ? `p${p.prPages.length}` : null
          )
        }
      };
    } else if (kind === 'search') {
      Object.keys(variables).forEach((k) => {
        const login = variables[k]
          .match(/author:(\S+)|user:(\S+)/)
          .slice(1)
          .find(Boolean);
        const p = byLogin(login);
        data[k.slice(1)] = k.startsWith('qa') ? p.accepted : p.maintained;
      });
    } else if (kind === 'search-page') {
      const login = variables.q.match(/author:(\S+)/)[1];
      const p = byLogin(login);
      data.s = {
        issueCount: 0,
        pageInfo: { hasNextPage: p.acceptedPages.length > 1, endCursor: 'a2' },
        nodes: p.acceptedPages.shift() || []
      };
    } else {
      Object.keys(variables)
        .filter((k) => /^o\d+$/.test(k))
        .forEach((k) => {
          const i = k.slice(1);
          const name = `${variables[`o${i}`]}/${variables[`n${i}`]}`;
          const owner = Object.values(people).find((p) => p.main.id === variables[`a${i}`]);
          // A repository without a given history answers with one commit on each day it is
          // credited, as GitHub would for a history nobody rewrote.
          const nodes =
            owner?.history[name] ??
            (
              owner?.main.c.commitContributionsByRepository.find(
                (e) => e.repository.nameWithOwner === name
              )?.contributions.nodes || []
            )
              .slice(0, 20)
              .map((d, j) => ({
                oid: `${name}-${j}`,
                authoredDate: d.occurredAt,
                committedDate: d.occurredAt,
                committer: { name: 'dev', user: null }
              }));
          data[`r${i}`] = { defaultBranchRef: { target: { history: { nodes } } } };
        });
    }
    return respond(200, errors.length ? { data, errors } : { data });
  }
  return { fetchImpl, calls };
}
