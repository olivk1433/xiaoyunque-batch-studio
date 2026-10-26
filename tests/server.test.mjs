import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import test from 'node:test';
import { createStudio } from '../server.mjs';
import { verifySource } from '../lib/queue.mjs';
import { Store } from '../lib/store.mjs';

async function setup(t) {
  const parent = fileURLToPath(new URL('../.tmp/', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'server-test-'));
  const source = path.join(root, 'source'), shotFolder = path.join(source, '01_8秒_测试', '素材');
  await fs.mkdir(shotFolder, { recursive: true });
  await fs.writeFile(path.join(source, '01_8秒_测试', '视频提示词.txt'), '【整体视觉风格】\n16:9横屏，8秒，写实。\n@图片1：本段唯一整张九宫格实景分镜');
  await fs.writeFile(path.join(shotFolder, '九宫格实景分镜.png'), Buffer.from('image fixture data'));
  await fs.writeFile(path.join(shotFolder, '未提供音色说明.txt'), 'DO-NOT-IMPORT-THIS-NOTE');
  const calls = { submits: 0, payloads: [] };
  const providerFactory = () => ({
    async upload(ref) { return `asset-${ref.name}`; },
    async submit(payload) { calls.submits++; calls.payloads.push(payload); return { runId: 'remote-run', threadId: 'remote-thread' }; },
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
  async function request(url, body, { method = body === undefined ? 'GET' : 'POST', token = studio.csrf, host = '127.0.0.1:3280', origin = 'http://127.0.0.1:3280', range, raw = false, contentLength } = {}) {
    const req = Readable.from(body?.[Symbol.asyncIterator] ? body : body === undefined ? [] : [raw ? Buffer.from(body) : Buffer.from(JSON.stringify(body))]);
    req.method = method; req.url = url; req.headers = { host, origin, 'content-type': raw ? 'application/octet-stream' : 'application/json', 'x-csrf-token': token, ...(range ? { range } : {}), ...(contentLength ? { 'content-length': contentLength } : {}) };
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

test('页面素材编排保存、移除恢复及自动排序贯通；排队快照和供应商数组保持原顺序', async t => {
  const { request, studio, source, calls } = await setup(t);
  const folder = path.join(source, '01_8秒_测试', '素材');
  for (const name of ['01_图片1.png', '音频2.mp3', '音频3.mp3', '音频4.mp3']) await fs.writeFile(path.join(folder, name), `fixture ${name}`);
  let response = await request('/api/import', { sourcePath: source });
  let project = response.data.state.projects[0], shot = project.shots[0];
  const initial = shot.references.map(ref => ref.id);
  const preview = await request('/api/material-order', { projectId: project.id, shotId: shot.id });
  assert.deepEqual(preview.data.references.map(ref => ref.id), initial);
  assert.equal(studio.store.project(project.id).revision, project.revision);
  const audioIds = shot.references.filter(ref => ref.kind === 'audio').map(ref => ref.id).reverse();
  const imageIds = shot.references.filter(ref => ref.kind === 'image').map(ref => ref.id);
  const reordered = [...audioIds, ...imageIds];
  const patch = async changes => {
    const saved = await request(`/api/projects/${project.id}`, { revision: project.revision, shots: [{ id: shot.id, ...changes }] }, { method: 'PATCH' });
    assert.equal(saved.status, 200);
    project = saved.data.projects[0]; shot = project.shots[0];
  };
  await patch({ references: reordered, parameters: { model: 'seedance2.0_vision', resolution: '720p' } });
  assert.deepEqual(shot.references.filter(ref => ref.kind === 'audio').map(ref => [ref.name, ref.index]), [['音频4.mp3', 1], ['音频3.mp3', 2], ['音频2.mp3', 3]]);
  await request('/api/settings', { apiKey: 'simulated-key' });
  assert.equal((await request('/api/queue', { projectId: project.id, shotIds: [shot.id], revision: project.revision })).status, 200);
  await patch({ references: imageIds });
  assert.equal(shot.references.length, 2); assert.equal(shot.mediaFiles.length, 5);
  await patch({ references: [...imageIds, audioIds[0]] });
  assert.equal(shot.references.find(ref => ref.kind === 'audio').index, 1);
  await patch({ autoOrder: true });
  assert.deepEqual(shot.references.map(ref => ref.id), initial);
  const bad = await request(`/api/projects/${project.id}`, { revision: project.revision, shots: [{ id: shot.id, references: [initial[0], initial[0]] }] }, { method: 'PATCH' });
  assert.equal(bad.status, 400);
  assert.equal(studio.store.project(project.id).revision, project.revision);
  await studio.queue.tick();
  assert.deepEqual(calls.payloads[0].video_part_tool_param.audios.map(item => item.pippit_asset_id), ['asset-音频4.mp3', 'asset-音频3.mp3', 'asset-音频2.mp3']);
  assert.deepEqual(studio.store.attempts()[0].snapshot.references.map(ref => ref.id), reordered);
});

test('删除项目清理自身记录及排队任务，保留其他项目、原素材和视频导出文件，允许再次导入', async t => {
  const { request, studio, source, root } = await setup(t);
  const imported = await request('/api/import', { sourcePath: source });
  const project = imported.data.state.projects[0], shot = project.shots[0];
  const other = await request('/api/import', { sourcePath: source, createNew: true, name: '保留的项目' });
  const otherId = other.data.projectId;
  const output = path.join(root, 'output', 'retained.mp4');
  await fs.writeFile(output, 'retained video');
  studio.store.saveExport({ id: 'test-export', projectId: project.id, folder: path.join(root, 'output') });
  studio.store.saveExport({ id: 'other-export', projectId: otherId, folder: path.join(root, 'output') });
  studio.store.saveAttempt({ id: 'queued-test', projectId: project.id, shotId: shot.id, status: 'queued' });
  const denied = await request(`/api/projects/${project.id}`, { revision: project.revision }, { method: 'DELETE', token: '' });
  assert.equal(denied.status, 403);
  assert.equal((await request(`/api/projects/${project.id}`, { revision: 0 }, { method: 'DELETE' })).status, 400);
  const removed = await request(`/api/projects/${project.id}`, { revision: project.revision }, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data.projects.map(item => item.id), [otherId]);
  assert.equal(studio.store.project(project.id), null); assert.equal(studio.store.attempt('queued-test'), null);
  assert.deepEqual(studio.store.db.prepare('SELECT id FROM exports').all().map(row => row.id), ['other-export']);
  assert.equal(await fs.readFile(output, 'utf8'), 'retained video');
  assert.equal(await fs.readFile(shot.mediaFiles[0].absolutePath, 'utf8'), 'image fixture data');
  const again = await request('/api/import', { sourcePath: source, createNew: true });
  assert.equal(again.status, 200); assert.notEqual(again.data.projectId, project.id);
});

test('删除被正在处理、待核对和正在校验文件的任务阻止，不会丢失记录', async t => {
  const { request, studio, source } = await setup(t);
  const imported = await request('/api/import', { sourcePath: source });
  const project = imported.data.state.projects[0], shot = project.shots[0];
  for (const status of ['uploading', 'submitting', 'unknown', 'generating', 'downloading', 'query_paused', 'artifact_missing', 'download_failed']) {
    studio.store.saveAttempt({ id: 'busy-test', projectId: project.id, shotId: shot.id, status });
    const result = await request(`/api/projects/${project.id}`, { revision: project.revision }, { method: 'DELETE' });
    assert.equal(result.status, 400); assert.match(result.data.error, /任务/u);
    assert.ok(studio.store.project(project.id)); assert.equal(studio.store.attempt('busy-test').status, status);
  }
  studio.store.saveAttempt({ id: 'busy-test', projectId: project.id, shotId: shot.id, status: 'queued' });
  studio.queue.busy.add('busy-test');
  assert.equal((await request(`/api/projects/${project.id}`, { revision: project.revision }, { method: 'DELETE' })).status, 400);
  studio.queue.busy.delete('busy-test');
  assert.equal((await request(`/api/projects/${project.id}`, { revision: project.revision }, { method: 'DELETE' })).status, 200);
});

test('本地添加、替换、素材预览与快照隔离：原文件不变，旧任务仍使用旧素材', async t => {
  const { request, studio, source } = await setup(t);
  let project = (await request('/api/import', { sourcePath: source })).data.state.projects[0], shot = project.shots[0];
  const patch = async changes => {
    const response = await request(`/api/projects/${project.id}`, { revision: project.revision, shots: [{ id: shot.id, ...changes }] }, { method: 'PATCH' });
    assert.equal(response.status, 200); project = response.data.projects[0]; shot = project.shots[0];
  };
  const upload = async (name, bytes, extra = '') => {
    const response = await request(`/api/projects/${project.id}/shots/${shot.id}/media?name=${encodeURIComponent(name)}&revision=${project.revision}${extra}`, bytes, { raw: true });
    assert.equal(response.status, 200, response.text);
    project = response.data.state.projects[0]; shot = project.shots[0];
    return shot.mediaFiles.find(ref => ref.id === response.data.fileId);
  };
  const audio = await upload('音色.wav', 'audio bytes');
  assert.equal(audio.storage, 'managed'); assert.equal(shot.references.find(ref => ref.id === audio.id).label, '@音频1');
  const preview = await request(`/api/media?project=${project.id}&file=${audio.id}`);
  assert.equal(preview.text, 'audio bytes');
  await patch({ parameters: { model: 'seedance2.0_vision', resolution: '720p' } });
  await request('/api/settings', { apiKey: 'simulated-key' });
  assert.equal((await request('/api/queue', { projectId: project.id, shotIds: [shot.id], revision: project.revision })).status, 200);
  const snapshot = studio.store.attempts()[0].snapshot;
  const oldImage = shot.references.find(ref => ref.kind === 'image');
  const newer = await upload('替换图片.png', 'replacement image', `&replace=${oldImage.id}`);
  assert.equal(shot.references[0].id, newer.id); assert.equal(shot.referenceReview, null);
  assert.equal(await fs.readFile(oldImage.absolutePath, 'utf8'), 'image fixture data');
  assert.equal(await fs.readFile(newer.absolutePath, 'utf8'), 'replacement image');
  assert.ok(shot.mediaFiles.some(ref => ref.id === oldImage.id));
  await verifySource(snapshot, studio.queue.managedRoot);
  assert.equal(snapshot.references[0].id, oldImage.id);
  await studio.queue.tick(); assert.equal(studio.store.attempts()[0].status, 'generating');
  const staged = await upload('草稿新增.png', 'staged image', '&stage=1');
  assert.ok(shot.mediaFiles.some(ref => ref.id === staged.id)); assert.ok(!shot.references.some(ref => ref.id === staged.id));
});

test('素材上传拒绝跨类型替换、路径、空文件、超限、陈旧修订和无校验请求', async t => {
  const { request, source, studio } = await setup(t);
  const project = (await request('/api/import', { sourcePath: source })).data.state.projects[0], shot = project.shots[0];
  const route = name => `/api/projects/${project.id}/shots/${shot.id}/media?revision=${project.revision}&name=${encodeURIComponent(name)}`;
  for (const name of ['../escape.png', 'a\\b.png', 'not-media.txt']) assert.equal((await request(route(name), 'data', { raw: true })).status, 400);
  assert.equal((await request(route('a.png'), '', { raw: true })).status, 400);
  assert.equal((await request(route('a.png'), 'data', { raw: true, contentLength: 51 * 1024 ** 2 })).status, 400);
  assert.equal((await request(route('a.png'), 'data', { raw: true, token: '' })).status, 403);
  assert.equal((await request(route('a.wav') + `&replace=${shot.references[0].id}`, 'data', { raw: true })).status, 400);
  assert.equal((await request(route('a.png').replace('revision=1', 'revision=0'), 'data', { raw: true })).status, 400);
  assert.equal(studio.store.project(project.id).shots[0].mediaFiles.length, 1);
});

test('流式上传期间的并发编辑不会被覆盖，上传文件未采用时会清理', async t => {
  const { request, source, studio, root } = await setup(t);
  const project = (await request('/api/import', { sourcePath: source })).data.state.projects[0], shot = project.shots[0];
  async function* stream() {
    yield Buffer.from('first');
    await request(`/api/projects/${project.id}`, { revision: project.revision, name: '并发修改已保存' }, { method: 'PATCH' });
    yield Buffer.from('second');
  }
  const response = await request(`/api/projects/${project.id}/shots/${shot.id}/media?revision=${project.revision}&name=added.png`, stream(), { raw: true });
  assert.equal(response.status, 400); assert.match(response.data.error, /上传期间/u);
  assert.equal(studio.store.project(project.id).name, '并发修改已保存');
  assert.equal(studio.store.project(project.id).shots[0].mediaFiles.length, 1);
  assert.deepEqual(await fs.readdir(path.join(root, 'runtime', 'media', project.id, shot.id)), []);
});

test('引用变更持久化，生成前必须核对；同步交换不串位，移除仍被引用的素材不允许自动同步', async t => {
  const { request, source, studio } = await setup(t);
  let project = (await request('/api/import', { sourcePath: source })).data.state.projects[0], shot = project.shots[0];
  let response = await request(`/api/projects/${project.id}/shots/${shot.id}/media?revision=${project.revision}&name=second.png`, 'second', { raw: true });
  project = response.data.state.projects[0]; shot = project.shots[0];
  const [first, second] = shot.references;
  const patch = async changes => {
    response = await request(`/api/projects/${project.id}`, { revision: project.revision, shots: [{ id: shot.id, ...changes }] }, { method: 'PATCH' });
    if (response.status === 200) { project = response.data.projects[0]; shot = project.shots[0]; }
    return response;
  };
  await patch({ prompt: '16:9横屏，8秒，写实。\n@图片1 甲 @图片2 乙', parameters: { model: 'seedance2.0_vision', resolution: '720p' } });
  await patch({ references: [second.id, first.id] });
  assert.equal(shot.referenceReview.changed.length, 2); assert.match(shot.prompt, /@图片1 甲 @图片2 乙/u);
  await request('/api/settings', { apiKey: 'simulated-key' });
  assert.equal((await request('/api/queue', { projectId: project.id, shotIds: [shot.id], revision: project.revision })).status, 400);
  await patch({ syncReferences: true });
  assert.equal(shot.referenceReview, null); assert.match(shot.prompt, /@图片2 甲 @图片1 乙/u);
  await patch({ references: [second.id] });
  assert.equal(shot.referenceReview.canSync, false);
  assert.equal((await patch({ syncReferences: true })).status, 400);
  await patch({ confirmReferences: true });
  assert.equal(shot.referenceReview, null); assert.ok(shot.validation.errors.some(message => message.includes('@图片2')));
  assert.equal(studio.store.attempts().length, 0);
});

test('参数模板只保存白名单字段，可持久化、更新、删除；应用时保留各段时长且不启动任务', async t => {
  const { request, source, studio, root } = await setup(t);
  const folder = path.join(source, '02_15秒_另一段'); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, '视频提示词.txt'), '16:9横屏，15秒，写实。');
  let project = (await request('/api/import', { sourcePath: source })).data.state.projects[0];
  const parameters = { model: 'seedance2.0_vision', resolution: '720p', ratio: '9:16', concurrency: 3, durationSeconds: null, apiKey: 'must-not-store' };
  let response = await request('/api/presets', { name: '常用竖屏', parameters, apiKey: 'also-not-stored' });
  assert.equal(response.status, 200);
  let preset = response.data.presets[0];
  assert.ok(!JSON.stringify(preset).includes('must-not-store')); assert.equal(Object.keys(preset.parameters).length, 5);
  const secondStore = new Store(path.join(root, 'runtime', 'studio.sqlite'));
  assert.deepEqual(secondStore.presets(), studio.store.presets()); secondStore.close();
  response = await request(`/api/presets/${preset.id}/apply`, { projectId: project.id, revision: project.revision, shotIds: project.shots.map(shot => shot.id) });
  assert.equal(response.status, 200); project = response.data.projects[0];
  assert.deepEqual(project.shots.map(shot => shot.parameters.durationSeconds), [8, 15]);
  assert.ok(project.shots.every(shot => shot.parameters.ratio === '9:16')); assert.equal(response.data.settings.concurrency, 3);
  assert.match(project.shots[0].prompt, /16:9/u); assert.equal(studio.store.attempts().length, 0);
  const before = studio.store.project(project.id);
  response = await request(`/api/presets/${preset.id}/apply`, { projectId: project.id, revision: project.revision, shotIds: [project.shots[0].id, 'unknown'] });
  assert.equal(response.status, 400); assert.deepEqual(studio.store.project(project.id), before);
  response = await request('/api/presets', { id: preset.id, name: '固定12秒', parameters: { ...parameters, durationSeconds: 12 } });
  assert.equal(response.status, 200);
  response = await request(`/api/presets/${preset.id}/apply`, { projectId: project.id, revision: project.revision, shotIds: [project.shots[0].id] });
  assert.deepEqual(response.data.projects[0].shots.map(shot => shot.parameters.durationSeconds), [12, 15]);
  assert.equal((await request('/api/presets', { name: '非法模板', parameters: { ...parameters, model: 'unknown' } })).status, 400);
  assert.equal((await request(`/api/presets/${preset.id}`, {}, { method: 'DELETE' })).data.presets.length, 0);
});
