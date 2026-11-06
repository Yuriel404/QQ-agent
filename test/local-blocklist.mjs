// 升级旧配置后继续使用本地屏蔽项，并保留此前手动解除屏蔽的决定。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-blocklist-'));
process.env.QQ_AGENT_DATA_DIR = dir;
try {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    globalBlocklist: ['666', '1234567'],
    communityExemptions: ['1234567'],
    blocklist: { '123': ['888'] }
  }));
  const { getConfig, loadConfig, updateConfig } = await import('../src/config.js');
  assert.deepEqual(getConfig().globalBlocklist, ['666']);
  assert.deepEqual(getConfig().blocklist, { '123': ['888'] });
  updateConfig({ globalBlocklist: ['1234567'] });
  assert.deepEqual(loadConfig().globalBlocklist, ['1234567']);
  assert.deepEqual(loadConfig().blocklist, { '123': ['888'] });
  updateConfig({ globalBlocklist: [] });
  assert.deepEqual(loadConfig().globalBlocklist, []);
  console.log('本地屏蔽名单的旧配置迁移、重新屏蔽和解除屏蔽均通过');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
