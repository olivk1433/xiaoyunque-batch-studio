import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { bindReferences, inferSettings, inspectEpisode } from '../lib/importer.mjs';

const file = (name, kind = 'image') => ({ name, kind, relativePath: name });
const prompt = '@图片1：本段唯一整张九宫格实景分镜\n@图片2：空间\n@图片3：角色';

test('按明确引用槽绑定九宫格，不使用文件枚举顺序', () => {
  const files = [file('图片3_角色.png'), file('九宫格实景分镜.png'), file('图片2_场景.png')];
  const result = bindReferences(files, prompt);
  assert.deepEqual(result.bindings.map(item => [item.index, item.name]), [[1, '九宫格实景分镜.png'], [2, '图片2_场景.png'], [3, '图片3_角色.png']]);
  assert.equal(result.issues.length, 0);
});

test('同一个角色文件在不同镜头里保留各自编号，音频独立编号', () => {
  const first = bindReferences([file('图片1_角色甲.png'), file('音频1_角色甲.mp3', 'audio')], '@图片1 @音频1');
  const second = bindReferences([file('图片1_场景.png'), file('图片2_角色甲.png')], '@图片1 @图片2');
  assert.equal(first.bindings.find(item => item.kind === 'image').index, 1);
  assert.equal(second.bindings.find(item => item.name.includes('角色甲')).index, 2);
  assert.equal(first.bindings.find(item => item.kind === 'audio').index, 1);
});

test('缺号、重复槽、未编号素材都阻止自动提交', () => {
  const result = bindReferences([file('图片2_场景.png'), file('图片2_人物.png'), file('随意文件.png')], '@图片1 @图片2');
  const codes = result.issues.filter(item => item.level === 'error').map(item => item.code);
  for (const code of ['MISSING_REFERENCE', 'DUPLICATE_SLOT', 'UNASSIGNED_MEDIA', 'SLOT_GAP']) assert.ok(codes.includes(code));
});

test('没有提示词中的九宫格对应说明时，不猜图片1', () => {
  const result = bindReferences([file('九宫格实景分镜.png')], '@图片1：人物');
  assert.equal(result.bindings.length, 0);
  assert.ok(result.issues.some(item => item.code === 'MISSING_REFERENCE'));
});

test('时长冲突显式报错，不把时间轴中的数字当输出时长', () => {
  const result = inferSettings('05_08秒_片段', '【整体视觉风格】\n16:9横屏，8秒，写实。\n镜头组1｜0—5秒');
  assert.equal(result.durationSeconds, 8);
  assert.equal(result.ratio, '16:9');
  assert.equal(result.issues.length, 0);
  assert.ok(inferSettings('05_08秒_片段', '【整体视觉风格】\n16:9横屏，15秒，写实。').issues.some(item => item.code === 'DURATION_CONFLICT'));
});

test('保留完整提示词，忽略未提供音色说明，完整内容哈希去重', async t => {
  const tempParent = fileURLToPath(new URL('../.tmp/', import.meta.url));
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, 'xyq-import-test-'));
  t.after(async () => {
    const resolvedRoot = path.resolve(root);
    assert.equal(path.dirname(resolvedRoot), path.resolve(tempParent));
    assert.ok(path.basename(resolvedRoot).startsWith('xyq-import-test-'));
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  });
  const original = '【整体视觉风格】\r\n16:9横屏，15秒，写实。\r\n@图片1：本段唯一整张九宫格实景分镜\r\n禁止背景音乐。\r\n';
  for (const name of ['10_15秒_十', '02_15秒_二']) {
    const shotPath = path.join(root, name);
    await fs.mkdir(path.join(shotPath, '素材'), { recursive: true });
    await fs.writeFile(path.join(shotPath, '视频提示词.txt'), '\uFEFF' + original);
    await fs.writeFile(path.join(shotPath, '素材', '九宫格实景分镜.png'), Buffer.from([1, 2, 3]));
    await fs.writeFile(path.join(shotPath, '素材', '未提供音色说明.txt'), '未提供独立音色，不冒用其他演员');
  }
  const result = await inspectEpisode(root);
  assert.deepEqual(result.shots.map(shot => shot.sequence), [2, 10]);
  assert.equal(result.shots[0].prompt, original);
  assert.equal(result.shots[0].notes.length, 0);
  assert.equal(result.summary.warningCount, 0);
  assert.ok(!result.pending.includes('处理其他文字备注采用方式'));
  assert.equal(result.summary.audioCount, 0);
  assert.equal(result.summary.uniqueMediaCount, 1);
  assert.equal(result.summary.imageCount, 2);
  assert.equal(result.summary.errorCount, 0);
  assert.equal(result.readyToSubmit, false);
});
