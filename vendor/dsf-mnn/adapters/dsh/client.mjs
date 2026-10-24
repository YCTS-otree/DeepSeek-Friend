import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

export function createClient({ python = 'python', database, resolveScope, timeoutMs = 10000 }) {
  if (!database || typeof resolveScope !== 'function' || !(timeoutMs > 0 && timeoutMs <= 60000)) throw new Error('mnn-trusted-binding-required');
  const db = path.resolve(database);
  return async function request(operation, payload, agent, signal) {
    signal?.throwIfAborted();
    // Scope comes from a trusted runtime binding, never from model tool arguments.
    const scope = await resolveScope(agent);
    if (scope.session_id !== agent.session.id) throw new Error('mnn-session-scope-mismatch');
    const body = JSON.stringify({ ...payload, scope, operation });
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error('mnn-request-budget');
    const operationSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    return new Promise((resolve, reject) => {
      const child = spawn(python, ['-m', 'dsf_mnn', '--db', db, 'rpc'], {
        cwd: projectRoot, windowsHide: true, signal: operationSignal,
        env: { ...process.env, PYTHONPATH: path.join(projectRoot, 'src'), PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '', bytes = 0, failed = false;
      child.stdout.setEncoding('utf8');
      child.on('error', () => { failed = true; reject(new Error('mnn-worker-unavailable-or-cancelled')); });
      child.stdin.on('error', () => {});
      child.stdout.on('data', data => {
        bytes += Buffer.byteLength(data);
        if (bytes > 4 * 1024 * 1024) { failed = true; child.kill(); reject(new Error('mnn-response-budget')); }
        else output += data;
      });
      // Do not forward arbitrary worker diagnostics or memory payloads into host logs.
      child.stderr.resume();
      child.on('close', code => {
        if (failed) return;
        if (code !== 0) return reject(new Error('mnn-worker-rejected'));
        try { resolve(JSON.parse(output)); } catch { reject(new Error('mnn-invalid-response')); }
      });
      child.stdin.end(body);
    });
  };
}
