const names = { image: '图片', video: '视频', audio: '音频' };
const kinds = { 图片: 'image', 视频: 'video', 音频: 'audio' };

export function referenceTokens(prompt) {
  return [...String(prompt).matchAll(/[@＠](图片|视频|音频)\s*([0-9０-９]+)/gu)].map(match => ({
    text: match[0], start: match.index, end: match.index + match[0].length,
    kind: kinds[match[1]], index: Number(match[2].normalize('NFKC')),
  }));
}

export function numberReferences(refs) {
  const counts = { image: 0, video: 0, audio: 0 };
  return refs.map(ref => { const index = ++counts[ref.kind]; return { ...ref, index, label: `@${names[ref.kind]}${index}` }; });
}

export function referenceChange(before, after, prompt) {
  const refs = numberReferences(after);
  const tokens = referenceTokens(prompt);
  const mappings = before.map(old => {
    const next = refs.find(ref => ref.id === old.id) || refs.find(ref => ref.kind === old.kind && ref.replacesIds?.includes(old.id));
    return { id: old.id, name: old.name, kind: old.kind, oldLabel: `@${names[old.kind]}${old.index}`, oldIndex: old.index,
      newIndex: next?.index ?? null, newLabel: next?.label ?? null,
      referenced: tokens.some(token => token.kind === old.kind && token.index === old.index) };
  });
  const changed = mappings.filter(item => item.referenced && item.oldIndex !== item.newIndex);
  const removed = changed.filter(item => item.newIndex === null);
  // Replace all tokens in one pass so swaps (1 ↔ 2) cannot cascade.
  let syncedPrompt = '', cursor = 0;
  for (const token of tokens) {
    const mapping = mappings.find(item => item.kind === token.kind && item.oldIndex === token.index);
    syncedPrompt += prompt.slice(cursor, token.start) + (mapping?.newLabel || token.text);
    cursor = token.end;
  }
  syncedPrompt += prompt.slice(cursor);
  return { references: refs, changed, removed, canSync: !removed.length, syncedPrompt };
}
