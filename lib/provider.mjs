import { openAsBlob } from 'node:fs';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

const BASE = 'https://xyq.jianying.com';
const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

export class ProviderError extends Error {
  constructor(message, { uncertain = false, auth = false } = {}) { super(message); this.uncertain = uncertain; this.auth = auth; }
}

export class XiaoyunqueProvider {
  constructor(key) { this.key = key; }
  clean(message) { return String(message || '接口请求失败').replaceAll(this.key, '[已隐藏]').replace(/Bearer\s+[^\s"']+/giu, 'Bearer [已隐藏]').slice(0, 800); }
  async request(route, body, { submit = false, form = false } = {}) {
    let response;
    try {
      response = await fetch(BASE + route, {
        method: 'POST', headers: { Authorization: `Bearer ${this.key}`, Accept: 'application/json', ...(form ? {} : { 'Content-Type': 'application/json' }) },
        body: form ? body : JSON.stringify(body), signal: AbortSignal.timeout(form ? 10 * 60_000 : 120_000), redirect: 'error',
      });
    } catch { throw new ProviderError(submit ? '提交未得到明确响应，请核对小云雀任务后恢复；不会自动重发' : '连接小云雀失败，请检查网络', { uncertain: submit }); }
    let data;
    try { data = await response.json(); }
    catch { throw new ProviderError(`接口未返回有效 JSON（HTTP ${response.status}）`, { uncertain: submit }); }
    if (!response.ok) throw new ProviderError(this.clean(data.errmsg || `小云雀返回 HTTP ${response.status}`), { uncertain: submit && response.status >= 500, auth: [401, 403].includes(response.status) });
    if (!Object.hasOwn(data, 'ret')) throw new ProviderError('接口响应缺少业务返回码，请核对任务状态', { uncertain: submit });
    if (String(data.ret) !== '0') throw new ProviderError(this.clean(data.errmsg || `业务错误 ${data.ret}`));
    return data.data || {};
  }
  async upload(file) {
    const body = new FormData();
    body.append('file', await openAsBlob(file.absolutePath, { type: mime[path.extname(file.name).toLowerCase()] || 'application/octet-stream' }), file.name);
    const data = await this.request('/api/biz/v1/skill/upload_file', body, { form: true });
    if (!data.pippit_asset_id) throw new ProviderError('上传成功响应缺少资产 ID');
    return String(data.pippit_asset_id);
  }
  async submit(payload) {
    const data = await this.request('/api/biz/v1/skill/submit_run', payload, { submit: true });
    if (!data.run?.run_id || !data.run?.thread_id) throw new ProviderError('提交响应缺少任务 ID，请到小云雀核对', { uncertain: true });
    return { runId: String(data.run.run_id), threadId: String(data.run.thread_id), webLink: data.web_thread_link || null };
  }
  async query(attempt) {
    const data = await this.request('/api/biz/v1/agent/query_generate_video_result', { thread_id: attempt.threadId, run_id: attempt.runId });
    const state = Number(data.run_state);
    if (![1, 2, 3, 4, 5].includes(state)) throw new ProviderError('接口返回未知任务状态，已保留原任务编号');
    return { state, urls: Array.isArray(data.video_urls) ? data.video_urls : [], message: this.clean(data.fail_reason?.message || '') };
  }
  async download(url, destination) {
    const output = await downloadVideo(url, destination);
    try {
      const { stdout } = await runFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', output.path], { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
      const data = JSON.parse(stdout), stream = data.streams?.[0];
      if (!stream?.width || !stream?.height) throw new Error('未检测到视频画面');
      output.metadata = { width: stream.width, height: stream.height, durationSeconds: Number(data.format?.duration) || null };
    } catch (error) {
      if (error.code === 'ENOENT') output.metadataWarning = '未安装 ffprobe，尚未检测实际时长与尺寸';
      else throw new Error('视频文件无法通过媒体检测，请重新查询下载；原任务编号已保留');
    }
    return output;
  }
}

function privateAddress(address) {
  const ip = address.toLowerCase().replace(/^::ffff:/u, '');
  if (ip.includes(':')) return ip === '::' || ip === '::1' || /^(?:fc|fd|fe8|fe9|fea|feb)/u.test(ip);
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function downloadVideo(value, destination) {
  let url = new URL(value);
  let response;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('视频下载链接必须为无认证信息的 HTTPS 地址');
    const addresses = await lookup(url.hostname.replace(/^\[|\]$/gu, ''), { all: true });
    if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new Error('视频下载链接不能指向本地网络');
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20 * 60_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 5) throw new Error('视频下载重定向异常');
      url = new URL(location, url); continue;
    }
    break;
  }
  if (!response.ok || !response.body) throw new Error(`视频下载失败（HTTP ${response.status}）`);
  const type = response.headers.get('content-type') || '';
  if (/text\/|application\/json/iu.test(type)) { await response.body.cancel(); throw new Error('下载地址返回文本，请重新查询下载链接'); }
  const temporary = `${destination}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    const handle = await fs.open(temporary, 'r');
    const header = Buffer.alloc(64);
    let bytes;
    try { await handle.read(header, 0, 64, 0); bytes = (await handle.stat()).size; }
    finally { await handle.close(); }
    const format = header.includes(Buffer.from('ftyp')) ? 'mp4' : header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) ? 'webm' : null;
    if (!format || bytes < 64) throw new Error('下载内容不是可识别的 MP4/WebM 视频，请核对产物');
    const finalPath = `${destination}.${format}`;
    await fs.rename(temporary, finalPath);
    return { path: finalPath, bytes, format };
  } catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
}
