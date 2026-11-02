import { it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { apply } from './host-discovery.mjs';

it('publishes a private connection file and does not remove a newer host on disposal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-discovery-'));
  const file = path.join(root, 'private', 'connection.json');
  let dispose;
  try {
    await apply({ connection: { authenticatedUrl: (url) => `${url}?token=test-only` }, webServer: { protocol: 'http:', port: 1234 }, on: (_event, callback) => { dispose = callback; } }, { file });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).url).toBe('http://127.0.0.1:1234/?token=test-only');
    await fs.writeFile(file, 'newer host');
    await dispose();
    expect(await fs.readFile(file, 'utf8')).toBe('newer host');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
