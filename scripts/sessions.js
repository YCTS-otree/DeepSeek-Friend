// Local launcher fallback while Bridge is stopped. Never opens DSH credentials or its runtime.
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { dataLock } from '../src/lock.js';
import { secureDirectory } from '../src/security.js';
import { RuntimeStore } from '../src/runtime.js';
import { control } from '../src/controls.js';
const c = loadConfig(); let store, release, runtime;
try {
  secureDirectory(c.dataDir);
  release = dataLock(c.dataDir); store = new Store(path.join(c.dataDir, 'bridge.sqlite'));
  runtime = new RuntimeStore(c.dataDir);
  let input = ''; for await (const part of process.stdin) { input += part; if (input.length > 65536) throw Error(); }
  const { action, args } = JSON.parse(input);
  process.stdout.write(JSON.stringify({ result: await control({ store, runtime, config: c }, action, args) }));
} catch (e) { process.stdout.write(JSON.stringify({ error: e.code ?? 'session-operation-failed' })); process.exitCode = 1; }
finally { runtime?.close(); store?.close(); release?.(); }
