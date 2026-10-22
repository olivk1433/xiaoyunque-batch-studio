import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Store } from '../lib/store.mjs';
import { Queue, keyIdentity } from '../lib/queue.mjs';
import { ProviderError } from '../lib/provider.mjs';
import { buildPayload } from '../lib/catalog.mjs';

async function setup(t, overrides = {}) {
  const parent = fileURLToPath(new URL('../.tmp/', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'queue-test-'));
  const store = new Store(path.join(root, 'test.sqlite'));
  const image = Buffer.from('source image fixture');
  await fs.writeFile(path.join(root, '图片1.png'), image);
  const ref = { id: 'ref-1', name: '图片1.png', kind: 'image', index: 1, label: '@图片1', bytes: image.length, absolutePath: path.join(root, '图片1.png'), sha256: createHash('sha256').update(image).digest('hex') };
  const shot = { id: 'shot-1', sequence: 1, name: '01_8秒_片段', prompt: '【视觉】\n16:9横屏，8秒，写实。\n@图片1：角色', parameters: { model: 'seedance2.0_vision', resolution: '720p', ratio: '16:9', durationSeconds: 8 }, references: [ref], mediaFiles: [ref], importIssues: [], notes: [] };
  store.saveProject({ id: 'project-1', name: '测试项目', revision: 1, sourcePath: root, shots: [shot], paused: false, importIssues: [] });
  const calls = { uploads: 0, submits: 0, queries: 0, downloads: 0 };
  const provider = {
    async upload() { calls.uploads++; return 'asset-1'; },
    async submit(payload) { calls.submits++; assert.equal(payload.agent_name, 'pippit_video_part_agent'); return { runId: 'run-1', threadId: 'thread-1' }; },
    async query() { calls.queries++; return { state: 3, urls: ['https://example.com/video.mp4'] }; },
    async download(url, destination) { calls.downloads++; const file = `${destination}.mp4`; await fs.writeFile(file, 'video fixture'); return { path: file, bytes: 13, format: 'mp4' }; },
    ...overrides,
  };
  const queue = new Queue(store, path.join(root, 'output'), { getKey: () => 'test-secret-not-a-real-key', providerFactory: () => provider, pollMs: 0 });
  t.after(async () => {
    queue.stop(); await Promise.allSettled([...queue.running]); store.close();
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(parent)); assert.ok(path.basename(resolved).startsWith('queue-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { store, queue, calls, root, provider, shot };
}

test('上传、提交、查询、下载逐步完成，重复点击不会创建第二个活动任务', async t => {
  const { store, queue, calls } = await setup(t);
  const [attempt] = queue.enqueue('project-1', ['shot-1'], 1);
  assert.throws(() => queue.enqueue('project-1', ['shot-1'], 1), /未结束/);
  await queue.tick(); assert.equal(store.attempt(attempt.id).status, 'generating');
  await queue.tick(); assert.equal(store.attempt(attempt.id).status, 'downloading');
  await queue.tick(); assert.equal(store.attempt(attempt.id).status, 'complete');
  assert.deepEqual(calls, { uploads: 1, submits: 1, queries: 1, downloads: 1 });
  const oldPath = store.attempt(attempt.id).outputs[0].path;
  const [second] = queue.enqueue('project-1', ['shot-1'], 1);
  assert.equal(second.version, 2);
  await queue.tick(); assert.equal(calls.uploads, 1); assert.equal(calls.submits, 2);
  assert.equal(await fs.readFile(oldPath, 'utf8'), 'video fixture');
});

test('提交响应丢失后进入待核对，重启和继续 tick 均不重新生成', async t => {
  const { store, queue, calls, provider } = await setup(t);
  provider.submit = async () => { calls.submits++; throw new ProviderError('网络超时', { uncertain: true }); };
  const [attempt] = queue.enqueue('project-1', ['shot-1'], 1);
  await queue.tick(); assert.equal(store.attempt(attempt.id).status, 'unknown');
  queue.recover(); await queue.tick(); assert.equal(calls.submits, 1);
  queue.action(attempt.id, 'recover', { runId: 'found-run', threadId: 'found-thread' });
  await queue.tick(); assert.equal(store.attempt(attempt.id).status, 'downloading');
  assert.equal(calls.submits, 1);
});

test('后台在提交中停止时保留快照并要求核对，在生成中停止则继续原任务', async t => {
  const { store, queue, calls } = await setup(t);
  const [attempt] = queue.enqueue('project-1', ['shot-1'], 1);
  attempt.status = 'submitting'; store.saveAttempt(attempt);
  queue.recover(); assert.equal(store.attempt(attempt.id).status, 'unknown');
  queue.action(attempt.id, 'recover', { runId: 'remote', threadId: 'thread' });
  queue.recover(); await queue.tick();
  assert.equal(calls.submits, 0); assert.equal(calls.queries, 1);
});

test('下载失败后仅刷新链接与重试下载，生成提交次数不增加', async t => {
  const { store, queue, calls, provider } = await setup(t);
  const download = provider.download;
  provider.download = async () => { calls.downloads++; throw new Error('链接过期'); };
  const [attempt] = queue.enqueue('project-1', ['shot-1'], 1);
  await queue.tick(); await queue.tick(); await queue.tick();
  assert.equal(store.attempt(attempt.id).status, 'download_failed');
  provider.download = download;
  queue.action(attempt.id, 'resume-query'); await queue.tick(); await queue.tick();
  assert.equal(store.attempt(attempt.id).status, 'complete'); assert.equal(calls.submits, 1);
});

test('并发 tick 和文件校验期间也占用并发名额', async t => {
  const { store, queue, calls, provider } = await setup(t);
  const project = store.project('project-1'); project.shots.push({ ...project.shots[0], id: 'shot-2', sequence: 2 }); store.saveProject(project);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  provider.upload = async () => { calls.uploads++; await gate; return 'asset-1'; };
  queue.enqueue('project-1', ['shot-1', 'shot-2'], 1);
  const first = queue.tick();
  await queue.tick();
  assert.equal(queue.busy.size, 1);
  release(); await first;
  assert.equal(calls.submits, 1);
  assert.equal(store.attempts().filter(item => item.status === 'queued').length, 1);
});

test('生成前素材被替换会报错，并且不会上传或提交', async t => {
  const { store, queue, calls, root } = await setup(t);
  const [attempt] = queue.enqueue('project-1', ['shot-1'], 1);
  await fs.writeFile(path.join(root, '图片1.png'), 'changed');
  await queue.tick(); assert.equal(store.attempt(attempt.id).status, 'failed');
  assert.equal(calls.uploads, 0); assert.equal(calls.submits, 0);
});

test('API 素材数组按每种类型的引用编号排序，普通模式不发送首尾帧标志', () => {
  const snapshot = { prompt: '@图片1 @图片2 @音频1', parameters: { model: 'Seedance_2.0_mini', durationSeconds: 8, resolution: '720p', ratio: '16:9' }, references: [
    { id: 'i2', kind: 'image', index: 2 }, { id: 'a1', kind: 'audio', index: 1 }, { id: 'i1', kind: 'image', index: 1 },
  ] };
  const payload = buildPayload(snapshot, [{ refId: 'i1', assetId: 'one' }, { refId: 'i2', assetId: 'two' }, { refId: 'a1', assetId: 'voice' }]);
  assert.deepEqual(payload.video_part_tool_param.images, [{ pippit_asset_id: 'one' }, { pippit_asset_id: 'two' }]);
  assert.deepEqual(payload.video_part_tool_param.audios, [{ pippit_asset_id: 'voice' }]);
  assert.equal(payload.message, payload.video_part_tool_param.prompt);
  assert.ok(!Object.hasOwn(payload.video_part_tool_param, 'generate_type'));
  assert.notEqual(keyIdentity('key-a'), keyIdentity('key-b'));
});
