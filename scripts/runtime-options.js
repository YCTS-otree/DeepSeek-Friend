import fs from 'node:fs';
import path from 'node:path';
export function profileArguments(home) {
  return ['--profile', 'weixin', ...(fs.existsSync(path.join(home, 'profiles/weixin/package.json')) ? [] : ['--from-default-profile', 'web'])];
}
