import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ACTIVE_STATES, IN_FLIGHT, validateShot, buildPayload, sanitizeName } from './catalog.mjs';
import { XiaoyunqueProvider } from './provider.mjs';

export function keyIdentity(key) { return createHash('sha256').update(key).digest('hex'); }
const now = () => new Date().toISOString();

export async function verifySource(snapshot) {
  for (const ref of snapshot.references) {
    const relative = path.relative(snapshot.sourcePath, ref.absolutePath);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('素材路径越过项目目录');
    const parts = relative.split(path.sep);
    let current = snapshot.sourcePath;
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('源目录已变成链接，请重新导入');
    for (const part of parts) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('素材路径包含链接，请重新导入');
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(ref.absolutePath)) hash.update(chunk);
    if (hash.digest('hex') !== ref.sha256) throw new Error(`素材内容已改变，请重新导入后生成：${ref.name}`);
  }
}

export class Queue {
  constructor(store, outputRoot, { getKey, providerFactory = key => new XiaoyunqueProvider(key), pollMs = 5000 } = {}) {
    this.store = store; this.outputRoot = outputRoot; this.getKey = getKey;
    this.providerFactory = providerFactory; this.pollMs = pollMs; this.busy = new Set(); this.running = new Set(); this.timer = null;
  }
  record(attempt, status, message) {
    attempt.status = status;
    attempt.updatedAt = now();
    attempt.message = message;
    attempt.events = [...(attempt.events || []), { at: attempt.updatedAt, status, message }].slice(-30);
    this.store.saveAttempt(attempt);
  }
  recover() {
    for (const attempt of this.store.attempts()) {
      if (attempt.status === 'submitting') this.record(attempt, 'unknown', '后台在提交期间停止，请核对远端任务；不会自动重发');
      else if (attempt.status === 'uploading') this.record(attempt, 'queued', '后台恢复，等待继续上传和提交');
    }
  }
  start() {
    this.recover();
    this.timer = setInterval(() => void this.tick().catch(() => {}), 1000);
    this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
  enqueue(projectId, shotIds, revision) {
    const key = this.getKey();
    if (!key) throw new Error('请先在连接设置中填写 API Key');
    return this.store.transaction(() => {
      const project = this.store.project(projectId);
      if (!project) throw new Error('项目不存在');
      if (project.revision !== revision) throw new Error('项目已更新，请刷新后重新检查参数');
      if (project.importIssues?.some(item => item.level === 'error')) throw new Error('项目目录存在结构错误，请修正后重新导入');
      if (!Array.isArray(shotIds) || !shotIds.length || new Set(shotIds).size !== shotIds.length) throw new Error('请选择需要生成的片段');
      const history = this.store.attempts();
      const created = [];
      for (const shotId of shotIds) {
        const shot = project.shots.find(item => item.id === shotId);
        if (!shot) throw new Error('片段不存在');
        const validation = validateShot(shot);
        if (validation.errors.length) throw new Error(`${shot.name}：${validation.errors.join('；')}`);
        if (history.some(item => item.projectId === projectId && item.shotId === shotId && ACTIVE_STATES.includes(item.status))) throw new Error(`${shot.name} 已有未结束的任务，请先处理现有任务`);
        const attempt = {
          id: randomUUID(), projectId, shotId,
          version: history.filter(item => item.projectId === projectId && item.shotId === shotId).length + 1,
          accountId: keyIdentity(key), status: 'queued', createdAt: now(), updatedAt: now(),
          snapshot: structuredClone({ ...shot, sourcePath: project.sourcePath }),
          assets: [], outputs: [], events: [], queryErrors: 0, nextPollAt: 0,
        };
        this.record(attempt, 'queued', '等待素材上传和任务提交');
        created.push(attempt);
      }
      project.paused = false; this.store.saveProject(project);
      return created;
    });
  }
  async tick() {
    const key = this.getKey();
    if (!key) return;
    const accountId = keyIdentity(key);
    const attempts = this.store.attempts();
    const projects = new Map(this.store.projects().map(project => [project.id, project]));
    let occupied = attempts.filter(item => IN_FLIGHT.includes(item.status) || this.busy.has(item.id)).length;
    const concurrency = this.store.settings().concurrency;
    const jobs = [];
    for (const attempt of attempts) {
      if (attempt.accountId !== accountId || this.busy.has(attempt.id)) continue;
      if (['generating', 'downloading'].includes(attempt.status)) {
        if ((attempt.nextPollAt || 0) <= Date.now()) jobs.push(this.track(attempt.id, key));
      } else if (attempt.status === 'queued' && !projects.get(attempt.projectId)?.paused && occupied < concurrency) {
        occupied++; jobs.push(this.track(attempt.id, key));
      }
    }
    await Promise.allSettled(jobs);
  }
  track(id, key) {
    const promise = this.process(id, key);
    this.running.add(promise);
    void promise.finally(() => this.running.delete(promise)).catch(() => {});
    return promise;
  }
  async process(id, key) {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    const provider = this.providerFactory(key);
    const attempt = this.store.attempt(id);
    try {
      if (attempt.status === 'queued') {
        await verifySource(attempt.snapshot);
        // Cancellation can arrive while hashing large files.
        if (this.store.attempt(id).status !== 'queued') return;
        this.record(attempt, 'uploading', '正在上传参考素材');
        const assets = [];
        for (const ref of attempt.snapshot.references) {
          const cacheKey = `${attempt.accountId}:${ref.sha256}`;
          let assetId = this.store.asset(cacheKey);
          if (!assetId) { assetId = await provider.upload(ref); this.store.saveAsset(cacheKey, assetId); }
          assets.push({ refId: ref.id, assetId });
          attempt.assets = assets;
          attempt.message = `素材已就绪 ${assets.length}/${attempt.snapshot.references.length}`;
          this.store.saveAttempt(attempt);
        }
        if (this.store.project(attempt.projectId)?.paused) { this.record(attempt, 'queued', '已暂停；素材缓存保留'); return; }
        this.record(attempt, 'submitting', '正在提交小云雀沉浸式短片任务');
        const result = await provider.submit(buildPayload(attempt.snapshot, assets));
        Object.assign(attempt, result, { submittedAt: now(), nextPollAt: Date.now() + this.pollMs });
        this.record(attempt, 'generating', '已提交，等待小云雀生成');
      } else if (attempt.status === 'generating') {
        if (attempt.submittedAt && Date.now() - Date.parse(attempt.submittedAt) > 12 * 3600_000) { this.record(attempt, 'query_paused', '已等待超过 12 小时，可继续查询原任务'); return; }
        const result = await provider.query(attempt);
        attempt.queryErrors = 0;
        attempt.lastError = null;
        attempt.nextPollAt = Date.now() + this.pollMs;
        if ([1, 2].includes(result.state)) { attempt.message = result.state === 1 ? '小云雀已创建任务，等待处理' : '小云雀正在生成'; this.store.saveAttempt(attempt); }
        else if (result.state === 4 || result.state === 5) this.record(attempt, 'failed', result.message || (result.state === 5 ? '远端任务已取消' : '远端生成失败'));
        else if (!result.urls.length) {
          attempt.emptyResultCount = (attempt.emptyResultCount || 0) + 1;
          if (attempt.emptyResultCount >= 3) this.record(attempt, 'artifact_missing', '远端显示成功但未返回视频链接，可继续查询原任务');
          else { attempt.message = '远端已成功，等待产物链接'; this.store.saveAttempt(attempt); }
        } else {
          attempt.videoUrls = result.urls;
          attempt.nextPollAt = 0;
          this.record(attempt, 'downloading', '生成完成，正在保存视频');
        }
      } else if (attempt.status === 'downloading') {
        const folder = path.join(this.outputRoot, attempt.projectId, String(attempt.snapshot.sequence).padStart(3, '0'));
        await fs.mkdir(folder, { recursive: true });
        for (const [index, url] of attempt.videoUrls.entries()) {
          if (attempt.outputs.some(item => item.candidate === index)) continue;
          const output = await provider.download(url, path.join(folder, `v${String(attempt.version).padStart(3, '0')}_${attempt.id}_${index + 1}`));
          attempt.outputs.push({ ...output, candidate: index, filename: `${sanitizeName(attempt.snapshot.name)}_v${attempt.version}_${index + 1}.${output.format}` });
          this.store.saveAttempt(attempt);
        }
        this.record(attempt, 'complete', '视频已保存，等待人工验收');
      }
    } catch (error) {
      const message = provider.clean ? provider.clean(error.message) : String(error.message).replaceAll(key, '[已隐藏]');
      if (attempt.status === 'generating') {
        attempt.queryErrors = (attempt.queryErrors || 0) + 1;
        attempt.lastError = message;
        attempt.nextPollAt = Date.now() + Math.min(60_000, this.pollMs * 2 ** attempt.queryErrors);
        if (attempt.queryErrors >= 10) this.record(attempt, 'query_paused', `查询暂时停止：${message}；原任务编号已保留`);
        else { attempt.message = `查询暂不可用：${message}（稍后自动查询原任务）`; this.store.saveAttempt(attempt); }
      } else if (attempt.status === 'submitting' && error.uncertain !== false) this.record(attempt, 'unknown', message);
      else if (attempt.status === 'downloading') this.record(attempt, 'download_failed', `视频下载失败：${message}；不会重新生成`);
      else this.record(attempt, error.uncertain ? 'unknown' : 'failed', message);
      if (error.auth) { const project = this.store.project(attempt.projectId); project.paused = true; this.store.saveProject(project); }
    } finally { this.busy.delete(id); }
  }
  action(id, action, input = {}) {
    const attempt = this.store.attempt(id);
    if (!attempt) throw new Error('任务不存在');
    if (this.busy.has(id)) throw new Error('当前操作进行中，请稍后重试');
    if (action === 'cancel') {
      if (attempt.status !== 'queued') throw new Error('只能撤回尚未提交的排队任务；已提交任务请在小云雀处理');
      this.record(attempt, 'cancelled', '已撤回本地排队任务');
    } else if (action === 'resume-query') {
      if (!['query_paused', 'artifact_missing', 'download_failed'].includes(attempt.status)) throw new Error('当前任务不能恢复查询');
      attempt.submittedAt = now(); attempt.queryErrors = 0; attempt.emptyResultCount = 0; attempt.nextPollAt = 0;
      this.record(attempt, 'generating', '继续查询原任务，不会重新生成');
    } else if (action === 'recover') {
      if (attempt.status !== 'unknown') throw new Error('当前任务不需要补录任务编号');
      if (!String(input.runId || '').trim() || !String(input.threadId || '').trim()) throw new Error('请同时提供小云雀的 run_id 与 thread_id');
      attempt.runId = String(input.runId).trim().slice(0, 256); attempt.threadId = String(input.threadId).trim().slice(0, 256);
      attempt.submittedAt = now(); attempt.nextPollAt = 0;
      this.record(attempt, 'generating', '已补录任务编号，开始查询原任务');
    } else if (action === 'resolve-unknown') {
      if (attempt.status !== 'unknown' || input.checkedRemote !== true) throw new Error('请先确认已在小云雀核对，且没有成功创建任务');
      this.record(attempt, 'failed', '用户已核对远端无任务，结束待核对状态；重新生成将创建新版本');
    } else throw new Error('未知任务操作');
    return attempt;
  }
}
