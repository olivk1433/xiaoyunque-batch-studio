import assert from 'node:assert/strict';
import test from 'node:test';
import { XiaoyunqueProvider } from '../lib/provider.mjs';

test('供应商协议：固定短片接口、Bearer 认证、run/thread 标识与字符串状态解析', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return Response.json({ ret: '0', data: seen.length === 1 ? { run: { run_id: 'r1', thread_id: 't1' } } : { run_state: '3', video_urls: ['https://example.com/v.mp4'] } });
  };
  const provider = new XiaoyunqueProvider('test-secret');
  const result = await provider.submit({ agent_name: 'pippit_video_part_agent' });
  assert.equal(result.runId, 'r1'); assert.equal(result.threadId, 't1');
  const query = await provider.query(result); assert.equal(query.state, 3);
  assert.equal(seen[0].url, 'https://xyq.jianying.com/api/biz/v1/skill/submit_run');
  assert.equal(seen[1].url, 'https://xyq.jianying.com/api/biz/v1/agent/query_generate_video_result');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer test-secret');
  assert.deepEqual(JSON.parse(seen[1].init.body), { run_id: 'r1', thread_id: 't1' });
});

test('网络与无效响应不能被认作确定失败；明确业务拒绝则保持确定失败', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  const provider = new XiaoyunqueProvider('test-secret');
  globalThis.fetch = async () => { throw new Error('socket'); };
  await assert.rejects(provider.submit({}), error => error.uncertain === true);
  globalThis.fetch = async () => new Response('invalid JSON');
  await assert.rejects(provider.submit({}), error => error.uncertain === true);
  globalThis.fetch = async () => Response.json({ ret: '0', data: {} });
  await assert.rejects(provider.submit({}), error => error.uncertain === true);
  globalThis.fetch = async () => Response.json({ ret: '403', errmsg: 'Invalid test-secret' });
  await assert.rejects(provider.submit({}), error => error.uncertain === false && !error.message.includes('test-secret'));
});
