// Local launcher fallback while Bridge is stopped. Never opens DSH credentials or its runtime.
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { dataLock } from '../src/lock.js';
import { secureDirectory } from '../src/security.js';
const c = loadConfig(); let store, release;
try {
  secureDirectory(c.dataDir);
  release = dataLock(c.dataDir); store = new Store(path.join(c.dataDir, 'bridge.sqlite'));
  let input = ''; for await (const part of process.stdin) { input += part; if (input.length > 1024) throw Error(); }
  const { action, args } = JSON.parse(input);
  process.stdout.write(JSON.stringify({ result: store.sessionControl(action, args) }));
} catch (e) { process.stdout.write(JSON.stringify({ error: e.code ?? 'session-operation-failed' })); process.exitCode = 1; }
finally { store?.close(); release?.(); }
