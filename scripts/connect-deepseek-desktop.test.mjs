import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { connectDeepSeekDesktop } from './connect-deepseek-desktop.mjs';

test('installing twice preserves the profile and stores no host credential in configuration', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-connect-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dataDir = path.join(home, '.config', 'openchamber-dsh-v2');
  const profile = path.join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  await fs.mkdir(path.dirname(profile), { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(profile, '- id: keep-me\n  disabled: true\n');
  const config = { binary: '/dsh', args: '--profile acp', provider: 'test', model: 'model' };
  await fs.writeFile(path.join(dataDir, 'deepseek.json'), JSON.stringify(config));
  await connectDeepSeekDesktop({ home, dataDir });
  const first = await fs.readFile(profile, 'utf8');
  await connectDeepSeekDesktop({ home, dataDir });
  assert.equal(await fs.readFile(profile, 'utf8'), first);
  assert.ok(first.startsWith('- id: keep-me\n  disabled: true\n'));
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'deepseek.json'), 'utf8'));
  assert.deepEqual(saved, { ...config, hostFile: path.join(dataDir, 'harness', 'connection.json') });
  assert.equal((await fs.stat(path.join(dataDir, 'harness'))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dataDir, 'deepseek.json'))).mode & 0o777, 0o600);
});
