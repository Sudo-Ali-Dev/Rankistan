// Spot check of the contributions measurement, live:
//
//   GITHUB_TOKEN=... node scripts/measure/contributions-cli.js <login> [<login> ...]
//
// Prints each developer's decoded measurement as JSON lines on stdout, and progress on stderr.
// Kept apart from contributions.js so that module stays free of Node-only imports: the Worker's
// preview endpoint bundles it.
import {
  createShadowClient,
  decodeMeasurement,
  measureShadowContributions
} from './contributions.js';

const logins = process.argv.slice(2);
const token = process.env.MY_GITHUB_PAT || process.env.GITHUB_TOKEN;
if (logins.length === 0 || !token) {
  console.error('Usage: GITHUB_TOKEN=... node scripts/measure/contributions-cli.js <login> [...]');
  process.exit(2);
}

const client = createShadowClient({ token });
const log = { log: (line) => console.error(line), warn: (line) => console.error(line) };
try {
  const { blocks, failed } = await measureShadowContributions(
    logins.map((username) => ({ username })),
    { client, log }
  );
  for (const [login, block] of blocks) {
    const bytes = JSON.stringify(block).length;
    console.log(JSON.stringify({ login, bytes, measurement: decodeMeasurement(block) }));
  }
  for (const [login, reason] of failed) console.error(`${login}: not measured (${reason})`);
} catch (error) {
  console.error(error);
  process.exit(1);
}
