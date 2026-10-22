import { extractReferences, inferSettings } from './importer.mjs';

export const MODELS = [
  ['seedance2.0_vision', 'Seedance 2.0'],
  ['seedance2.0_fast_vision', 'Seedance 2.0 Fast'],
  ['Seedance_2.0_mini', 'Seedance 2.0 Mini'],
  ['Seedance_2.5', 'Seedance 2.5'],
  ['MiniMax-H3', 'MiniMax H3'],
  ['MiniMax-H3-Max', 'MiniMax H3 Max'],
  ['wan3.0', 'Wan 3.0'],
  ['happyhorse-1.1', 'HappyHorse 1.1'],
  ['Seedance_2.0_mini_lite', 'Seedance 2.0 Mini Lite'],
].map(([id, name]) => ({ id, name }));
export const RATIOS = ['16:9', '9:16', '4:3', '3:4', '1:1'];
export const RESOLUTIONS = ['480p', '720p', '1080p'];
export const ACTIVE_STATES = ['queued', 'uploading', 'submitting', 'unknown', 'generating', 'downloading', 'query_paused', 'artifact_missing', 'download_failed'];
export const IN_FLIGHT = ['uploading', 'submitting', 'generating', 'downloading'];

export function validateShot(shot) {
  const errors = (shot.importIssues || []).filter(item => item.level === 'error').map(item => item.message);
  const warnings = (shot.importIssues || []).filter(item => item.level === 'warning').map(item => item.message);
  const p = shot.parameters;
  if (!shot.prompt.trim()) errors.push('提示词不能为空');
  if (!MODELS.some(model => model.id === p.model)) errors.push('请选择模型');
  if (!RESOLUTIONS.includes(p.resolution)) errors.push('请选择分辨率');
  if (!RATIOS.includes(p.ratio)) errors.push('请选择画幅');
  if (!Number.isInteger(p.durationSeconds) || p.durationSeconds <= 0 || p.durationSeconds > 300) errors.push('时长需为 1–300 的整数；实际可用范围由模型决定');
  if (p.resolution === '1080p' && p.model !== 'seedance2.0_vision') errors.push('接入文档目前仅为 Seedance 2.0 开放 1080p');
  if (p.generateType && p.generateType !== 1) errors.push('生成模式不合法');
  const slots = new Set();
  for (const kind of ['image', 'video', 'audio']) {
    const refs = shot.references.filter(ref => ref.kind === kind).sort((a, b) => a.index - b.index);
    refs.forEach((ref, i) => {
      if (ref.index !== i + 1) errors.push('素材引用编号需要连续，不能自动压缩缺号');
      const key = `${kind}:${ref.index}`;
      if (slots.has(key)) errors.push('存在重复素材引用编号');
      slots.add(key);
      if (!ref.bytes) errors.push(`素材为空：${ref.name}`);
    });
  }
  for (const ref of extractReferences(shot.prompt)) if (!slots.has(`${ref.kind}:${ref.index}`)) errors.push(`${ref.label} 缺少对应素材`);
  if (p.generateType === 1 && shot.references.filter(ref => ref.kind === 'image').length !== 2) errors.push('首尾帧模式需要明确绑定两张图片');
  const detected = inferSettings('', shot.prompt);
  if (detected.durationSeconds && detected.durationSeconds !== p.durationSeconds) warnings.push(`提示词开头写了 ${detected.durationSeconds} 秒，与设置不同`);
  if (detected.ratio && detected.ratio !== p.ratio) warnings.push(`提示词开头写了 ${detected.ratio}，与设置不同`);
  if (shot.notes?.length) warnings.push('其他文字备注仅供查看，没有并入提示词');
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function buildPayload(snapshot, assets) {
  const byRef = new Map(assets.map(asset => [asset.refId, asset.assetId]));
  const media = {};
  const allIds = [];
  for (const [kind, field] of [['image', 'images'], ['video', 'videos'], ['audio', 'audios']]) {
    media[field] = snapshot.references.filter(ref => ref.kind === kind).sort((a, b) => a.index - b.index).map(ref => {
      const id = byRef.get(ref.id);
      if (!id) throw new Error(`素材未上传完成：${ref.name}`);
      allIds.push(id);
      return { pippit_asset_id: id };
    });
  }
  const p = snapshot.parameters;
  return {
    message: snapshot.prompt,
    agent_name: 'pippit_video_part_agent',
    asset_ids: [...new Set(allIds)],
    video_part_tool_param: {
      prompt: snapshot.prompt, model: p.model, duration_sec: p.durationSeconds,
      ratio: p.ratio, resolution: p.resolution,
      ...(p.generateType === 1 ? { generate_type: 1 } : {}), ...media,
    },
  };
}

export function sanitizeName(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_').replace(/[. ]+$/u, '').slice(0, 70) || '片段';
}
