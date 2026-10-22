import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from '../src/util.js';
export function profileArguments(home) {
  return ['--profile', 'weixin', ...(fs.existsSync(path.join(home, 'profiles/weixin/package.json')) ? [] : ['--from-default-profile', 'web'])];
}
export function apiKeyEnvironment(root, inherited = process.env) {
  const env = { ...inherited };
  const explicit = inherited.DEEPSEEK_FRIEND_KEY_FILE;
  const file = path.resolve(root, explicit ?? 'DEEPSEEK_FRIEND.key');
  if (!fs.existsSync(file)) {
    if (explicit) throw new BridgeError('deepseek-key-file-missing');
    return { env, loaded: false };
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 19 || stat.size > 256) throw new BridgeError('deepseek-key-file-invalid');
  // Only for a user-confirmed DeepSeek API key file. Never print the credential or include it in errors.
  const value = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
  if (!/^sk-[A-Za-z0-9_-]{16,128}$/.test(value)) throw new BridgeError('deepseek-key-file-invalid');
  env.DEEPSEEK_API_KEY = value;
  delete env.DEEPSEEK_FRIEND_KEY_FILE;
  return { env, loaded: true };
}
