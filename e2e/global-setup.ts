import { apiUrlFrom, probeHealth } from './health.js';

const HINT = [
  'El stack E2E no responde. Levantalo antes de correr la suite:',
  '',
  '  npm run e2e:up',
  '',
  'Levanta Postgres, Redis, el API y el worker en sus puertos aislados, aplica las',
  'migraciones y siembra el fixture real de velas. Para derribarlo: npm run e2e:down.',
].join('\n');

export default async function globalSetup(): Promise<void> {
  const apiUrl = apiUrlFrom(process.env);
  const url = `${apiUrl}/api/health`;

  let health;
  try {
    health = await probeHealth({ url });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${HINT}\n\nNo se ha podido llamar a ${url}: ${reason}`);
  }

  if (health === undefined) {
    throw new Error(`${HINT}\n\n${url} responde, pero no da db y redis en "ok".`);
  }

  console.log(`[e2e] API "${health.status}" en ${url} (version ${health.version})`);
}
