import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export async function connectDeepSeekDesktop({ home = os.homedir(), dataDir = process.env.OPENCHAMBER_DATA_DIR || path.join(home, '.config', 'openchamber-dsh-v2') } = {}) {
  const profile = path.join(home, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  const configFile = path.join(dataDir, 'deepseek.json');
  const [patch, config] = await Promise.all([fs.readFile(profile, 'utf8'), fs.readFile(configFile, 'utf8').then(JSON.parse)]);
  for (const key of ['binary', 'args', 'provider', 'model']) assert.match(config?.[key], /[\s\S]*/, `deepseek.json ${key} must be a string`);
  if (patch.includes('# OpenChamber shared Harness host') && !patch.includes('# End OpenChamber shared Harness host')) throw new Error('The saved OpenChamber bridge block is incomplete');
  const directory = path.join(dataDir, 'harness');
  const pluginFile = path.join(directory, 'host-discovery.mjs');
  const hostFile = path.join(directory, 'connection.json');
  const begin = '# OpenChamber shared Harness host';
  const end = '# End OpenChamber shared Harness host';
  const block = `${begin}\n- insert:\n    - id: openchamber-host-discovery\n      name: ${JSON.stringify(pluginFile)}\n      config:\n        file: ${JSON.stringify(hostFile)}\n${end}\n`;
  let nextPatch;
  if (patch.includes(begin)) nextPatch = patch.replace(new RegExp(`${begin}[\\s\\S]*?${end}\\n?`), block);
  else if (patch.includes('id: openchamber-host-discovery')) {
    if (!patch.includes(pluginFile) || !patch.includes(hostFile)) throw new Error('An existing OpenChamber bridge uses different paths; keep its configuration or remove that entry before reconnecting.');
    nextPatch = patch;
  } else nextPatch = `${patch.trimEnd()}\n\n${block}`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const plugin = await fs.readFile(new URL('../packages/web/server/lib/deepseek/host-discovery.mjs', import.meta.url));
  async function write(file, content) {
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, content, { mode: 0o600 });
    await fs.rename(temporary, file);
  }
  await write(pluginFile, plugin);
  if (patch !== nextPatch) await write(profile, nextPatch);
  await write(configFile, `${JSON.stringify({ ...config, hostFile }, null, 2)}\n`);
  return { profile, configFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await connectDeepSeekDesktop();
  console.log('Connected OpenChamber to the shared Harness host. Restart OpenChamber; Harness picks up the profile change automatically.');
}
