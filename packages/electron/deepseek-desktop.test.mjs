import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configureDeepSeekDesktop } from './deepseek-desktop.mjs';
import { withoutInjectedEnv } from '@openchamber/web/server/lib/injected-env.js';

const config = { binary: '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh', args: '--profile acp', provider: 'test', model: 'test-model' };
const fixture = (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-dsh-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const appDataDir = path.join(homeDir, 'Library', 'Application Support');
  const dataDir = path.join(homeDir, '.config', 'openchamber-dsh-v2');
  fs.mkdirSync(dataDir, { recursive: true });
  return { homeDir, appDataDir, dataDir, platform: 'darwin' };
};

test('a rebuilt app restores the same DeepSeek profile and data without storing credentials in the bundle', (t) => {
  const paths = fixture(t);
  fs.writeFileSync(path.join(paths.dataDir, 'deepseek.json'), JSON.stringify(config));
  for (let launch = 0; launch < 2; launch += 1) {
    const environment = {};
    configureDeepSeekDesktop({ environment, ...paths });
    assert.equal(environment.DEEPSEEK_DSH_BIN, config.binary);
    assert.equal(environment.DEEPSEEK_DSH_ARGS, config.args);
    assert.equal(environment.DEEPSEEK_PROVIDER, config.provider);
    assert.equal(environment.DEEPSEEK_MODEL, config.model);
    assert.equal(environment.OPENCHAMBER_DATA_DIR, paths.dataDir);
    assert.equal(environment.OPENCHAMBER_DESKTOP_USER_DATA_DIR, path.join(paths.appDataDir, 'OpenChamber DSH 2'));
    assert.equal(environment.XDG_DATA_HOME, path.join(paths.dataDir, 'runtime-data'));
    assert.equal(environment.OPENCHAMBER_RELAY_HOST, 'off');
    assert.deepEqual(withoutInjectedEnv(environment), {});
  }
});

test('explicit environment values keep priority over the saved profile', (t) => {
  const paths = fixture(t);
  fs.writeFileSync(path.join(paths.dataDir, 'deepseek.json'), JSON.stringify(config));
  const environment = { DEEPSEEK_DSH_BIN: '/custom/dsh', DEEPSEEK_DSH_ARGS: '', DEEPSEEK_MODEL: 'custom', XDG_DATA_HOME: '/custom/data' };
  configureDeepSeekDesktop({ environment, ...paths });
  assert.equal(environment.DEEPSEEK_DSH_BIN, '/custom/dsh');
  assert.equal(environment.DEEPSEEK_DSH_ARGS, '');
  assert.equal(environment.DEEPSEEK_MODEL, 'custom');
  assert.equal(environment.XDG_DATA_HOME, '/custom/data');
  assert.equal(withoutInjectedEnv(environment).DEEPSEEK_MODEL, 'custom');
});

test('missing setup leaves DeepSeek disabled; corrupt or incomplete setup fails explicitly', (t) => {
  const paths = fixture(t);
  const environment = {};
  configureDeepSeekDesktop({ environment, ...paths });
  assert.equal(environment.DEEPSEEK_DSH_BIN, undefined);
  for (const contents of ['{broken', '{}']) {
    fs.writeFileSync(path.join(paths.dataDir, 'deepseek.json'), contents);
    assert.throws(() => configureDeepSeekDesktop({ environment: {}, ...paths }));
  }
});

test('Linux desktop services keep their normal XDG directories', (t) => {
  const paths = fixture(t);
  const environment = {};
  configureDeepSeekDesktop({ ...paths, environment, platform: 'linux' });
  assert.equal(environment.XDG_CONFIG_HOME, undefined);
  assert.equal(environment.XDG_DATA_HOME, undefined);
});

test('shared host configuration survives repeated packaged launches', (t) => {
  const paths = fixture(t);
  const hostFile = path.join(paths.dataDir, 'harness', 'connection.json');
  fs.writeFileSync(path.join(paths.dataDir, 'deepseek.json'), JSON.stringify({ ...config, hostFile }));
  for (let launch = 0; launch < 2; launch++) {
    const environment = {};
    configureDeepSeekDesktop({ environment, ...paths });
    assert.equal(environment.DEEPSEEK_HOST_FILE, hostFile);
    assert.deepEqual(withoutInjectedEnv(environment), {});
  }
});
