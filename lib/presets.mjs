import { MODELS, RATIOS, RESOLUTIONS } from './catalog.mjs';

export function presetParameters(input) {
  const model = String(input.model || ''), resolution = String(input.resolution || ''), ratio = String(input.ratio || '');
  const concurrency = Number(input.concurrency);
  const durationSeconds = input.durationSeconds === null || input.durationSeconds === '' || input.durationSeconds === undefined ? null : Number(input.durationSeconds);
  if (!MODELS.some(item => item.id === model)) throw new Error('模板请选择有效模型');
  if (!RESOLUTIONS.includes(resolution) || !RATIOS.includes(ratio)) throw new Error('模板请选择分辨率和画幅');
  if (resolution === '1080p' && model !== 'seedance2.0_vision') throw new Error('当前仅 Seedance 2.0 支持 1080p');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('模板并发数需为 1–4');
  if (durationSeconds !== null && (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 300)) throw new Error('模板时长需为 1–300 的整数或留空保留各段时长');
  return { model, resolution, ratio, concurrency, durationSeconds };
}
