import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const name of ['../.env.e2e', '../.env.e2e.host']) {
  const file = fileURLToPath(new URL(name, import.meta.url));
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}
