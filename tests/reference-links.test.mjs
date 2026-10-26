import assert from 'node:assert/strict';
import test from 'node:test';
import { referenceChange, referenceTokens } from '../public/reference-links.js';
const refs = [{ id: 'a', kind: 'image', name: '甲.png', index: 1 }, { id: 'b', kind: 'image', name: '乙.png', index: 2 }, { id: 's', kind: 'audio', name: '音色.wav', index: 1 }];

test('引用交换同时改写，保留完整正文和独立音频编号，支持全角引用', () => {
  const prompt = '原文\r\n@图片1：甲；@图片2：乙；@音频1\n＠图片１ 仍是甲 @图片10 缺失';
  const result = referenceChange(refs, [refs[1], refs[0], refs[2]], prompt);
  assert.equal(result.syncedPrompt, '原文\r\n@图片2：甲；@图片1：乙；@音频1\n@图片2 仍是甲 @图片10 缺失');
  assert.equal(result.changed.length, 2); assert.equal(result.canSync, true);
  assert.deepEqual(referenceTokens('x＠音频３y').map(token => [token.kind, token.index, token.start, token.end]), [['audio', 3, 1, 5]]);
});

test('被移除且仍被使用的素材禁止自动同步，替换与恢复按素材身份追踪', () => {
  assert.equal(referenceChange(refs, [refs[1]], '@图片1 甲 @图片2 乙').canSync, false);
  const replacement = { id: 'new-a', kind: 'image', replacesIds: ['a'], name: '新版甲.png' };
  assert.equal(referenceChange(refs, [replacement, refs[1], refs[2]], '@图片1 @图片2').changed.length, 0);
  assert.equal(referenceChange(refs, [replacement, refs[1], refs[0]], '@图片1').syncedPrompt, '@图片3');
  assert.equal(referenceChange(refs, refs, '@图片1 @图片2').changed.length, 0);
});
