import fs from 'node:fs/promises';
import path from 'node:path';

export const name = 'openchamber-host-discovery';
export const inject = ['connection', 'webServer'];

// This runs inside Harness, so it uses the same authenticated host as its desktop UI.
export async function apply(ctx, config) {
  if (!path.isAbsolute(config?.file)) {
    throw new Error('OpenChamber discovery requires an absolute connection-file path');
  }
  const file = config.file;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const contents = JSON.stringify({
    version: 1,
    pid: process.pid,
    url: ctx.connection.authenticatedUrl(`${ctx.webServer.protocol}//127.0.0.1:${ctx.webServer.port}/`),
  });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, contents, { mode: 0o600 });
  await fs.rename(temporary, file);
  ctx.on('dispose', async () => {
    if (await fs.readFile(file, 'utf8').catch(() => null) === contents) {
      await fs.unlink(file).catch(() => {});
    }
  });
}
