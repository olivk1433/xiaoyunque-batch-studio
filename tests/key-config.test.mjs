import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseKeyText, createKeyConfig } from '../lib/key-config.mjs';

test('文本 Key 支持说明、BOM、CRLF 和常见前缀；格式错误不回显密钥', () => {
  assert.equal(parseKeyText('\uFEFF# 说明\r\n\r\ntest-key\r\n'), 'test-key');
  assert.equal(parseKeyText('Bearer test-key'), 'test-key');
  assert.equal(parseKeyText('API_KEY=test-key'), 'test-key');
  assert.equal(parseKeyText('# 尚未填写\n'), '');
  assert.throws(() => parseKeyText('secret-one\nsecret-two'), error => !error.message.includes('secret-one') && !error.message.includes('secret-two'));
});

test('修改文本即刷新 Key，重启保留，网页覆盖可切回，状态不包含原文', async t => {
  const parent = fileURLToPath(new URL('../.tmp/', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'key-config-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(parent));
    assert.ok(path.basename(root).startsWith('key-config-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const filePath = path.join(root, 'key.txt');
  const config = createKeyConfig({ filePath, fallbackKey: 'env-secret' });
  assert.equal(config.getKey(), 'env-secret');
  await fs.writeFile(filePath, '# 说明\nfile-secret');
  assert.equal(config.getKey(), 'file-secret');
  assert.equal(config.status().source, 'file');
  assert.ok(!JSON.stringify(config.status()).includes('file-secret'));
  await fs.writeFile(filePath, 'updated-secret');
  assert.equal(config.getKey(), 'updated-secret');
  assert.equal(createKeyConfig({ filePath }).getKey(), 'updated-secret');
  config.setTemporary('session-secret'); assert.equal(config.getKey(), 'session-secret');
  config.useFile(); assert.equal(config.getKey(), 'updated-secret');
  config.disable(); assert.equal(config.getKey(), '');
  assert.equal(await fs.readFile(filePath, 'utf8'), 'updated-secret');
  config.useFile(); assert.equal(config.getKey(), 'updated-secret');
  await fs.writeFile(filePath, 'bad-secret\nsecond-secret');
  assert.equal(config.getKey(), '');
  assert.equal(config.status().source, 'file-error');
  assert.ok(!config.status().error.includes('bad-secret'));
  await fs.writeFile(filePath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('utf16-secret', 'utf16le')]));
  assert.equal(config.getKey(), 'utf16-secret');
});
