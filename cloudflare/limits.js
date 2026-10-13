// Values worker.js and its tests share. They live outside worker.js because local workerd treats
// every named export of the entry module as a possible handler, and refuses to start a module
// that exports a number: "Incorrect type for map entry 'RATE_LIMIT_MAX_REQUESTS': the provided
// value is not of type 'function or ExportedHandler'" (wrangler dev 4.127, 2026-10-13). The
// deployed runtime has tolerated it since #74, but `wrangler dev` could not run the Worker at all.

export const RATE_LIMIT_MAX_REQUESTS = 20;
export const GITHUB_USERNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
