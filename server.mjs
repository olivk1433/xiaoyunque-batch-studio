import http from 'node:http';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { inspectEpisode } from './lib/importer.mjs';
import { Store, importProject, publicProject } from './lib/store.mjs';
import { Queue, keyIdentity } from './lib/queue.mjs';
import { createKeyConfig } from './lib/key-config.mjs';
import { MODELS, RATIOS, RESOLUTIONS, IN_FLIGHT, sanitizeName } from './lib/catalog.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_SAMPLE = path.join(projectRoot, 'examples');
const contentTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

function equalToken(a, b) {
  const one = Buffer.from(String(a || '')), two = Buffer.from(b);
  return one.length === two.length && timingSafeEqual(one, two);
}
async function bodyOf(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('请求过大');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new Error('请求不是有效 JSON'); }
}
function json(response, data, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}
function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function sendFile(request, response, filename, downloadName) {
  const stat = await fs.stat(filename);
  if (!stat.isFile()) throw new Error('文件不存在');
  const headers = { 'Content-Type': contentTypes[path.extname(filename).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  const range = request.headers.range;
  let start = 0, end = stat.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
    if (!match || (!match[1] && !match[2])) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); response.end(); return; }
    if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); response.end(); return; }
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  response.writeHead(range ? 206 : 200, headers);
  if (request.method === 'HEAD' || stat.size === 0) { response.end(); return; }
  const stream = createReadStream(filename, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

export async function createStudio({ dataRoot = path.join(projectRoot, 'runtime'), outputRoot = path.join(projectRoot, 'outputs'), key, keyFile = key === undefined ? path.join(projectRoot, 'API密钥.txt') : null, providerFactory } = {}) {
  await fs.mkdir(dataRoot, { recursive: true }); await fs.mkdir(outputRoot, { recursive: true });
  const store = new Store(path.join(dataRoot, 'studio.sqlite'));
  const keyConfig = createKeyConfig({ filePath: keyFile, fallbackKey: key === undefined ? process.env.XIAOYUNQUE_API_KEY || '' : key });
  const session = { get key() { return keyConfig.getKey(); }, set key(value) { keyConfig.setTemporary(value); } };
  const csrf = randomBytes(32).toString('hex');
  const queue = new Queue(store, outputRoot, { getKey: () => session.key, ...(providerFactory ? { providerFactory } : {}) });
  let ready = false;
  let importBusy = false;

  function state() {
    const attempts = store.attempts();
    const publicAttempts = attempts.map(attempt => {
      const { accountId, assets, videoUrls, snapshot, ...rest } = attempt;
      return { ...rest, keyMismatch: Boolean(session.key && accountId !== keyIdentity(session.key)), snapshot: { name: snapshot.name, sequence: snapshot.sequence, prompt: snapshot.prompt, parameters: snapshot.parameters, references: snapshot.references.map(ref => ({ name: ref.name, label: ref.label, kind: ref.kind, index: ref.index })) }, outputs: attempt.outputs.map(({ path: outputPath, ...output }) => output) };
    });
    return {
      projects: store.projects().map(project => publicProject(project, attempts)), attempts: publicAttempts,
      settings: { ...store.settings(), hasKey: Boolean(session.key), keyConfig: keyConfig.status(), outputRoot },
      catalog: { models: MODELS, ratios: RATIOS, resolutions: RESOLUTIONS },
    };
  }
  async function importFolder(input) {
    if (importBusy) throw new Error('另一个目录正在导入，请稍后重试');
    const sourcePath = path.resolve(String(input.sourcePath || ''));
    if (!input.sourcePath) throw new Error('请填写整集文件夹路径');
    const existing = store.projects().find(project => project.sourcePath.toLowerCase() === sourcePath.toLowerCase());
    if (existing && !input.createNew) return existing;
    importBusy = true;
    try {
      const result = await inspectEpisode(sourcePath);
      if (!result.shots.length) throw new Error('没有找到片段目录，请选择包含 01、02 等片段的整集目录');
      const project = importProject(result, input.name);
      store.saveProject(project); return project;
    } finally { importBusy = false; }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const host = request.headers.host || '';
      const port = server.address()?.port ?? 3280;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) { json(response, { error: '仅允许本机访问' }, 403); return; }
      const url = new URL(request.url, `http://${host}`);
      if (url.pathname.startsWith('/api/')) {
        if (!ready) { json(response, { error: '工作台正在启动，请稍后刷新' }, 503); return; }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          if (!equalToken(request.headers['x-csrf-token'], csrf) || (request.headers.origin && request.headers.origin !== `http://${host}`)) { json(response, { error: '请求校验失败，请刷新页面' }, 403); return; }
          if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('请使用 JSON 请求');
        }
        if (url.pathname === '/api/state' && request.method === 'GET') { json(response, state()); return; }
        if (url.pathname === '/api/import' && request.method === 'POST') {
          const project = await importFolder(await bodyOf(request));
          json(response, { projectId: project.id, state: state() }); return;
        }
        if (url.pathname === '/api/settings' && request.method === 'POST') {
          const input = await bodyOf(request);
          if (Object.hasOwn(input, 'apiKey')) {
            const next = String(input.apiKey).trim().replace(/^Bearer\s+/iu, '');
            if (!next || /[\r\n]/u.test(next) || next.length > 4096) throw new Error('请填写有效的 API Key');
            session.key = next;
          }
          if (input.removeKey) keyConfig.disable();
          if (input.useKeyFile) keyConfig.useFile();
          if (Object.hasOwn(input, 'concurrency')) {
            const concurrency = Number(input.concurrency);
            if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('并发数需为 1–4，并符合账号额度');
            store.saveSettings({ ...store.settings(), concurrency });
          }
          if (input.clearAssets) store.clearAssets();
          json(response, state()); return;
        }
        const projectMatch = /^\/api\/projects\/([a-f0-9-]+)$/u.exec(url.pathname);
        if (projectMatch && request.method === 'PATCH') {
          const input = await bodyOf(request);
          const project = store.project(projectMatch[1]);
          if (!project) throw new Error('项目不存在');
          if (input.revision !== project.revision) throw new Error('项目已更新，请刷新后再保存');
          if (input.name !== undefined) project.name = String(input.name).trim().slice(0, 100) || project.name;
          if (input.shots && !Array.isArray(input.shots)) throw new Error('片段参数不合法');
          for (const patch of input.shots || []) {
            const shot = project.shots.find(item => item.id === patch.id);
            if (!shot) throw new Error('片段不存在');
            if (patch.prompt !== undefined) {
              shot.prompt = String(patch.prompt);
              if (shot.prompt.length > 50000) throw new Error('提示词超过 50000 字符');
            }
            if (patch.parameters) {
              for (const field of ['model', 'resolution', 'ratio']) if (Object.hasOwn(patch.parameters, field)) shot.parameters[field] = String(patch.parameters[field] || '') || null;
              if (Object.hasOwn(patch.parameters, 'durationSeconds')) shot.parameters.durationSeconds = Number(patch.parameters.durationSeconds);
              if (Object.hasOwn(patch.parameters, 'generateType')) shot.parameters.generateType = Number(patch.parameters.generateType) === 1 ? 1 : null;
            }
            if (patch.references) {
              if (!Array.isArray(patch.references)) throw new Error('素材绑定不合法');
              const used = new Set();
              const counts = { image: 0, video: 0, audio: 0 };
              const labels = { image: '图片', video: '视频', audio: '音频' };
              shot.references = patch.references.map(id => {
                if (used.has(id)) throw new Error('同一文件不能重复占用引用槽');
                used.add(id);
                const file = shot.mediaFiles.find(item => item.id === id);
                if (!file) throw new Error('素材不属于这个片段，请重新导入');
                const index = ++counts[file.kind];
                return { ...file, index, label: `@${labels[file.kind]}${index}`, bindingRule: 'manual' };
              });
            }
          }
          project.revision++; store.saveProject(project); json(response, state()); return;
        }
        const pauseMatch = /^\/api\/projects\/([a-f0-9-]+)\/pause$/u.exec(url.pathname);
        if (pauseMatch && request.method === 'POST') {
          const input = await bodyOf(request), project = store.project(pauseMatch[1]);
          if (!project) throw new Error('项目不存在');
          project.paused = input.paused !== false; store.saveProject(project); json(response, state()); return;
        }
        if (url.pathname === '/api/queue' && request.method === 'POST') {
          const input = await bodyOf(request);
          queue.enqueue(input.projectId, input.shotIds, input.revision); json(response, state()); return;
        }
        const actionMatch = /^\/api\/attempts\/([a-f0-9-]+)\/action$/u.exec(url.pathname);
        if (actionMatch && request.method === 'POST') {
          const input = await bodyOf(request);
          queue.action(actionMatch[1], input.action, input); json(response, state()); return;
        }
        const acceptMatch = /^\/api\/attempts\/([a-f0-9-]+)\/review$/u.exec(url.pathname);
        if (acceptMatch && request.method === 'POST') {
          const input = await bodyOf(request), attempt = store.attempt(acceptMatch[1]);
          if (!attempt || attempt.status !== 'complete') throw new Error('只能验收已下载完成的视频');
          const candidate = Number(input.candidate ?? 0);
          if (!attempt.outputs.some(output => output.candidate === candidate)) throw new Error('视频候选不存在');
          const project = store.project(attempt.projectId), shot = project.shots.find(item => item.id === attempt.shotId);
          if (input.accepted) { shot.acceptedAttemptId = attempt.id; shot.acceptedCandidate = candidate; }
          else if (shot.acceptedAttemptId === attempt.id) { shot.acceptedAttemptId = null; shot.acceptedCandidate = null; }
          project.revision++; store.saveProject(project); json(response, state()); return;
        }
        const exportMatch = /^\/api\/projects\/([a-f0-9-]+)\/export$/u.exec(url.pathname);
        if (exportMatch && request.method === 'POST') {
          const project = store.project(exportMatch[1]);
          if (!project) throw new Error('项目不存在');
          const accepted = project.shots.filter(shot => shot.acceptedAttemptId);
          if (!accepted.length) throw new Error('请先验收并选择要采用的视频版本');
          const exportId = randomUUID(), folder = path.join(outputRoot, 'exports', `${sanitizeName(project.name)}_${exportId.slice(0, 8)}`);
          await fs.mkdir(folder, { recursive: true });
          const manifest = [];
          for (const shot of accepted) {
            const attempt = store.attempt(shot.acceptedAttemptId), output = attempt.outputs.find(item => item.candidate === shot.acceptedCandidate);
            if (!inside(outputRoot, output.path)) throw new Error('输出文件路径不合法');
            const filename = `${String(shot.sequence).padStart(3, '0')}_${sanitizeName(shot.name)}.${output.format}`;
            await fs.copyFile(output.path, path.join(folder, filename));
            manifest.push({ filename, shot: shot.name, version: attempt.version, prompt: attempt.snapshot.prompt, parameters: attempt.snapshot.parameters });
          }
          await fs.writeFile(path.join(folder, '采用版本与参数.json'), JSON.stringify(manifest, null, 2));
          store.saveExport({ id: exportId, projectId: project.id, folder, createdAt: new Date().toISOString(), count: accepted.length });
          json(response, { folder, count: accepted.length }); return;
        }
        if (url.pathname === '/api/media' && ['GET', 'HEAD'].includes(request.method)) {
          const project = store.project(url.searchParams.get('project'));
          const ref = project?.shots.flatMap(shot => shot.mediaFiles).find(file => file.id === url.searchParams.get('file'));
          if (!ref || !inside(project.sourcePath, ref.absolutePath)) throw new Error('素材不存在');
          // Reject newly introduced links too, without relying on Windows realpath support.
          let current = project.sourcePath;
          for (const part of ['', ...path.relative(project.sourcePath, ref.absolutePath).split(path.sep)]) {
            current = path.join(current, part);
            if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('素材路径已改变，请重新导入');
          }
          await sendFile(request, response, ref.absolutePath); return;
        }
        if (url.pathname === '/api/result' && ['GET', 'HEAD'].includes(request.method)) {
          const attempt = store.attempt(url.searchParams.get('attempt'));
          const output = attempt?.outputs.find(item => item.candidate === Number(url.searchParams.get('candidate') || 0));
          if (!output || !inside(outputRoot, output.path)) throw new Error('生成视频不存在');
          await sendFile(request, response, output.path, url.searchParams.has('download') ? output.filename : null); return;
        }
        json(response, { error: '接口不存在' }, 404); return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) { json(response, { error: '请求方法不支持' }, 405); return; }
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
      const asset = assets[url.pathname];
      if (!asset) { response.writeHead(404); response.end('Not Found'); return; }
      let content = await fs.readFile(path.join(projectRoot, 'public', asset[0]), 'utf8');
      if (url.pathname === '/') content = content.replace('__CSRF_TOKEN__', csrf);
      response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' }); response.end(content);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const message = String(error.message || '操作失败').replaceAll(session.key || '\u0000', '[已隐藏]').slice(0, 800);
      json(response, { error: message }, 400);
    }
  });
  return {
    server, store, queue, csrf, handler: server.listeners('request')[0],
    async initialize({ seed = false } = {}) {
      if (seed && !store.projects().length) {
        try { await importFolder({ sourcePath: DEFAULT_SAMPLE, name: '示例项目' }); }
        catch { /* The sample is optional. */ }
      }
      ready = true;
    },
    async listen(port = 3280, { seed = false } = {}) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      if (seed && !store.projects().length) {
        try { await importFolder({ sourcePath: DEFAULT_SAMPLE, name: '示例项目' }); }
        catch { /* The sample directory is optional; user can import a different project. */ }
      }
      ready = true; queue.start();
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() { ready = false; queue.stop(); await Promise.allSettled([...queue.running]); if (server.listening) { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); } store.close(); },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const studio = await createStudio();
  try {
    const url = await studio.listen(Number(process.env.XYQ_PORT || 3280));
    console.log(`小云雀短剧批量工作台已启动：${url}`);
    console.log('关闭这个窗口会停止本地调度；下次启动可恢复已有任务。');
    if (process.argv.includes('--open')) execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
    process.on('SIGINT', () => { studio.queue.stop(); process.exit(0); });
    process.on('SIGTERM', () => { studio.queue.stop(); process.exit(0); });
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? '3280 端口已被占用。若工作台已经启动，请直接打开 http://127.0.0.1:3280' : error.message);
    studio.store.close(); process.exitCode = 1;
  }
}
