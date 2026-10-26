import { referenceTokens, referenceChange } from './reference-links.js';

const icons = {
  cloud: '<path d="M6 17a5 5 0 1 1 1-9.9A6 6 0 0 1 19 9a4 4 0 0 1 0 8Z"/><path d="m9 12 3-3 3 3m-3-3v10"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9Zm-9 11 9 5 9-5M3 18l9 5 9-5"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 3h6a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="8" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  play: '<path d="m9 5 11 7-11 7Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M4 12h16m-5-5 5 5-5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m5 9 7 7 7-7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 3v18M17 3v18M3 8h4m10 0h4M3 16h4m10 0h4"/>',
  music: '<path d="M9 18V5l12-2v13M9 9l12-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="18" cy="16" rx="3" ry="3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  warning: '<path d="M10.3 4 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 4a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-3-3 3-3m-6 0 3-3"/>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6Zm-2 2 5 5"/>',
  dot: '<circle cx="12" cy="12" r="4"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.film}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const stateNames = { queued: '等待提交', uploading: '上传素材', submitting: '正在提交', unknown: '待核对', generating: '生成中', downloading: '下载中', complete: '待验收', failed: '生成失败', cancelled: '已撤回', query_paused: '查询已暂停', artifact_missing: '等待产物', download_failed: '下载失败' };
const working = ['queued', 'uploading', 'submitting', 'generating', 'downloading'];
const attention = ['unknown', 'failed', 'query_paused', 'artifact_missing', 'download_failed'];
const app = { data: null, projectId: localStorage.getItem('xyq-project'), view: 'prepare', selected: new Set(), editing: null, redo: false, draft: null, queueFilter: 'all', candidates: new Map(), reviewVersions: new Map(), busy: false, fingerprint: '', submitIds: [] };
const root = document.querySelector('#app');
const dialogs = document.querySelector('#dialogs');
const csrf = document.querySelector('meta[name="csrf-token"]').content;
let toastTimer;
const durationChanges = new Map();
let savingDurations = false;
const expandedMaterials = new Set();
let draggedReference = null;
let materialPicker = null;

function toast(message, error = false) {
  const element = document.querySelector('#toast');
  element.textContent = message; element.className = `toast visible ${error ? 'error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.className = 'toast', 5000);
}
async function api(route, body, method = 'POST') {
  const response = await fetch(route, { method: body === undefined ? 'GET' : method, headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function project() { return app.data?.projects.find(item => item.id === app.projectId); }
function attemptsFor(p = project()) { return p ? app.data.attempts.filter(item => item.projectId === p.id) : []; }
function latest(shot) { return app.data.attempts.find(attempt => attempt.id === shot.latestAttemptId); }
function modelName(id) { return app.data.catalog.models.find(model => model.id === id)?.name || '未设置模型'; }
function options(items, value, placeholder) {
  return `${placeholder ? `<option value="">${esc(placeholder)}</option>` : ''}${items.map(item => { const id = typeof item === 'string' ? item : item.id; const name = typeof item === 'string' ? item : item.name; return `<option value="${esc(id)}"${id === value ? ' selected' : ''}>${esc(name)}</option>`; }).join('')}`;
}
function mediaUrl(ref) { return `/api/media?project=${app.projectId}&file=${ref.id}`; }
function resultUrl(attempt, candidate = 0, download = false) { return `/api/result?attempt=${attempt.id}&candidate=${candidate}${download ? '&download=1' : ''}`; }
function badge(status, text) { return `<span class="badge ${esc(status)}"><i></i>${esc(text || stateNames[status] || status)}</span>`; }
function shotBadge(shot) {
  const attempt = latest(shot);
  if (attempt) return badge(shot.acceptedAttemptId === attempt.id && attempt.status === 'complete' ? 'accepted' : attempt.status, shot.acceptedAttemptId === attempt.id && attempt.status === 'complete' ? '已通过' : null);
  return badge(shot.validation.errors.length ? 'unset' : 'ready', shot.validation.errors.length ? '待完善' : '可提交');
}
function thumb(shot, cls = '') {
  const image = shot.references.filter(ref => ref.kind === 'image').sort((a, b) => a.index - b.index)[0];
  return `<span class="thumb ${cls}">${image ? `<img src="${mediaUrl(image)}" loading="lazy" alt="${esc(shot.name)}分镜图">` : icon('film')}</span>`;
}
function chooseProject(id) {
  app.projectId = id; localStorage.setItem('xyq-project', id);
  app.selected = new Set(project()?.shots.map(shot => shot.id) || []); app.reviewVersions.clear(); app.candidates.clear();
  expandedMaterials.clear();
}
function setData(data) {
  app.data = data;
  if (!project() && data.projects.length) chooseProject(data.projects[0].id);
  else if (!data.projects.length) { app.projectId = null; localStorage.removeItem('xyq-project'); app.selected.clear(); expandedMaterials.clear(); }
  else if (!app.selected.size && !app.fingerprint && project()) app.selected = new Set(project().shots.map(shot => shot.id));
  app.fingerprint = JSON.stringify(data);
}
async function refresh(force = false) {
  try {
    const data = await api('/api/state');
    if (force || JSON.stringify(data) !== app.fingerprint) {
      const interacting = dialogs.querySelector('dialog[open]') || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || [...document.querySelectorAll('video,audio')].some(media => !media.paused && !media.ended);
      if (!force && (interacting || draggedReference || app.busy)) return;
      setData(data); render();
    }
    root.classList.remove('offline');
  } catch (error) {
    if (!app.data) root.innerHTML = `<div class="boot"><h2>工作台暂时无法连接</h2><p>${esc(error.message)}</p><button class="primary" data-action="reload">重新连接</button></div>`;
    else { root.classList.add('offline'); document.querySelector('.live-status')?.setAttribute('title', '后台连接中断，请检查启动窗口'); }
  }
}
async function mutate(route, body, method = 'POST') {
  if (app.busy) throw new Error('上一项操作还未完成');
  app.busy = true; document.body.classList.add('busy');
  try { const data = await api(route, body, method); setData(data.state || data); return data; }
  finally { app.busy = false; document.body.classList.remove('busy'); }
}

function render() {
  if (!app.data) return;
  const p = project(), tasks = attemptsFor(), total = p?.shots.length || 0;
  const completed = p?.shots.filter(shot => tasks.some(task => task.shotId === shot.id && task.status === 'complete')).length || 0;
  const accepted = p?.shots.filter(shot => shot.acceptedAttemptId).length || 0;
  root.innerHTML = `<aside class="sidebar">
    <a class="brand" href="/" aria-label="云雀短剧工作台首页"><span class="brand-mark">${icon('cloud')}</span><span><strong>云雀 · 批量工作台</strong><small>让故事，连续发生。</small></span></a>
    <button class="new-project" data-action="import">${icon('plus')}导入整集目录</button>
    <div class="side-label">我的项目 <span>${app.data.projects.length}</span></div>
    <nav class="project-list" aria-label="项目列表">${app.data.projects.map(item => `<button class="project-item ${item.id === app.projectId ? 'active' : ''}" data-action="project" data-id="${item.id}">${icon('folder')}<span><strong>${esc(item.name)}</strong><small>${item.shots.length} 个片段 · ${item.shots.reduce((n, shot) => n + (shot.parameters.durationSeconds || 0), 0)} 秒</small></span>${item.id === app.projectId ? '<i class="project-dot"></i>' : ''}</button>`).join('') || '<p class="side-empty">从一个整集目录开始。</p>'}</nav>
    <div class="sidebar-bottom"><div class="local-note">${icon('layers')}<span>专注沉浸式短片创作<small>素材有序，进度留存</small></span></div><button data-action="settings" class="settings-button">${icon('settings')}连接与设置<span class="key-dot ${app.data.settings.hasKey ? 'set' : ''}"></span></button></div>
  </aside><main>
    <header class="topbar"><div class="breadcrumb">${icon('grid')}<span>创作空间</span>${icon('chevron')}<strong>${esc(p?.name || '开始创作')}</strong></div><button class="live-status" data-action="settings"><i class="${app.data.settings.hasKey ? 'configured' : ''}"></i>${app.data.settings.hasKey ? 'Key 已配置' : '待配置 API Key'}${icon('chevron')}</button></header>
    <div class="workspace"><section class="page-heading"><div><div class="eyebrow">STORY WORKSPACE <span>/ 沉浸式短片</span></div><h1>${esc(p?.name || '准备好下一段故事。')}${p ? `<button class="icon-button rename" data-action="rename" aria-label="重命名项目">${icon('edit')}</button>` : ''}</h1><p>${p ? '一次整理，有序生成。把时间留给故事本身。' : '导入整集素材，开始你的第一批创作。'}</p></div><div class="heading-actions">${p ? `<button class="text-button danger-text" data-action="delete-project">删除项目</button><button class="secondary" data-action="export" ${!accepted ? 'disabled' : ''}>${icon('download')}导出已通过 <span>${accepted}</span></button>` : ''}<button class="primary" data-action="${p ? 'submit' : 'import'}">${icon(p ? 'play' : 'plus')}${p ? `生成已选 <span>${app.selected.size}</span>` : '导入整集目录'}</button></div></section>
    ${p ? `<section class="stats" aria-label="项目概况"><div>${icon('film')}<span><strong>${total}<small> 个片段</small></strong><em>完整镜头清单</em></span></div><div>${icon('clock')}<span><strong>${p.shots.reduce((n, shot) => n + (shot.parameters.durationSeconds || 0), 0)}<small> 秒</small></strong><em>计划总时长</em></span></div><div>${icon('layers')}<span><strong>${p.shots.reduce((n, shot) => n + shot.references.length, 0)}<small> 份引用</small></strong><em>图片与音视频</em></span></div><div class="stat-progress"><span><strong>${completed}<small> / ${total}</small></strong><em>${accepted} 段验收通过</em></span><div class="progress-ring" style="--progress:${total ? Math.round(completed / total * 100) : 0}%"><span>${total ? Math.round(completed / total * 100) : 0}%</span></div></div></section>
    <nav class="tabs" aria-label="工作流程">${[['prepare', 'folder', '准备镜头', total], ['queue', 'layers', '生成队列', tasks.filter(task => working.includes(task.status)).length], ['review', 'check', '成片验收', completed]].map(([id, name, text, count]) => `<button class="${app.view === id ? 'active' : ''}" data-action="view" data-view="${id}">${icon(name)}${text}<span>${count}</span></button>`).join('')}<span class="tabs-note">${p.paused ? '已暂停新增提交' : '进度自动保存'}</span></nav>
    <section class="view-content">${app.view === 'prepare' ? renderPrepare(p) : app.view === 'queue' ? renderQueue(p) : renderReview(p)}</section>` : `<div class="welcome-card">${icon('folder')}<h2>把整集素材带进来</h2><p>每个片段一个文件夹，提示词与素材放在一起。<br>导入后即可检查引用、批量设置并排队生成。</p><button class="primary" data-action="import">${icon('plus')}导入整集目录</button></div>`}
    <footer class="workspace-footer"><span><i></i>本机工作台 · 关闭页面不影响后台队列</span><span>非官方工具 · 小云雀沉浸式短片 API</span></footer></div></main>`;
}

function renderPrepare(p) {
  const errors = p.shots.filter(shot => shot.validation.errors.length).length;
  const importErrors = p.importIssues?.filter(item => item.level === 'error') || [];
  return `<div class="batch-panel"><div class="section-title"><span class="section-icon">${icon('settings')}</span><div><h2>批量设置</h2><p>应用到已选片段，也可以逐段微调。</p></div><span class="selection-summary">已选 <strong>${app.selected.size}</strong> / ${p.shots.length}</span></div>
    ${renderPresets()}<form id="batch-form" class="batch-form"><label class="model-field">生成模型<select name="model">${options(app.data.catalog.models, '', '保留各段设置')}</select></label><label>分辨率<select name="resolution">${options(app.data.catalog.resolutions, '', '保留各段设置')}</select></label><label>画幅<select name="ratio">${options(app.data.catalog.ratios, '', '保留各段画幅')}</select></label><label class="duration-field">时长 / 秒<input name="durationSeconds" type="number" min="1" max="300" placeholder="按原时长"></label><button class="secondary apply-button" type="submit">应用到已选</button></form>
    <div class="batch-foot"><span>${icon('check')}按实际顺序连续编号</span><button type="button" class="text-button" data-action="batch-materials">整理已选素材顺序</button><label class="checkbox-label"><input type="checkbox" id="sync-prompt">修改时同步提示词开头的时长与画幅</label></div></div>
    <div class="preflight ${errors || importErrors.length ? 'pending' : 'passed'}">${icon(errors || importErrors.length ? 'warning' : 'check')}<div><strong>${importErrors.length ? '目录结构需要处理' : errors ? `${errors} 个片段还需完善参数` : '片段检查通过，可以提交'}</strong><span>${importErrors.length ? esc(importErrors.map(item => item.message).join('；')) : errors ? '点击片段名称可检查提示词、参考素材和具体参数。' : '正式生成前，请确认模型权限与账户额度。'}</span></div><button class="text-button" data-action="inspect-first">查看检查</button></div>
    <div class="list-heading"><h2>片段清单 <span>${String(p.shots.length).padStart(2, '0')}</span></h2><div><span>按片段编号排序</span><button class="text-button" data-action="import">${icon('folder')}导入其他目录</button></div></div>
    <div class="shot-table"><div class="table-head"><label class="row-check"><input type="checkbox" id="select-all" aria-label="全选片段" ${app.selected.size === p.shots.length ? 'checked' : ''}></label><span>片段与素材</span><span>生成模型</span><span>时长</span><span>分辨率</span><span>状态</span><span></span></div>
    ${p.shots.map(shot => `<article class="shot-row ${app.selected.has(shot.id) ? 'selected' : ''}"><label class="row-check"><input type="checkbox" data-select="${shot.id}" aria-label="选择${esc(shot.name)}" ${app.selected.has(shot.id) ? 'checked' : ''}></label><button class="shot-identity" data-action="edit" data-id="${shot.id}">${thumb(shot)}<span><small class="shot-sequence">SHOT ${String(shot.sequence).padStart(2, '0')}</small><strong>${esc(shot.name.replace(/^\d+[_-]\d+秒[_-]/u, ''))}</strong><em>${shot.references.filter(ref => ref.kind === 'image').length} 图片${shot.references.some(ref => ref.kind === 'audio') ? ` · ${shot.references.filter(ref => ref.kind === 'audio').length} 音频` : ''} · ${esc(shot.parameters.ratio || '待选画幅')}</em></span></button><span class="row-model ${shot.parameters.model ? '' : 'not-set'}">${esc(modelName(shot.parameters.model))}</span><label class="row-duration inline-duration"><input type="number" min="1" max="300" step="1" required data-duration-shot="${shot.id}" aria-label="${esc(shot.name)}时长（秒）" title="直接修改时长，回车或离开输入框自动保存" value="${shot.parameters.durationSeconds || ''}"><small>秒</small></label><span class="row-resolution">${esc(shot.parameters.resolution || '待选择')}</span><span>${shotBadge(shot)}</span><button class="icon-button" data-action="edit" data-id="${shot.id}" aria-label="编辑${esc(shot.name)}">${icon('chevron')}</button><button class="material-toggle text-button" data-action="materials" data-id="${shot.id}" aria-expanded="${expandedMaterials.has(shot.id)}">${icon('layers')}${expandedMaterials.has(shot.id) ? '收起素材' : '调整素材'}</button></article>${expandedMaterials.has(shot.id) ? `<section class="inline-materials" aria-label="${esc(shot.name)}素材编排"><div class="editor-section-head"><h3>${esc(shot.name)} · 素材编排</h3><span class="autosave-label">调整自动保存</span></div>${renderMaterials(shot, true)}</section>` : ''}`).join('')}</div>
    <div class="source-note">${icon('folder')}<span title="${esc(p.sourcePath)}">源目录：${esc(p.sourcePath)}</span><span>已忽略未提供音色说明.txt</span></div>`;
}

function emptyView(name, title, text, action = 'prepare') {
  return `<div class="empty-view"><span class="empty-icon">${icon(name)}</span><h2>${title}</h2><p>${text}</p><button class="secondary" data-action="view" data-view="${action}">去准备镜头 ${icon('arrow')}</button></div>`;
}

function renderMaterials(shot, inline = false) {
  const context = inline ? ` data-shot="${shot.id}"` : '';
  const refs = ['image', 'video', 'audio'].flatMap(kind => shot.references.filter(ref => ref.kind === kind).sort((a, b) => a.index - b.index));
  return `<div class="material-drop" data-material-drop="${inline ? shot.id : 'draft'}"><div class="material-tools"><button type="button" class="secondary" data-action="material-pick"${context}>${icon('plus')}添加素材</button><span>可拖入文件添加，拖到卡片上替换 · 拖动卡片调整同类素材顺序 · 各类型从 1 连续编号</span><button type="button" class="text-button" data-action="ref-auto"${context}>按文件顺序整理</button></div><div class="reference-grid">${refs.map(ref => `<div class="reference-card ${ref.kind}" draggable="true" data-ref="${ref.id}" data-kind="${ref.kind}"${context}><div class="reference-preview">${ref.kind === 'image' ? `<img draggable="false" loading="lazy" src="${mediaUrl(ref)}" alt="${esc(ref.label)} ${esc(ref.name)}">` : ref.kind === 'audio' ? `<audio controls preload="none" src="${mediaUrl(ref)}"></audio>` : `<video controls preload="none" src="${mediaUrl(ref)}"></video>`}</div><strong><span class="drag-handle" aria-hidden="true">⠿</span>${esc(ref.label)}</strong><span title="${esc(ref.relativePath || ref.name)}">${esc(ref.name)}</span><div class="reference-actions"><button type="button" data-action="ref-up" data-id="${ref.id}"${context} aria-label="前移${esc(ref.label)}" ${ref.index === 1 ? 'disabled' : ''}>←</button><button type="button" data-action="ref-down" data-id="${ref.id}"${context} aria-label="后移${esc(ref.label)}" ${ref.index === refs.filter(item => item.kind === ref.kind).length ? 'disabled' : ''}>→</button><button type="button" data-action="material-replace" data-id="${ref.id}"${context}>替换</button><button type="button" data-action="ref-remove" data-id="${ref.id}"${context}>移除</button></div></div>`).join('') || '<p class="inline-help">当前没有采用素材，可从下方恢复。</p>'}</div>
    ${shot.mediaFiles.some(file => !refs.some(ref => ref.id === file.id)) ? `<label class="add-reference-label">恢复本片段素材<select data-add-reference="${inline ? shot.id : 'draft'}"><option value="">选择素材，添加到同类末尾</option>${shot.mediaFiles.filter(file => !refs.some(ref => ref.id === file.id)).map(file => `<option value="${file.id}">${esc(file.name)}</option>`).join('')}</select></label>` : ''}
    <p class="inline-help">${inline ? '调整后自动保存。' : '保存片段后生效。'}顺序就是提交给小云雀的顺序；请核对提示词中的 @图片、@音频、@视频对应关系。移除仅影响本次编排，原文件保留；已排队任务保持提交时的素材快照。${inline ? '' : '新增文件会立即存入本地素材库，取消编辑后仍可恢复采用。'}</p>${renderReferenceLinks(shot, inline)}</div>`;
}

function changeDraftReferences(refs) {
  const shot = app.draft, baseline = shot.referenceReview?.before || shot.references;
  const result = referenceChange(baseline, refs, shot.prompt);
  shot.references = result.references;
  shot.referencesConfirmed = false;
  shot.referenceReview = result.changed.length ? { before: structuredClone(baseline), changed: result.changed, canSync: result.canSync } : null;
}

function renderReferenceLinks(shot, inline) {
  const context = inline ? ` data-shot="${shot.id}"` : '';
  const tokens = referenceTokens(shot.prompt);
  let body = '', cursor = 0;
  for (const token of tokens) {
    const ref = shot.references.find(item => item.kind === token.kind && item.index === token.index);
    body += esc(shot.prompt.slice(cursor, token.start)) + `<button type="button" class="reference-token ${ref ? '' : 'missing'}" data-action="ref-focus" data-id="${ref?.id || ''}"${context} title="${ref ? esc(ref.name) : '缺少对应素材'}">${esc(token.text)}</button>`;
    cursor = token.end;
  }
  body += esc(shot.prompt.slice(cursor));
  const review = shot.referenceReview;
  return `${review?.changed?.length ? `<div class="reference-review" role="status"><strong>素材对应关系已变化，请核对提示词</strong>${review.changed.map(item => `<p>${esc(item.oldLabel)} · ${esc(item.name)} → ${esc(item.newLabel || '已移除')}</p>`).join('')}<div><button type="button" class="secondary" data-action="ref-sync"${context} ${review.canSync ? '' : 'disabled'}>同步引用，保持原素材对应</button><button type="button" class="text-button" data-action="ref-confirm"${context}>已核对，保留当前提示词</button></div>${review.canSync ? '' : '<small>已移除的素材仍被引用，请先编辑提示词或恢复素材。</small>'}</div>` : ''}<details class="reference-link-preview"><summary>提示词与素材引用 · 点击引用定位素材</summary><div class="linked-prompt">${body}</div></details>`;
}

function focusReference(id, shotId) {
  if (!id) { toast('这个引用缺少素材，请添加素材或修改提示词', true); return; }
  document.querySelectorAll('.reference-focused').forEach(card => card.classList.remove('reference-focused'));
  const card = document.querySelector(`[data-ref="${id}"]${shotId ? `[data-shot="${shotId}"]` : ':not([data-shot])'}`);
  card?.classList.add('reference-focused'); card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function uploadMaterials(files, shotId, replaceId = '') {
  if (app.busy) throw new Error('请等待上一项操作完成');
  files = [...files].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  if (!files.length) return;
  if (replaceId && files.length !== 1) throw new Error('替换时请只选择一个文件');
  if (files.length > 50) throw new Error('一次最多添加 50 个文件');
  const extensions = { image: ['png','jpg','jpeg','webp','bmp','gif'], audio: ['wav','mp3','m4a','aac','flac','ogg'], video: ['mp4','mov','webm','mkv','avi'] };
  const limits = app.data.catalog.mediaLimits || { image: 50 * 1024 ** 2, audio: 200 * 1024 ** 2, video: 500 * 1024 ** 2 };
  for (const file of files) {
    const kind = Object.keys(extensions).find(kind => extensions[kind].includes(file.name.split('.').at(-1).toLowerCase()));
    if (!kind || !file.size || file.size > limits[kind]) throw new Error(`文件类型、大小不符合要求：${file.name}`);
  }
  const draft = shotId === 'draft';
  if (draft) draftFromForm();
  const realShotId = draft ? app.draft.id : shotId;
  app.busy = true; document.body.classList.add('busy');
  let count = 0;
  try {
    for (const file of files) {
      toast(`正在保存素材 ${count + 1}/${files.length}：${file.name}`);
      const p = project();
      const query = new URLSearchParams({ name: file.name, revision: p.revision, ...(replaceId ? { replace: replaceId } : {}), ...(draft ? { stage: '1' } : {}) });
      const response = await fetch(`/api/projects/${p.id}/shots/${realShotId}/media?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '素材添加失败');
      setData(result.state);
      if (draft) {
        const saved = project().shots.find(shot => shot.id === realShotId);
        const added = saved.mediaFiles.find(ref => ref.id === result.fileId);
        app.draft.mediaFiles.push(structuredClone(added));
        changeDraftReferences(replaceId ? app.draft.references.map(ref => ref.id === replaceId ? added : ref) : [...app.draft.references, added]);
      }
      count++;
    }
    toast(`已${replaceId ? '替换' : '添加'} ${count} 份素材${draft ? '，保存片段后采用' : ''}`);
  } catch (error) { toast(`${error.message}${count ? `；已保存前 ${count} 份素材` : ''}`, true); }
  finally { app.busy = false; document.body.classList.remove('busy'); if (draft) renderEditor(); else render(); }
}

function renderPresets() {
  return `<div class="preset-toolbar"><label>参数模板<select id="preset-choice"><option value="">选择常用参数模板</option>${(app.data.presets || []).map(preset => `<option value="${preset.id}">${esc(preset.name)}</option>`).join('')}</select></label><button type="button" class="secondary" data-action="preset-apply">应用到已选</button><button type="button" class="text-button" data-action="preset-new">保存参数为模板</button><button type="button" class="text-button" data-action="preset-edit">管理所选模板</button></div>`;
}

function openPreset(id) {
  const preset = (app.data.presets || []).find(item => item.id === id);
  const form = document.querySelector('#batch-form'), values = form ? new FormData(form) : null;
  const shot = project()?.shots.find(item => app.selected.has(item.id)) || project()?.shots[0];
  const p = preset?.parameters || { ...shot?.parameters, concurrency: app.data.settings.concurrency, durationSeconds: null };
  if (!preset && values) for (const field of ['model', 'resolution', 'ratio', 'durationSeconds']) if (values.get(field)) p[field] = values.get(field);
  showDialog(`${dialogHeader(preset ? '管理参数模板' : '保存参数模板', '模板只保存生成参数；时长留空时保留各片段时长。')}<form id="preset-form" data-id="${preset?.id || ''}" class="dialog-body"><label>模板名称<input name="name" required maxlength="80" value="${esc(preset?.name || '')}" placeholder="例如 日常短剧 720p"></label><label>生成模型<select name="model" required>${options(app.data.catalog.models, p.model, '请选择')}</select></label><div class="editor-parameters"><label>分辨率<select name="resolution" required>${options(app.data.catalog.resolutions, p.resolution, '请选择')}</select></label><label>画幅<select name="ratio" required>${options(app.data.catalog.ratios, p.ratio, '请选择')}</select></label><label>并发数<select name="concurrency">${options(['1','2','3','4'], String(p.concurrency || 3))}</select></label><label>固定时长 / 秒<input name="durationSeconds" type="number" min="1" max="300" value="${p.durationSeconds || ''}" placeholder="保留各段时长"></label></div><p class="inline-help">应用时修改所选片段参数和工作台并发数，不会开始生成。提示词保持原文，请核对画幅和时长。</p><div class="dialog-actions">${preset ? `<button type="button" class="text-button danger-text" data-action="preset-delete" data-id="${preset.id}">删除模板</button>` : ''}<button type="button" class="secondary" data-action="close">取消</button><button type="submit" class="primary">保存模板</button></div></form>`);
}

async function saveMaterialOrder(shotId, refs, autoOrder = false) {
  const p = project();
  await mutate(`/api/projects/${p.id}`, { revision: p.revision, shots: [{ id: shotId, ...(autoOrder ? { autoOrder: true } : { references: refs.map(ref => ref.id) }) }] }, 'PATCH');
  render(); toast('素材顺序已保存；后续新任务将使用这个顺序');
}

function openDeleteProject() {
  const p = project();
  showDialog(`${dialogHeader('删除项目', esc(p.name))}<div class="dialog-body"><p class="delete-explanation">将移除本项目、历史任务和验收记录，并撤回尚未提交的排队项。原素材、已下载的视频和导出文件会保留在磁盘上。</p><p class="inline-help">有正在处理或待核对的任务时无法删除，请先在生成队列处理完毕。删除后可重新导入素材，但不会恢复历史记录。</p><div class="dialog-actions"><button class="secondary" data-action="close">取消</button><button class="danger-button" data-action="confirm-delete" data-id="${p.id}" data-revision="${p.revision}">删除项目</button></div></div>`);
}
function renderQueue(p) {
  const tasks = attemptsFor();
  const filtered = tasks.filter(task => app.queueFilter === 'all' || (app.queueFilter === 'active' ? working.includes(task.status) : app.queueFilter === 'attention' ? attention.includes(task.status) : task.status === 'complete'));
  return `<div class="queue-toolbar"><div class="filter-tabs">${[['all', '全部任务'], ['active', '进行中'], ['attention', '需处理'], ['complete', '已完成']].map(([id, text]) => `<button class="${app.queueFilter === id ? 'active' : ''}" data-action="filter" data-filter="${id}">${text}</button>`).join('')}</div><button class="secondary" data-action="pause">${icon(p.paused ? 'play' : 'pause')}${p.paused ? '继续提交' : '暂停新增提交'}</button></div>
    ${tasks.length && !app.data.settings.hasKey ? '<div class="preflight pending">'+icon('key')+'<div><strong>请配置 API Key 以继续后台处理</strong><span>现有任务编号和结果均已保存。</span></div><button class="text-button" data-action="settings">配置</button></div>' : ''}
    ${!tasks.length ? emptyView('layers', '队列准备好了，等待你的镜头。', '设置好模型、时长和分辨率，即可启动整批生成。') : !filtered.length ? '<div class="empty-view compact"><h2>这一分类下没有任务</h2></div>' : `<div class="queue-list">${filtered.slice().reverse().map(task => {
      const shot = p.shots.find(item => item.id === task.shotId);
      return `<article class="task-card"><div class="task-main">${thumb(shot)}<div class="task-copy"><div><span class="shot-sequence">SHOT ${String(task.snapshot.sequence).padStart(2, '0')}</span><strong>${esc(task.snapshot.name)}</strong><span class="version-tag">V${String(task.version).padStart(2, '0')}</span></div><p>${esc(modelName(task.snapshot.parameters.model))} · ${task.snapshot.parameters.durationSeconds} 秒 · ${esc(task.snapshot.parameters.resolution)} · ${esc(task.snapshot.parameters.ratio)}</p><small class="task-message ${attention.includes(task.status) ? 'attention-text' : ''}">${esc(task.message)}</small>${task.keyMismatch ? '<small class="attention-text">请使用创建本任务时的 API Key 继续处理</small>' : ''}</div>${badge(task.status)}</div><div class="task-footer"><span>${new Date(task.createdAt).toLocaleString('zh-CN', { hour12: false })}</span><div>${task.status === 'queued' ? `<button class="text-button" data-action="task" data-id="${task.id}" data-task-action="cancel">撤回排队</button>` : ''}${['query_paused', 'artifact_missing', 'download_failed'].includes(task.status) ? `<button class="text-button" data-action="task" data-id="${task.id}" data-task-action="resume-query">继续查询 / 下载</button>` : ''}${task.status === 'unknown' ? `<button class="text-button" data-action="recover" data-id="${task.id}">核对并恢复</button>` : ''}${task.status === 'failed' ? `<button class="text-button" data-action="redo" data-id="${shot.id}">调整后重做</button>` : ''}${task.status === 'complete' ? `<button class="text-button" data-action="view" data-view="review">去验收 ${icon('arrow')}</button>` : ''}<button class="text-button muted" data-action="task-detail" data-id="${task.id}">任务详情</button></div></div></article>`;
    }).join('')}</div>`}<p class="view-note">暂停仅停止新增提交。已提交任务仍会查询、下载；关闭网页后后台继续处理。</p>`;
}

function renderReview(p) {
  const complete = attemptsFor().filter(task => task.status === 'complete');
  if (!complete.length) return emptyView('play', '好故事，值得逐段打磨。', '生成完成后，视频会出现在这里。可以逐段验收、比较版本，再选择最终采用的片段。');
  return `<div class="review-heading"><div><h2>逐段验收</h2><p>保留每一版，只采用你满意的那一版。</p></div><span class="badge accepted">${p.shots.filter(shot => shot.acceptedAttemptId).length} / ${p.shots.length} 已通过</span></div><div class="review-grid">${p.shots.map(shot => {
    const versions = complete.filter(task => task.shotId === shot.id);
    const task = versions.find(item => item.id === app.reviewVersions.get(shot.id)) || versions.find(item => item.id === shot.acceptedAttemptId) || versions.at(-1);
    if (!task) return `<article class="review-card waiting">${thumb(shot)}<div class="review-card-body"><small class="shot-sequence">SHOT ${String(shot.sequence).padStart(2, '0')}</small><h3>${esc(shot.name)}</h3><p>等待生成完成</p></div></article>`;
    const candidate = app.candidates.has(task.id) ? app.candidates.get(task.id) : shot.acceptedAttemptId === task.id ? shot.acceptedCandidate : task.outputs[0].candidate;
    const accepted = shot.acceptedAttemptId === task.id && shot.acceptedCandidate === candidate;
    const output = task.outputs.find(item => item.candidate === candidate);
    const actual = output?.metadata;
    const durationDiff = actual?.durationSeconds && Math.abs(actual.durationSeconds - task.snapshot.parameters.durationSeconds) > 1;
    return `<article class="review-card"><div class="review-video"><video controls preload="metadata" src="${resultUrl(task, candidate)}" aria-label="${esc(shot.name)}第${task.version}版"></video>${accepted ? '<span class="accepted-overlay">'+icon('check')+'已采用</span>' : ''}</div><div class="review-card-body"><div class="review-title"><small class="shot-sequence">SHOT ${String(shot.sequence).padStart(2, '0')}</small><select class="version-select" aria-label="${esc(shot.name)}版本" data-review-version="${shot.id}">${versions.map(item => `<option value="${item.id}" ${item.id === task.id ? 'selected' : ''}>V${String(item.version).padStart(2, '0')}${item.id === shot.acceptedAttemptId ? ' · 已采用' : ''}</option>`).join('')}</select></div><h3>${esc(shot.name.replace(/^\d+[_-]\d+秒[_-]/u, ''))}</h3><p>请求：${esc(modelName(task.snapshot.parameters.model))} · ${task.snapshot.parameters.durationSeconds} 秒 · ${esc(task.snapshot.parameters.resolution)}</p>${actual ? `<p class="actual-metadata ${durationDiff ? 'attention-text' : ''}">实际：${actual.width} × ${actual.height}${actual.durationSeconds ? ` · ${actual.durationSeconds.toFixed(2)} 秒` : ''}${durationDiff ? ' · 请检查时长偏差' : ''}</p>` : '<p class="actual-metadata">实际尺寸与时长待检测</p>'}${task.outputs.length > 1 ? `<label class="candidate-label">视频候选<select aria-label="视频候选" data-candidate="${task.id}">${task.outputs.map(output => `<option value="${output.candidate}" ${output.candidate === candidate ? 'selected' : ''}>候选 ${output.candidate + 1}</option>`).join('')}</select></label>` : ''}<div class="review-actions"><button class="${accepted ? 'accepted-button' : 'primary'}" data-action="accept" data-id="${task.id}" data-candidate="${candidate}" data-accepted="${!accepted}">${icon('check')}${accepted ? '已通过 · 取消采用' : '通过并采用'}</button><button class="secondary" data-action="redo" data-id="${shot.id}" aria-label="重做${esc(shot.name)}">${icon('refresh')}重做</button><a class="icon-button" href="${resultUrl(task, candidate, true)}" aria-label="下载视频">${icon('download')}</a></div></div></article>`;
  }).join('')}</div><p class="view-note">画面内容、音色、口型和连续性需要人工验收。导出只包含已通过并选定的版本。</p>`;
}

function showDialog(html, cls = '') {
  dialogs.innerHTML = `<dialog class="${cls}">${html}</dialog>`;
  const dialog = dialogs.querySelector('dialog'); dialog.showModal();
  dialog.addEventListener('click', event => { if (event.target === dialog && !app.busy) closeDialog(); });
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!app.busy) closeDialog(); });
}
function closeDialog() { dialogs.querySelector('dialog')?.close(); dialogs.innerHTML = ''; app.editing = null; app.draft = null; app.redo = false; }
const dialogHeader = (title, subtitle = '') => `<header class="dialog-header"><div><h2>${title}</h2>${subtitle ? `<p>${subtitle}</p>` : ''}</div><button class="icon-button" data-action="close" aria-label="关闭">${icon('close')}</button></header>`;

function openSettings() {
  const keyStatus = app.data.settings.keyConfig;
  const keyInfo = keyStatus?.source === 'file' ? '已从 API密钥.txt 读取；修改文件保存后自动生效。' : keyStatus?.error || '也可在工作台根目录的 API密钥.txt 中填写一行 Key，保存后自动读取。';
  showDialog(`${dialogHeader('连接与设置', '使用你的小云雀 Access Key 连接生成服务。')}<form id="settings-form" class="dialog-body"><label>API Key<input type="password" name="apiKey" autocomplete="off" spellcheck="false" placeholder="${app.data.settings.hasKey ? '已配置；留空则保留当前 Key' : '粘贴小云雀 API Key'}"></label><div class="inline-help">${icon('key')}${esc(keyInfo)} 网页填写的 Key 仅本次有效，会优先于文件。</div><label>同时生成的任务数<select name="concurrency">${options(['1', '2', '3', '4'], String(app.data.settings.concurrency))}</select><small>默认 1；提高前请确认账号允许的并发数。</small></label><label>视频输出目录<input readonly value="${esc(app.data.settings.outputRoot)}"></label><div class="settings-tools"><button type="button" class="text-button" data-action="use-key-file">使用文本文档中的 Key</button><button type="button" class="text-button" data-action="clear-assets">清除素材上传缓存</button>${app.data.settings.hasKey ? '<button type="button" class="text-button danger-text" data-action="remove-key">清除本次 Key</button>' : ''}</div><div class="dialog-actions"><button type="button" class="secondary" data-action="close">取消</button><button class="primary" type="submit">保存设置</button></div></form>`);
}
function openImport() {
  showDialog(`${dialogHeader('导入整集目录', '片段子目录中的提示词与素材会自动整理成清单。')}<form id="import-form" class="dialog-body"><label>整集文件夹路径<input name="sourcePath" required value="${esc(project()?.sourcePath || '')}" placeholder="例如 D:\短剧\第一集"></label><label>项目名称<input name="name" placeholder="可选，默认使用文件夹名称" maxlength="100"></label><div class="import-guide"><strong>你的目录可以保持现在的结构</strong><pre>第一集/<br>  01_15秒_片段名/<br>    视频提示词.txt<br>    素材/九宫格实景分镜.png<br>    素材/图片2_角色.png<br>    素材/音频1_音色.mp3</pre><small>未提供音色说明.txt 会直接忽略。</small></div><label class="checkbox-label"><input name="createNew" type="checkbox">作为新项目导入（保留旧项目与版本）</label><div class="dialog-actions"><button type="button" class="secondary" data-action="close">取消</button><button class="primary" type="submit">${icon('folder')}读取并导入</button></div></form>`);
}
function openEditor(id, redo = false) {
  const shot = project().shots.find(item => item.id === id);
  app.editing = id; app.draft = structuredClone(shot); app.redo = redo;
  renderEditor();
}
function draftFromForm() {
  const form = document.querySelector('#shot-form');
  if (!form) return;
  const data = new FormData(form);
  app.draft.prompt = data.get('prompt');
  app.draft.parameters = { model: data.get('model') || null, resolution: data.get('resolution') || null, ratio: data.get('ratio') || null, durationSeconds: Number(data.get('durationSeconds')), generateType: data.get('generateType') === '1' ? 1 : null };
}
function renderEditor() {
  const shot = app.draft;
  const previous = dialogs.querySelector('dialog'); if (previous) previous.close();
  showDialog(`${dialogHeader(esc(shot.name), '编辑当前片段；已提交任务的参数快照和旧版本不会改变。')}<form id="shot-form" class="dialog-body"><div class="editor-parameters"><label class="editor-model">生成模型<select name="model">${options(app.data.catalog.models, shot.parameters.model, '选择模型')}</select></label><label>分辨率<select name="resolution">${options(app.data.catalog.resolutions, shot.parameters.resolution, '请选择')}</select></label><label>画幅<select name="ratio">${options(app.data.catalog.ratios, shot.parameters.ratio, '请选择')}</select></label><label>时长 / 秒<input name="durationSeconds" type="number" value="${shot.parameters.durationSeconds || ''}" min="1" max="300" required></label></div><label class="checkbox-label"><input name="generateType" type="checkbox" value="1" ${shot.parameters.generateType === 1 ? 'checked' : ''}>首尾帧模式（两张参考图）</label>
    <div class="editor-section-head"><h3>参考素材 <span>${shot.references.length}</span></h3></div>${renderMaterials(shot)}
    <div class="editor-section-head"><h3>视频提示词</h3><button type="button" class="text-button" data-action="sync-draft">同步开头的时长与画幅</button></div><textarea name="prompt" class="prompt-editor" spellcheck="false" aria-label="视频提示词" required>${esc(shot.prompt)}</textarea>
    ${shot.validation?.errors.length || shot.validation?.warnings.length ? `<div class="editor-issues">${[...(shot.validation.errors || []), ...(shot.validation.warnings || [])].map(message => `<p>${icon('warning')}${esc(message)}</p>`).join('')}</div>` : ''}
    <div class="dialog-actions sticky-actions"><button type="button" class="secondary" data-action="close">取消</button><button type="submit" class="primary">${icon('check')}${app.redo ? '保存并生成新版' : '保存片段'}</button></div></form>`, 'editor-dialog');
}

function openSubmit(ids = [...app.selected]) {
  const shots = project().shots.filter(shot => ids.includes(shot.id));
  if (!shots.length) { toast('请先选择要生成的片段', true); return; }
  const issues = shots.flatMap(shot => shot.validation.errors.map(message => `${shot.name}：${message}`));
  if (issues.length) { toast(issues[0], true); openEditor(shots.find(shot => shot.validation.errors.length).id); return; }
  if (!app.data.settings.hasKey) { toast('请先填写 API Key；参数已保留'); openSettings(); return; }
  app.submitIds = shots.map(shot => shot.id);
  const warnings = shots.flatMap(shot => shot.validation.warnings.map(message => `${shot.name}：${message}`));
  showDialog(`${dialogHeader('检查并开始生成', '以下参数将作为本次任务快照保存。')}<div class="dialog-body"><div class="submit-summary"><strong>${shots.length}<small> 个片段</small></strong><strong>${shots.reduce((n, shot) => n + shot.parameters.durationSeconds, 0)}<small> 秒</small></strong><strong>${app.data.settings.concurrency}<small> 个并发</small></strong></div><div class="submit-list">${shots.map(shot => `<div><strong>${esc(shot.name)}</strong><span>${esc(modelName(shot.parameters.model))} · ${shot.parameters.durationSeconds} 秒 · ${esc(shot.parameters.resolution)} · ${shot.references.length} 份素材</span></div>`).join('')}</div>${warnings.length ? `<div class="editor-issues">${warnings.map(message => `<p>${icon('warning')}${esc(message)}</p>`).join('')}</div>` : ''}<div class="billing-note">素材和提示词将发送至小云雀，并按你的账户规则消耗额度。重复生成会创建新版本；旧版本和已采用版本会保留。</div><div class="dialog-actions"><button class="secondary" data-action="close">再检查一下</button><button class="primary" data-action="confirm-submit">${icon('play')}提交 ${shots.length} 个片段</button></div></div>`);
}
function syncOpening(prompt, parameters) {
  const lines = prompt.split(/(?<=\n)/u);
  let foundDuration = false, foundRatio = false, nonempty = 0;
  return lines.map(line => {
    if (!line.trim() || nonempty >= 2) return line;
    nonempty++;
    if (!foundDuration && parameters.durationSeconds) line = line.replace(/(^|[，,\s])\d+秒(?=[，,。\s]|$)/u, (_, prefix) => { foundDuration = true; return `${prefix}${parameters.durationSeconds}秒`; });
    if (!foundRatio && parameters.ratio) line = line.replace(/(?:16:9|9:16|4:3|3:4|1:1)/u, () => { foundRatio = true; return parameters.ratio; });
    return line;
  }).join('');
}

document.addEventListener('submit', async event => {
  event.preventDefault(); if (app.busy) return;
  const form = event.target, data = new FormData(form);
  try {
    if (form.id === 'settings-form') {
      const body = { concurrency: Number(data.get('concurrency')) };
      if (data.get('apiKey')) body.apiKey = data.get('apiKey');
      await mutate('/api/settings', body); form.querySelector('[name=apiKey]').value = ''; closeDialog(); render(); toast('设置已保存；Key 仅在后台内存中保留');
    } else if (form.id === 'import-form') {
      const response = await mutate('/api/import', { sourcePath: data.get('sourcePath'), name: data.get('name'), createNew: data.get('createNew') === 'on' });
      chooseProject(response.projectId); app.view = 'prepare'; closeDialog(); render(); toast('目录已导入，未调用生成接口');
    } else if (form.id === 'batch-form') {
      if (!app.selected.size) throw new Error('请先选择片段');
      const parameters = {};
      for (const field of ['model', 'resolution', 'ratio', 'durationSeconds']) if (data.get(field)) parameters[field] = field === 'durationSeconds' ? Number(data.get(field)) : data.get(field);
      if (!Object.keys(parameters).length) throw new Error('请至少选择一项需要修改的参数');
      const sync = document.querySelector('#sync-prompt').checked;
      const p = project();
      const shots = p.shots.filter(shot => app.selected.has(shot.id)).map(shot => ({ id: shot.id, parameters, ...(sync ? { prompt: syncOpening(shot.prompt, { ...shot.parameters, ...parameters }) } : {}) }));
      await mutate(`/api/projects/${p.id}`, { revision: p.revision, shots }, 'PATCH'); render(); toast(`已更新 ${shots.length} 个片段`);
    } else if (form.id === 'shot-form') {
      draftFromForm(); const p = project(), draft = app.draft;
      await mutate(`/api/projects/${p.id}`, { revision: p.revision, shots: [{ id: draft.id, prompt: draft.prompt, parameters: draft.parameters, references: draft.references.map(ref => ref.id), confirmReferences: draft.referencesConfirmed === true, ...(draft.referenceReview ? { referenceBaseline: draft.referenceReview.before.map(ref => ref.id) } : {}) }] }, 'PATCH');
      const redo = app.redo, shotId = draft.id;
      closeDialog(); render(); toast('片段已保存');
      if (redo) openSubmit([shotId]);
    } else if (form.id === 'preset-form') {
      const parameters = Object.fromEntries(['model','resolution','ratio','concurrency','durationSeconds'].map(field => [field, data.get(field)]));
      await mutate('/api/presets', { ...(form.dataset.id ? { id: form.dataset.id } : {}), name: data.get('name'), parameters });
      closeDialog(); render(); toast('参数模板已保存');
    } else if (form.id === 'rename-form') {
      const p = project(); await mutate(`/api/projects/${p.id}`, { revision: p.revision, name: data.get('name') }, 'PATCH'); closeDialog(); render();
    } else if (form.id === 'recover-form') {
      await mutate(`/api/attempts/${form.dataset.id}/action`, { action: 'recover', runId: data.get('runId'), threadId: data.get('threadId') }); closeDialog(); render(); toast('已恢复原任务查询');
    }
  } catch (error) { toast(error.message, true); }
});

async function saveInlineDurations() {
  if (savingDurations) return;
  savingDurations = true;
  try {
    while (durationChanges.size) {
      const [key, change] = durationChanges.entries().next().value;
      durationChanges.delete(key);
      const p = app.data.projects.find(item => item.id === change.projectId);
      const shot = p?.shots.find(item => item.id === change.shotId);
      if (!shot || shot.parameters.durationSeconds === change.durationSeconds) continue;
      try {
        const patch = { id: shot.id, parameters: { durationSeconds: change.durationSeconds } };
        if (change.syncPrompt) patch.prompt = syncOpening(shot.prompt, { durationSeconds: change.durationSeconds });
        await mutate(`/api/projects/${p.id}`, { revision: p.revision, shots: [patch] }, 'PATCH');
        toast('时长已保存');
      } catch (error) {
        const field = document.querySelector(`[data-duration-shot="${change.shotId}"]`);
        if (field && !durationChanges.has(key)) field.value = shot.parameters.durationSeconds || '';
        toast(`时长未保存：${error.message}`, true);
      }
    }
  } finally {
    savingDurations = false;
    // Leave a subsequently focused field intact so quick, consecutive edits are not lost.
    if (!document.activeElement?.matches('[data-duration-shot]')) render();
  }
}

document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.matches('[data-duration-shot]')) {
    event.preventDefault();
    event.target.blur();
  }
});

document.addEventListener('focusout', event => {
  if (event.target.matches('[data-duration-shot]') && !savingDurations) {
    queueMicrotask(() => {
      if (!savingDurations && !document.activeElement?.matches('[data-duration-shot]')) render();
    });
  }
});

document.addEventListener('change', event => {
  const target = event.target;
  if (target.id === 'material-file-picker') {
    const files = [...target.files], picker = materialPicker; target.remove();
    if (picker) void uploadMaterials(files, picker.shotId, picker.replaceId).catch(error => toast(error.message, true));
    return;
  }
  if (target.dataset.durationShot) {
    const durationSeconds = Number(target.value);
    if (!target.value || !Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 300) {
      target.value = project().shots.find(shot => shot.id === target.dataset.durationShot)?.parameters.durationSeconds || '';
      toast('请输入 1–300 的整数秒数；实际范围由所选模型决定', true);
      return;
    }
    const change = { projectId: app.projectId, shotId: target.dataset.durationShot, durationSeconds, syncPrompt: document.querySelector('#sync-prompt')?.checked || false };
    durationChanges.set(`${change.projectId}:${change.shotId}`, change);
    void saveInlineDurations();
  }
  else if (target.matches('[data-select]')) { if (target.checked) app.selected.add(target.dataset.select); else app.selected.delete(target.dataset.select); render(); }
  else if (target.id === 'select-all') { app.selected = new Set(target.checked ? project().shots.map(shot => shot.id) : []); render(); }
  else if (target.dataset.reviewVersion) { app.reviewVersions.set(target.dataset.reviewVersion, target.value); render(); }
  else if (target.dataset.candidate) { app.candidates.set(target.dataset.candidate, Number(target.value)); render(); }
  else if (target.dataset.addReference && target.value) {
    if (target.dataset.addReference === 'draft') {
      draftFromForm(); changeDraftReferences([...app.draft.references, structuredClone(app.draft.mediaFiles.find(file => file.id === target.value))]); renderEditor();
    } else {
      const shot = project().shots.find(item => item.id === target.dataset.addReference);
      const refs = structuredClone(shot.references);
      refs.push(structuredClone(shot.mediaFiles.find(file => file.id === target.value)));
      void saveMaterialOrder(shot.id, refs).catch(error => { toast(error.message, true); render(); });
    }
  }
});
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]'); if (!target || target.disabled || app.busy) return;
  const action = target.dataset.action;
  try {
    if (action === 'material-pick' || action === 'material-replace') {
      materialPicker = { shotId: target.dataset.shot || 'draft', replaceId: action === 'material-replace' ? target.dataset.id : '' };
      document.querySelector('#material-file-picker')?.remove();
      const picker = document.createElement('input');
      picker.type = 'file'; picker.id = 'material-file-picker'; picker.hidden = true;
      picker.accept = '.png,.jpg,.jpeg,.webp,.bmp,.gif,.wav,.mp3,.m4a,.aac,.flac,.ogg,.mp4,.mov,.webm,.mkv,.avi';
      picker.multiple = !materialPicker.replaceId;
      // A modal makes controls outside it inert, including programmatic file-picker clicks.
      (dialogs.querySelector('dialog[open]') || document.body).append(picker);
      picker.click();
    }
    else if (action === 'ref-focus') focusReference(target.dataset.id, target.dataset.shot);
    else if (action === 'ref-sync' || action === 'ref-confirm') {
      const inline = Boolean(target.dataset.shot);
      if (!inline) draftFromForm();
      const shot = inline ? project().shots.find(shot => shot.id === target.dataset.shot) : app.draft;
      if (inline) {
        await mutate(`/api/projects/${project().id}`, { revision: project().revision, shots: [{ id: shot.id, ...(action === 'ref-sync' ? { syncReferences: true } : { confirmReferences: true }) }] }, 'PATCH'); render();
      } else {
        if (action === 'ref-sync') {
          const result = referenceChange(shot.referenceReview?.before || shot.references, shot.references, shot.prompt);
          if (!result.canSync) throw new Error('请先处理仍被引用的已移除素材');
          shot.prompt = result.syncedPrompt;
        }
        shot.referenceReview = null; shot.referencesConfirmed = true; renderEditor();
      }
      toast('引用关系已核对');
    }
    else if (action === 'preset-new') openPreset();
    else if (action === 'preset-edit') {
      const id = document.querySelector('#preset-choice').value;
      if (!id) throw new Error('请先选择模板'); openPreset(id);
    }
    else if (action === 'preset-delete') { await mutate(`/api/presets/${target.dataset.id}`, {}, 'DELETE'); closeDialog(); render(); toast('模板已删除'); }
    else if (action === 'preset-apply') {
      const id = document.querySelector('#preset-choice').value, p = project();
      if (!id || !app.selected.size) throw new Error('请选择模板和片段');
      await mutate(`/api/presets/${id}/apply`, { projectId: p.id, revision: p.revision, shotIds: [...app.selected] });
      render(); toast('参数模板已应用，未开始生成');
    }
    else if (action === 'reload') { location.reload(); return; }
    else if (action === 'import') openImport();
    else if (action === 'settings') openSettings();
    else if (action === 'close') closeDialog();
    else if (action === 'delete-project') openDeleteProject();
    else if (action === 'confirm-delete') { await mutate(`/api/projects/${target.dataset.id}`, { revision: Number(target.dataset.revision) }, 'DELETE'); closeDialog(); render(); toast('项目记录已删除，磁盘上的素材和视频已保留'); }
    else if (action === 'materials') { if (expandedMaterials.has(target.dataset.id)) expandedMaterials.delete(target.dataset.id); else expandedMaterials.add(target.dataset.id); render(); }
    else if (action === 'batch-materials') {
      const p = project(), shots = p.shots.filter(shot => app.selected.has(shot.id)).map(shot => ({ id: shot.id, autoOrder: true }));
      if (!shots.length) throw new Error('请先选择片段');
      await mutate(`/api/projects/${p.id}`, { revision: p.revision, shots }, 'PATCH'); render(); toast('已按文件顺序整理所选片段；请核对提示词引用');
    }
    else if (action === 'project') { chooseProject(target.dataset.id); render(); }
    else if (action === 'view') { app.view = target.dataset.view; render(); }
    else if (action === 'filter') { app.queueFilter = target.dataset.filter; render(); }
    else if (action === 'edit' || action === 'redo') openEditor(target.dataset.id, action === 'redo');
    else if (action === 'inspect-first') openEditor((project().shots.find(shot => shot.validation.errors.length || shot.validation.warnings.length) || project().shots[0]).id);
    else if (action === 'submit') openSubmit();
    else if (action === 'confirm-submit') {
      const p = project(); await mutate('/api/queue', { projectId: p.id, shotIds: app.submitIds, revision: p.revision }); closeDialog(); app.view = 'queue'; render(); toast('任务已进入后台队列');
    } else if (action === 'pause') { const p = project(); await mutate(`/api/projects/${p.id}/pause`, { paused: !p.paused }); render(); }
    else if (action === 'task') { await mutate(`/api/attempts/${target.dataset.id}/action`, { action: target.dataset.taskAction }); render(); }
    else if (action === 'accept') { await mutate(`/api/attempts/${target.dataset.id}/review`, { accepted: target.dataset.accepted === 'true', candidate: Number(target.dataset.candidate) }); render(); toast(target.dataset.accepted === 'true' ? '已采用这个版本' : '已取消采用'); }
    else if (action === 'use-key-file') { await mutate('/api/settings', { useKeyFile: true }); closeDialog(); render(); toast(app.data.settings.hasKey ? '已从文本文档或环境变量读取 Key' : app.data.settings.keyConfig?.error || '请在 API密钥.txt 中填写一行 Key 并保存'); }
    else if (action === 'clear-assets') { await mutate('/api/settings', { clearAssets: true }); toast('素材上传缓存已清除'); }
    else if (action === 'remove-key') { await mutate('/api/settings', { removeKey: true }); closeDialog(); render(); toast('本次 API Key 已清除'); }
    else if (action === 'export') {
      const data = await api(`/api/projects/${project().id}/export`, {});
      showDialog(`${dialogHeader('已导出采用版本', `共 ${data.count} 个片段，按镜头编号排列。`)}<div class="dialog-body"><label>导出文件夹<input readonly value="${esc(data.folder)}"></label><p class="inline-help">复制路径到资源管理器即可打开。文件夹中附有采用版本和参数清单。</p><div class="dialog-actions"><button class="primary" data-action="close">完成</button></div></div>`);
    } else if (action === 'rename') showDialog(`${dialogHeader('重命名项目')}<form id="rename-form" class="dialog-body"><label>项目名称<input name="name" required maxlength="100" value="${esc(project().name)}"></label><div class="dialog-actions"><button type="button" class="secondary" data-action="close">取消</button><button class="primary">保存</button></div></form>`);
    else if (action.startsWith('ref-')) {
      const inline = Boolean(target.dataset.shot);
      if (!inline) draftFromForm();
      const shot = inline ? project().shots.find(item => item.id === target.dataset.shot) : app.draft;
      if (action === 'ref-auto') {
        if (inline) await saveMaterialOrder(shot.id, [], true);
        else {
          // Use the same server ordering rules without saving the editor's unsaved fields.
          const response = await api('/api/material-order', { projectId: project().id, shotId: shot.id });
          changeDraftReferences(response.references); renderEditor();
        }
      } else {
        const refs = structuredClone(shot.references), index = refs.findIndex(ref => ref.id === target.dataset.id), ref = refs[index];
        if (!ref) return;
        if (action === 'ref-remove') refs.splice(index, 1);
        else {
          const same = refs.filter(item => item.kind === ref.kind), current = same.findIndex(item => item.id === ref.id), other = same[current + (action === 'ref-up' ? -1 : 1)];
          if (other) { const otherIndex = refs.indexOf(other); [refs[index], refs[otherIndex]] = [refs[otherIndex], refs[index]]; }
        }
        if (inline) await saveMaterialOrder(shot.id, refs);
        else { changeDraftReferences(refs); renderEditor(); }
      }
    } else if (action === 'sync-draft') { draftFromForm(); app.draft.prompt = syncOpening(app.draft.prompt, app.draft.parameters); renderEditor(); toast('已同步提示词开头可识别的时长与画幅，请保存片段'); }
    else if (action === 'task-detail') {
      const task = app.data.attempts.find(item => item.id === target.dataset.id);
      showDialog(`${dialogHeader('任务详情', `${esc(task.snapshot.name)} · V${task.version}`)}<div class="dialog-body"><label>run_id<input readonly value="${esc(task.runId || '尚未获取')}"></label><label>thread_id<input readonly value="${esc(task.threadId || '尚未获取')}"></label><div class="event-list">${task.events.slice().reverse().map(item => `<div><small>${new Date(item.at).toLocaleString('zh-CN', { hour12: false })}</small><p>${esc(item.message)}</p></div>`).join('')}</div><details><summary>本次提示词快照</summary><pre class="snapshot-text">${esc(task.snapshot.prompt)}</pre></details><div class="dialog-actions"><button class="secondary" data-action="close">关闭</button></div></div>`);
    } else if (action === 'recover') {
      const id = target.dataset.id;
      showDialog(`${dialogHeader('核对远端任务', '提交响应不明确。请先在小云雀查看，避免重复生成。')}<form id="recover-form" data-id="${id}" class="dialog-body"><p class="billing-note">如果已找到任务，填写对应编号恢复查询；不会重新提交。</p><label>run_id<input name="runId" required></label><label>thread_id<input name="threadId" required></label><div class="dialog-actions"><button type="button" class="text-button danger-text" data-action="resolve-unknown" data-id="${id}">已核对，远端没有创建任务</button><button class="primary">恢复原任务</button></div></form>`);
    } else if (action === 'resolve-unknown') { await mutate(`/api/attempts/${target.dataset.id}/action`, { action: 'resolve-unknown', checkedRemote: true }); closeDialog(); render(); toast('已结束待核对状态；需要生成时请新建版本'); }
  } catch (error) { toast(error.message, true); }
});

function dragTarget(event) {
  const card = event.target.closest?.('[data-ref]');
  if (!card || !draggedReference || card.dataset.kind !== draggedReference.kind
    || (card.dataset.shot || 'draft') !== draggedReference.shotId || card.dataset.ref === draggedReference.id) return null;
  return card;
}
function clearDropHints() {
  document.querySelectorAll('.drop-before,.drop-after').forEach(card => card.classList.remove('drop-before', 'drop-after'));
}
document.addEventListener('dragstart', event => {
  const card = event.target.closest?.('[data-ref]');
  if (!card || app.busy) { event.preventDefault(); return; }
  if (!card.dataset.shot) draftFromForm();
  draggedReference = { id: card.dataset.ref, kind: card.dataset.kind, shotId: card.dataset.shot || 'draft' };
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', card.dataset.ref);
  card.classList.add('dragging');
});
document.addEventListener('dragover', event => {
  if ([...(event.dataTransfer.types || [])].includes('Files')) {
    event.preventDefault();
    const zone = event.target.closest?.('[data-material-drop]');
    document.querySelectorAll('.file-drag-over').forEach(item => item.classList.remove('file-drag-over'));
    if (zone) { zone.classList.add('file-drag-over'); event.dataTransfer.dropEffect = 'copy'; }
    return;
  }
  const card = dragTarget(event);
  clearDropHints();
  if (!card) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  const rect = card.getBoundingClientRect();
  card.classList.add(event.clientX < rect.left + rect.width / 2 ? 'drop-before' : 'drop-after');
});
document.addEventListener('drop', async event => {
  document.querySelectorAll('.file-drag-over').forEach(item => item.classList.remove('file-drag-over'));
  if (event.dataTransfer?.files?.length) {
    event.preventDefault();
    const zone = event.target.closest?.('[data-material-drop]');
    if (!zone) { toast('请将文件拖入对应片段的素材区域', true); return; }
    const card = event.target.closest?.('[data-ref]');
    try { await uploadMaterials(event.dataTransfer.files, zone.dataset.materialDrop, card?.dataset.ref || ''); }
    catch (error) { toast(error.message, true); }
    return;
  }
  const card = dragTarget(event);
  if (!card || app.busy) return;
  event.preventDefault();
  const drag = draggedReference, after = card.classList.contains('drop-after');
  draggedReference = null; clearDropHints();
  document.querySelectorAll('.dragging').forEach(item => item.classList.remove('dragging'));
  const shot = drag.shotId === 'draft' ? app.draft : project().shots.find(item => item.id === drag.shotId);
  const refs = structuredClone(shot.references), sourceIndex = refs.findIndex(ref => ref.id === drag.id);
  const [moved] = refs.splice(sourceIndex, 1);
  const destination = refs.findIndex(ref => ref.id === card.dataset.ref);
  refs.splice(destination + (after ? 1 : 0), 0, moved);
  try {
    if (drag.shotId === 'draft') { changeDraftReferences(refs); renderEditor(); }
    else await saveMaterialOrder(shot.id, refs);
  } catch (error) { toast(error.message, true); render(); }
});
document.addEventListener('dragend', () => {
  draggedReference = null; clearDropHints();
  document.querySelectorAll('.dragging').forEach(card => card.classList.remove('dragging'));
});

document.addEventListener('click', event => {
  if (!event.target.matches?.('.prompt-editor') || !app.draft) return;
  const caret = event.target.selectionStart;
  const token = referenceTokens(event.target.value).find(token => caret >= token.start && caret <= token.end);
  if (token) focusReference(app.draft.references.find(ref => ref.kind === token.kind && ref.index === token.index)?.id);
});

document.addEventListener('input', event => {
  if (!event.target.matches?.('.prompt-editor') || !app.draft) return;
  draftFromForm();
  const holder = document.querySelector('#shot-form .reference-link-preview');
  if (holder) {
    const expanded = holder.open;
    const template = document.createElement('template');
    template.innerHTML = renderReferenceLinks({ ...app.draft, referenceReview: null }, false);
    holder.replaceWith(template.content.firstElementChild);
    document.querySelector('#shot-form .reference-link-preview').open = expanded;
  }
});

await refresh(true);
setInterval(() => void refresh(), 4000);

// Portable edition: inspect dimensions and duration directly in the browser too.
document.addEventListener('loadedmetadata', event => {
  const video = event.target;
  if (video.tagName !== 'VIDEO' || !video.closest('.review-video')) return;
  const label = video.closest('.review-card')?.querySelector('.actual-metadata');
  if (label && video.videoWidth && video.videoHeight) {
    label.textContent = '实际：' + video.videoWidth + ' × ' + video.videoHeight + (Number.isFinite(video.duration) ? ' · ' + video.duration.toFixed(2) + ' 秒' : '');
  }
}, true);
