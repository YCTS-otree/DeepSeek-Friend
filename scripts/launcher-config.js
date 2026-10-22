import { loadConfig } from '../src/config.js';
const c = loadConfig();
// Never serialize the full configuration: it can contain environment credentials.
process.stdout.write(JSON.stringify({ baseUrl: c.dsh.baseUrl }));
