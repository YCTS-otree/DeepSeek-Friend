import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { apiKeyEnvironment } from '../scripts/runtime-options.js';

function directory() {
  const dir = path.resolve('.research/test-state', 'key-' + randomUUID());
  fs.mkdirSync(dir, { recursive: true }); return dir;
}
test('API credential file is injected only into the child environment and never copied to inherited env', () => {
  const dir = directory(); const fake = 'sk-' + 'testfixture'.repeat(3); const inherited = { KEEP: 'value' };
  fs.writeFileSync(path.join(dir, 'DEEPSEEK_FRIEND.key'), '\uFEFF' + fake + '\r\n', { mode: 0o600 });
  const result = apiKeyEnvironment(dir, inherited);
  assert.equal(result.env.DEEPSEEK_API_KEY, fake); assert.equal(result.loaded, true);
  assert.equal(inherited.DEEPSEEK_API_KEY, undefined); assert.equal(result.env.KEEP, 'value');
});
test('explicit alternate API key path and missing-file failure do not expose content', () => {
  const dir = directory(); const file = path.join(dir, 'api.key'); const fake = 'sk-' + 'fixture'.repeat(4);
  fs.writeFileSync(file, fake, { mode: 0o600 });
  const result = apiKeyEnvironment(dir, { DEEPSEEK_FRIEND_KEY_FILE: file });
  assert.equal(result.env.DEEPSEEK_API_KEY, fake); assert.equal(result.env.DEEPSEEK_FRIEND_KEY_FILE, undefined);
  assert.throws(() => apiKeyEnvironment(dir, { DEEPSEEK_FRIEND_KEY_FILE: 'absent.key' }), { code: 'deepseek-key-file-missing' });
});
test('invalid/oversized API files fail closed; an absent default preserves manual setup', () => {
  const dir = directory(); assert.deepEqual(apiKeyEnvironment(dir, { KEEP: 'yes' }), { loaded: false, env: { KEEP: 'yes' } });
  const file = path.join(dir, 'DEEPSEEK_FRIEND.key'); const invalid = 'invalid-credential-format';
  fs.writeFileSync(file, invalid, { mode: 0o600 });
  assert.throws(() => apiKeyEnvironment(dir, {}), e => e.code === 'deepseek-key-file-invalid' && !e.message.includes(invalid));
  fs.writeFileSync(file, 'x'.repeat(257)); assert.throws(() => apiKeyEnvironment(dir, {}), { code: 'deepseek-key-file-invalid' });
});
