/**
 * Who discovery counts as Pakistani when their location never says "Pakistan".
 *
 * The main search is `location:pakistan`, and GitHub matches the location field by whole token,
 * with no stemming and no substring match: "Lahore" alone does not match it, however obviously
 * Pakistani it is. Measured on 2026-10-13, 8,836 developers with `type:user repos:>3 followers:>1`
 * name one of the cities below and not the word "Pakistan", against 26,002 who do name it - a
 * third more people the board could never see.
 *
 * So every batch also runs a city twin: the same `created:` range, with `location:pakistan`
 * replaced by one `location:` qualifier per city and `-location:pakistan`. GitHub ORs repeated
 * `location:` qualifiers and ANDs the negation, so the twin holds exactly the people the main
 * query cannot reach and nobody it already lists. Both were verified live on 2026-10-13: dropping
 * any one city from the twin removes exactly the developers only that city matches (Mardan, the
 * last of fifteen, still removes 4), the order of the qualifiers does not change the count, and
 * the full twin - 350 characters, past the 256 GitHub's REST documentation gives as a limit - is
 * filtered by its trailing `created:` exactly as a short query is.
 */

/** The country term the main query searches on. The twin excludes it. */
export const COUNTRY_TERM = 'pakistan';

/**
 * Each of these, searched with `-location:pakistan`, sampled 30 of 30 Pakistani on 2026-10-13,
 * and overlaps the main query by about 0%. Together they hold about 89% of what naming a city
 * without the country adds. Lahore (2,658), Islamabad (2,419) and Karachi (2,403) are 85% of the
 * 8,836; Mardan, the smallest, is 30.
 *
 * A term goes here only if a sample of its matches is Pakistani, not because the city is.
 */
export const CITY_TERMS = Object.freeze([
  'lahore',
  'karachi',
  'islamabad',
  'rawalpindi',
  'peshawar',
  'faisalabad',
  'multan',
  'quetta',
  'sialkot',
  'gujranwala',
  'abbottabad',
  'bahawalpur',
  'sargodha',
  'sukkur',
  'mardan'
]);

/**
 * Left out on purpose, as ambiguous:
 *   hyderabad  matches mostly Hyderabad, India
 *   mirpur     matches mostly Mirpur, Dhaka
 *   gujrat     matches mostly a misspelling of Gujarat, India
 *   punjab     a region on both sides of the border
 *   kashmir    likewise
 *   hub        an ordinary word as well as a town
 *   lhr, pak   abbreviations that also stand for other things
 * src/utils/location.js maps several of these to Pakistani cities for the Map. That is safe there,
 * where everyone has already been found by a Pakistani search, and unsafe as a membership test.
 */
export const AMBIGUOUS_TERMS = Object.freeze([
  'hyderabad',
  'punjab',
  'kashmir',
  'mirpur',
  'gujrat',
  'hub',
  'lhr',
  'pak'
]);

/**
 * A city-sourced developer whose location also names one of these is not counted. Applied to the
 * 2026-10-13 samples, this list removed every false positive the city terms let in.
 */
export const FOREIGN_MARKERS = Object.freeze([
  'india',
  'telangana',
  'andhra',
  'gujarat',
  'bangladesh',
  'dhaka',
  'taiwan',
  'formosa',
  'thailand',
  'poland',
  'iran'
]);

/** How discovery found a developer, published on the row as `discovery_source`. */
export const DISCOVERY_SOURCES = Object.freeze({
  /** Matched `location:pakistan`. */
  PAKISTAN: 'pakistan',
  /** Matched a CITY_TERMS city and not "pakistan". */
  CITY: 'city',
  /** Not found by search: listed in public/registered_devs.json. */
  REGISTERED: 'registered'
});

/**
 * A location as GitHub tokenizes it for search: lower-cased, split on anything that is not a
 * letter or a digit, so "Karachi,Pakistan" is two tokens, as it is to GitHub.
 */
export function locationTokens(location) {
  return String(location ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * The first FOREIGN_MARKERS token in a location, or null when it names none. Token-wise, so
 * "Indiana" or "Iranian" is not "india" or "iran". Pure.
 */
export function foreignMarker(location) {
  const tokens = new Set(locationTokens(location));
  return FOREIGN_MARKERS.find((marker) => tokens.has(marker)) ?? null;
}

const COUNTRY_QUALIFIER = `location:${COUNTRY_TERM}`;
const mentionsLocation = (token) => /^-?location:/i.test(token);

/**
 * The city twin of one main batch query: `location:pakistan` replaced by every CITY_TERMS
 * qualifier and `-location:pakistan`, every other qualifier kept in place.
 *
 *   location:pakistan type:user repos:>3 followers:>1 created:2024-08-01..2024-12-31
 *   -> location:lahore ... location:mardan -location:pakistan type:user repos:>3 followers:>1
 *      created:2024-08-01..2024-12-31
 *
 * Refuses a query that does not carry exactly one `location:pakistan` and no other location
 * qualifier: the twin is defined as the main query's complement within the cities, and a query
 * already narrowed or widened by location would make it something else.
 */
export function cityTwinQuery(query) {
  const tokens = String(query).trim().split(/\s+/).filter(Boolean);
  const locations = tokens.filter(mentionsLocation);
  if (locations.length !== 1 || locations[0] !== COUNTRY_QUALIFIER) {
    throw new Error(`A city twin needs exactly one ${COUNTRY_QUALIFIER} and no other: ${query}`);
  }
  return tokens
    .flatMap((token) =>
      token === COUNTRY_QUALIFIER
        ? [...CITY_TERMS.map((city) => `location:${city}`), `-${COUNTRY_QUALIFIER}`]
        : [token]
    )
    .join(' ');
}
