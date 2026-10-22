import net from 'node:net';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { BridgeError } from './util.js';

export function dataLock(dir) {
  const lock = new DatabaseSync(path.join(dir, 'instance-lock.sqlite'));
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
  catch { lock.close(); throw new BridgeError('instance-running', '此 data 目录已有实例运行'); }
  return () => lock.close();
}
export async function accountLock(account) {
  const id = createHash('sha256').update(account).digest('hex');
  const address = process.platform === 'win32' ? '\\\\.\\pipe\\dsfriend-' + id : '\0dsfriend-' + id;
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', () => reject(new BridgeError('account-running', '同一微信账号已有轮询实例（或无法取得账号锁）'))); server.listen(address, resolve); });
  return () => new Promise(resolve => server.close(resolve));
}
