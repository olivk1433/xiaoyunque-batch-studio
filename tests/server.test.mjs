import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import test from 'node:test';
import { createStudio } from '../server.mjs';

async function setup(t) {
  const parent = fileURLToPath(new URL('../.tmp/', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'server-test-'));
  const source = path.join(root, 'source'), shotFolder = path.join(source, '01_8秒_测试', '素材');
  await fs.mkdir(shotFolder, { recursive: true });
  await fs.writeFile(path.join(source, '01_8秒_测试', '视频提示词.txt'), '【整体视觉风格】\n16:9横屏，8秒，写实。\n@图片1：本段唯一整张九宫格实景分镜');
  await fs.writeFile(path.join(shotFolder, '九宫格实景分镜.png'), Buffer.from('image fixture data'));
  await fs.writeFile(path.join(shotFolder, '未提供音色说明.txt'), 'DO-NOT-IMPORT-THIS-NOTE');
  const calls = { submits: 0 };
  const providerFactory = () => ({
    async upload() { return 'asset-test'; },
    async submit() { calls.submits++; return { runId: 'remote-run', threadId: 'remote-thread' }; },
    async query() { return { state: 3, urls: ['https://example.com/video.mp4'] }; },
    async download(url, destination) { const file = `${destination}.mp4`; await fs.writeFile(file, 'video fixture'); return { path: file, bytes: 13, format: 'mp4' }; },
  });
  const studio = await createStudio({ dataRoot: path.join(root, 'runtime'), outputRoot: path.join(root, 'output'), key: '', providerFactory });
  studio.queue.pollMs = 0;
  await studio.initialize();
  t.after(async () => {
    await studio.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(parent)); assert.ok(path.basename(root).startsWith('server-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function request(url, body, { method = body === undefined ? 'GET' : 'POST', token = studio.csrf, host = '127.0.0.1:3280', origin = 'http://127.0.0.1:3280', range } = {}) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method; req.url = url; req.headers = { host, origin, 'content-type': 'application/json', 'x-csrf-token': token, ...(range ? { range } : {}) };
    const chunks = [], headers = {};
    const res = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.statusCode = 200; res.headersSent = false;
    res.setHeader = (name, value) => { headers[name.toLowerCase()] = value; };
    res.writeHead = (status, values = {}) => { res.statusCode = status; res.headersSent = true; for (const [name, value] of Object.entries(values)) res.setHeader(name, value); return res; };
    const done = once(res, 'finish');
    await studio.handler(req, res); await done;
    const text = Buffer.concat(chunks).toString('utf8');
    return { status: res.statusCode, headers, text, data: headers['content-type']?.includes('application/json') ? JSON.parse(text) : null };
  }
  return { studio, request, source, calls, root };
}

test('真实路由处理器：主页、导入、参数、模拟生成、播放、验收和导出完整贯通', async t => {
  const { studio, request, source, calls } = await setup(t);
  const html = await request('/');
  assert.equal(html.status, 200); assert.match(html.text, /云雀 · 短剧批量工作台/u); assert.ok(!html.text.includes('__CSRF_TOKEN__'));
  const imported = await request('/api/import', { sourcePath: source, name: '测试一集' });
  assert.equal(imported.status, 200);
  let project = imported.data.state.projects[0], shot = project.shots[0];
  assert.equal(project.name, '测试一集'); assert.equal(shot.references.length, 1); assert.equal(shot.notes.length, 0);
  assert.ok(!JSON.stringify(imported.data).includes('DO-NOT-IMPORT-THIS-NOTE'));
  const media = await request(`/api/media?project=${project.id}&file=${shot.references[0].id}`, undefined, { range: 'bytes=0-4' });
  assert.equal(media.status, 206); assert.equal(media.text, 'image');
  const saved = await request(`/api/projects/${project.id}`, { revision: project.revision, shots: [{ id: shot.id, parameters: { model: 'seedance2.0_vision', resolution: '720p', durationSeconds: 12 } }] }, { method: 'PATCH' });
  assert.equal(saved.status, 200); project = saved.data.projects[0]; shot = project.shots[0];
  assert.equal(shot.validation.errors.length, 0);
  assert.equal(shot.parameters.durationSeconds, 12);
  assert.equal(studio.store.project(project.id).shots[0].parameters.durationSeconds, 12);
  assert.match(shot.prompt, /8秒/u); // Inline parameter edits do not silently rewrite creative text.
  const stale = await request(`/api/projects/${project.id}`, { revision: 1, name: '覆盖旧修订' }, { method: 'PATCH' });
  assert.equal(stale.status, 400);
  const missingKey = await request('/api/queue', { projectId: project.id, shotIds: [shot.id], revision: project.revision });
  assert.equal(missingKey.status, 400); assert.match(missingKey.data.error, /API Key/u);
  const secret = 'simulated-key-do-not-persist';
  const configured = await request('/api/settings', { apiKey: secret });
  assert.equal(configured.data.settings.hasKey, true); assert.ok(!configured.text.includes(secret));
  const queued = await request('/api/queue', { projectId: project.id, shotIds: [shot.id], revision: project.revision });
  assert.equal(queued.status, 200);
  const duplicate = await request('/api/queue', { projectId: project.id, shotIds: [shot.id], revision: project.revision });
  assert.equal(duplicate.status, 400);
  await studio.queue.tick(); await studio.queue.tick(); await studio.queue.tick();
  const attempt = studio.store.attempts()[0]; assert.equal(attempt.status, 'complete'); assert.equal(calls.submits, 1);
  assert.equal(attempt.snapshot.parameters.durationSeconds, 12);
  const playback = await request(`/api/result?attempt=${attempt.id}&candidate=0`);
  assert.equal(playback.status, 200); assert.equal(playback.text, 'video fixture');
  const accepted = await request(`/api/attempts/${attempt.id}/review`, { accepted: true, candidate: 0 });
  assert.equal(accepted.data.projects[0].shots[0].acceptedAttemptId, attempt.id);
  const exported = await request(`/api/projects/${project.id}/export`, {});
  assert.equal(exported.data.count, 1);
  const files = await fs.readdir(exported.data.folder);
  assert.equal(files.filter(file => file.endsWith('.mp4')).length, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(exported.data.folder, '采用版本与参数.json'), 'utf8'));
  assert.equal(manifest[0].version, 1); assert.equal(manifest[0].parameters.model, 'seedance2.0_vision');
  const publicState = await request('/api/state'); assert.ok(!publicState.text.includes(secret)); assert.ok(!publicState.text.includes('https://example.com/video.mp4'));
  assert.ok(!JSON.stringify(studio.store.settings()).includes(secret));
});

test('路由拒绝无校验的写入、外站来源、非法主机和任意本地文件访问', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/api/settings', { concurrency: 4 }, { token: '' })).status, 403);
  assert.equal((await request('/api/settings', { concurrency: 4 }, { origin: 'https://external.example' })).status, 403);
  assert.equal((await request('/api/state', undefined, { host: 'external.example' })).status, 403);
  assert.equal((await request('/api/media?project=none&file=C:/Windows/win.ini')).status, 400);
  assert.equal((await request('/../server.mjs')).status, 404);
});

test('参数校验阻止不支持的 1080p 组合，失败批次不会留下部分排队任务', async t => {
  const { request, source, studio } = await setup(t);
  let result = await request('/api/import', { sourcePath: source });
  let project = result.data.state.projects[0], shot = project.shots[0];
  result = await request(`/api/projects/${project.id}`, { revision: project.revision, shots: [{ id: shot.id, parameters: { model: 'MiniMax-H3', resolution: '1080p' } }] }, { method: 'PATCH' });
  project = result.data.projects[0];
  await request('/api/settings', { apiKey: 'simulated-key' });
  const queued = await request('/api/queue', { projectId: project.id, shotIds: [shot.id], revision: project.revision });
  assert.equal(queued.status, 400); assert.match(queued.data.error, /1080p/u);
  assert.equal(studio.store.attempts().length, 0);
});
