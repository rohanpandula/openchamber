import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assignInjectedEnv } from '@openchamber/web/server/lib/injected-env.js';

const configSchema = z.object({
  binary: z.string().min(1),
  args: z.string(),
  provider: z.string().min(1),
  model: z.string().min(1),
  hostFile: z.string().min(1).optional(),
}).strict();

export function configureDeepSeekDesktop({ environment = process.env, homeDir, appDataDir, platform = process.platform }) {
  const dataDir = environment.OPENCHAMBER_DATA_DIR || path.join(homeDir, '.config', 'openchamber-dsh-v2');
  assignInjectedEnv(environment, {
    OPENCHAMBER_DATA_DIR: dataDir,
    OPENCHAMBER_DESKTOP_USER_DATA_DIR: environment.OPENCHAMBER_DESKTOP_USER_DATA_DIR || path.join(appDataDir, 'OpenChamber DSH 2'),
    OPENCHAMBER_RELAY_HOST: environment.OPENCHAMBER_RELAY_HOST || 'off',
  });
  if (platform === 'darwin') {
    assignInjectedEnv(environment, {
      XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME || path.join(dataDir, 'runtime-config'),
      XDG_DATA_HOME: environment.XDG_DATA_HOME || path.join(dataDir, 'runtime-data'),
    });
  }
  let contents;
  try {
    contents = fs.readFileSync(path.join(dataDir, 'deepseek.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const config = configSchema.parse(JSON.parse(contents));
  assignInjectedEnv(environment, {
    DEEPSEEK_DSH_BIN: environment.DEEPSEEK_DSH_BIN || config.binary,
    DEEPSEEK_DSH_ARGS: environment.DEEPSEEK_DSH_ARGS ?? config.args,
    DEEPSEEK_PROVIDER: environment.DEEPSEEK_PROVIDER || config.provider,
    DEEPSEEK_MODEL: environment.DEEPSEEK_MODEL || config.model,
  });
  if (config.hostFile) assignInjectedEnv(environment, { DEEPSEEK_HOST_FILE: environment.DEEPSEEK_HOST_FILE || config.hostFile });
}
