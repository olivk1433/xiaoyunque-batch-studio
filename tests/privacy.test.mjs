import assert from 'node:assert/strict';
import test from 'node:test';
import { textFindings } from '../scripts/privacy-audit.mjs';

test('隐私扫描识别秘密和个人路径，但不要求真实 Key', () => {
  const fakeToken = 'ghp_' + 'a'.repeat(35);
  assert.ok(textFindings(fakeToken).includes('credential-token'));
  const privatePath = ['C:', 'Users', 'example-person', 'Desktop'].join(String.fromCharCode(92));
  assert.ok(textFindings(privatePath).includes('personal-windows-path'));
  assert.deepEqual(textFindings('contributors@users.noreply.github.com'), []);
  assert.deepEqual(textFindings('test-secret-not-a-real-key'), []);
});
