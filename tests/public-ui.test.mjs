import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

async function loadUI() {
  const listeners = new Map(), writes = [];
  const shot = { id: 'shot-a', name: '镜头', sequence: 1, prompt: '@图片1 @图片2 @音频1', parameters: {}, mediaFiles: [], references: [
    { id: 'image-a', name: '01_图片1.png', kind: 'image', index: 1, label: '@图片1' },
    { id: 'image-b', name: '02_图片2.png', kind: 'image', index: 2, label: '@图片2' },
    { id: 'audio-a', name: '音频2.wav', kind: 'audio', index: 1, label: '@音频1' },
  ], validation: { errors: [], warnings: [] } };
  shot.mediaFiles = structuredClone(shot.references);
  const state = { projects: [{ id: 'project-a', name: '测试项目', revision: 1, shots: [shot] }], attempts: [], settings: {}, catalog: { models: [], resolutions: [], ratios: [] } };
  const classes = () => ({ add() {}, remove() {} });
  const root = { innerHTML: '', classList: classes() }, toast = { textContent: '', className: '' };
  const dialogs = { current: null, querySelector() { return this.current; } }, pickers = [];
  const document = {
    activeElement: null, body: { classList: classes(), append(element) { element.parent = this; } },
    querySelector(selector) { return selector === '#app' ? root : selector === '#dialogs' ? dialogs : selector === '#toast' ? toast : selector.startsWith('[data-ref=') ? { classList: classes(), scrollIntoView() {} } : selector.startsWith('meta[') ? { content: 'test-csrf' } : null; },
    createElement() { const picker = { remove() {}, click() { this.clicked = true; } }; pickers.push(picker); return picker; },
    querySelectorAll() { return []; },
    addEventListener(name, listener) { const list = listeners.get(name) || []; list.push(listener); listeners.set(name, list); },
  };
  const context = vm.createContext({ document, localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, console, setTimeout() {}, clearTimeout() {}, setInterval() {}, structuredClone,
    async fetch(route, init) {
      if (init.body) {
        const body = JSON.parse(init.body); writes.push({ route, body });
        assert.equal(init.method, 'PATCH'); assert.equal(init.headers['X-CSRF-Token'], 'test-csrf');
        const refs = body.shots[0].references.map(id => structuredClone(shot.mediaFiles.find(ref => ref.id === id)));
        const counts = {};
        for (const ref of refs) ref.index = counts[ref.kind] = (counts[ref.kind] || 0) + 1;
        shot.references = refs; state.projects[0].revision++;
      }
      return { ok: true, async json() { return structuredClone(state); } };
    },
  });
  const source = (await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*?;\r?\n/u, '');
  const links = (await fs.readFile(new URL('../public/reference-links.js', import.meta.url), 'utf8')).replaceAll('export function ', 'function ');
  await vm.runInContext(`(async () => { ${links}\n${source}\n globalThis.ui = { renderMaterials, app }; })()`, context);
  const fire = async (name, event) => { for (const listener of listeners.get(name) || []) await listener(event); };
  const card = (id, kind = 'image', shotId = 'shot-a') => {
    const names = new Set();
    const element = { dataset: { ref: id, kind, shot: shotId }, classList: { add: value => names.add(value), remove: (...values) => values.forEach(value => names.delete(value)), contains: value => names.has(value) }, getBoundingClientRect() { return { left: 0, width: 100 }; } };
    element.closest = selector => selector === '[data-ref]' ? element : null;
    return element;
  };
  return { context, shot, state, writes, root, fire, card, document, dialogs, pickers };
}

test('素材入口与连续标签可渲染，拖动同类卡片后直接保存新顺序', async () => {
  const { context, shot, writes, root, fire, card } = await loadUI();
  assert.match(root.innerHTML, /data-action="materials"/u);
  assert.match(root.innerHTML, /data-action="delete-project"/u);
  const materials = context.ui.renderMaterials(shot, true);
  assert.match(materials, /draggable="true"/u); assert.match(materials, /调整后自动保存/u);
  const transfer = { setData() {} };
  await fire('dragstart', { target: card('image-b'), dataTransfer: transfer, preventDefault() {} });
  const target = card('image-a');
  await fire('dragover', { target, clientX: 10, dataTransfer: transfer, preventDefault() {} });
  assert.ok(target.classList.contains('drop-before'));
  await fire('drop', { target, preventDefault() {} });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body.shots[0].references, ['image-b', 'image-a', 'audio-a']);
  assert.deepEqual(shot.references.filter(ref => ref.kind === 'image').map(ref => ref.index), [1, 2]);
});

test('不能跨素材类型或跨片段拖入，取消拖动不产生写入', async () => {
  const { writes, fire, card } = await loadUI();
  const transfer = { setData() {} };
  await fire('dragstart', { target: card('image-a'), dataTransfer: transfer, preventDefault() {} });
  for (const target of [card('audio-a', 'audio'), card('image-b', 'image', 'another-shot')]) {
    let prevented = false;
    await fire('dragover', { target, dataTransfer: transfer, preventDefault() { prevented = true; } });
    await fire('drop', { target, preventDefault() {} });
    assert.equal(prevented, false);
  }
  await fire('dragend', {});
  assert.equal(writes.length, 0);
});

test('点击引用定位只高亮，不会误触发排序写入', async () => {
  const { writes, fire } = await loadUI();
  const button = { dataset: { action: 'ref-focus', id: 'image-a', shot: 'shot-a' }, disabled: false };
  const target = { closest() { return button; }, matches() { return false; } };
  await fire('click', { target });
  assert.equal(writes.length, 0);
});

test('编辑弹窗内的文件选择控件必须挂在弹窗中，避免被浏览器判为不可交互', async () => {
  const { fire, document, dialogs, pickers, writes } = await loadUI();
  dialogs.current = { append(element) { element.parent = this; } };
  const button = { dataset: { action: 'material-pick' }, disabled: false };
  const target = { closest() { return button; }, matches() { return false; } };
  await fire('click', { target });
  assert.equal(pickers[0].parent, dialogs.current); assert.equal(pickers[0].clicked, true);
  dialogs.current = null;
  button.dataset.shot = 'shot-a'; await fire('click', { target });
  assert.equal(pickers[1].parent, document.body); assert.equal(pickers[1].clicked, true);
  assert.equal(writes.length, 0);
});
