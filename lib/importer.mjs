import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const kinds = {
  image: new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']),
  audio: new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg']),
  video: new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']),
};
const labels = { image: '图片', audio: '音频', video: '视频' };
const fromLabel = { 图片: 'image', 音频: 'audio', 视频: 'video' };
const promptNames = new Set(['视频提示词.txt', '提示词.txt', 'prompt.txt']);
const ignoredFileNames = new Set(['未提供音色说明.txt']);
const collator = new Intl.Collator('zh-CN', { numeric: true });
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function issue(level, code, message, file) {
  return { level, code, message, ...(file ? { file } : {}) };
}

function canonicalName(name) {
  return name.normalize('NFKC');
}

export function mediaKind(name) {
  const extension = path.extname(name).toLowerCase();
  return Object.entries(kinds).find(([, extensions]) => extensions.has(extension))?.[0] ?? null;
}

export function extractReferences(prompt) {
  const result = new Map();
  for (const match of canonicalName(prompt).matchAll(/@(图片|音频|视频)\s*(\d+)/gu)) {
    const kind = fromLabel[match[1]];
    const index = Number(match[2]);
    result.set(`${kind}:${index}`, { kind, index, label: `@${labels[kind]}${index}` });
  }
  return [...result.values()];
}

function explicitSlot(name, kind) {
  const stem = canonicalName(path.parse(name).name);
  const match = stem.match(/^(图片|音频|视频)\s*(\d+)(?=$|[_\s.\-])/u);
  if (!match) return null;
  return { kind: fromLabel[match[1]], index: Number(match[2]), validKind: fromLabel[match[1]] === kind };
}

export function bindReferences(files, prompt) {
  const references = extractReferences(prompt);
  const issues = [];
  const slots = new Map();
  const unassigned = [];
  for (const file of files) {
    const slot = explicitSlot(file.name, file.kind);
    if (!slot) { unassigned.push(file); continue; }
    if (!slot.validKind || slot.index < 1 || !Number.isSafeInteger(slot.index)) {
      issues.push(issue('error', 'INVALID_SLOT', `素材编号或类型不合法：${file.name}`, file.relativePath));
      continue;
    }
    const key = `${file.kind}:${slot.index}`;
    if (slots.has(key)) {
      issues.push(issue('error', 'DUPLICATE_SLOT', `${labels[file.kind]}${slot.index} 对应多个文件`, file.relativePath));
      continue;
    }
    slots.set(key, { ...file, index: slot.index, label: `@${labels[file.kind]}${slot.index}`, bindingRule: 'filename' });
  }

  // A bounded rule for this creator's convention; never use generic alphabetical order.
  const storyboards = unassigned.filter(file => file.kind === 'image'
    && /^九宫格(?:实景)?分镜$/u.test(canonicalName(path.parse(file.name).name)));
  const storyboardMentioned = /@图片\s*1\s*[:：][^\r\n]*九宫格/u.test(canonicalName(prompt));
  if (storyboardMentioned && storyboards.length === 1 && !slots.has('image:1')) {
    const file = storyboards[0];
    slots.set('image:1', { ...file, index: 1, label: '@图片1', bindingRule: 'storyboard-image-1' });
    unassigned.splice(unassigned.indexOf(file), 1);
  }
  for (const file of unassigned) {
    issues.push(issue('error', 'UNASSIGNED_MEDIA', `无法确定素材编号，请手动绑定：${file.name}`, file.relativePath));
  }
  for (const reference of references) {
    if (!slots.has(`${reference.kind}:${reference.index}`)) {
      issues.push(issue('error', 'MISSING_REFERENCE', `提示词引用 ${reference.label}，但没有对应文件`));
    }
  }
  for (const kind of Object.keys(kinds)) {
    const bindings = [...slots.values()].filter(file => file.kind === kind).sort((a, b) => a.index - b.index);
    bindings.forEach((file, index) => {
      if (file.index !== index + 1) {
        issues.push(issue('error', 'SLOT_GAP', `${labels[kind]}编号不连续，不能压缩数组后提交`));
      }
      if (!references.some(reference => reference.kind === kind && reference.index === file.index)) {
        issues.push(issue('warning', 'UNREFERENCED_MEDIA', `${file.label} 已绑定，但提示词未明确引用`, file.relativePath));
      }
    });
  }
  return {
    references,
    bindings: [...slots.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.index - b.index),
    issues,
  };
}

export function inferSettings(folder, prompt) {
  const normalizedFolder = canonicalName(folder);
  const opening = canonicalName(prompt).replace(/^\uFEFF/u, '').trimStart().slice(0, 500).split(/[\r\n]/u).filter(Boolean).slice(0, 2).join('\n');
  const folderDuration = normalizedFolder.match(/(?:^|[_\s-])(\d+)秒(?=$|[_\s-])/u)?.[1];
  const promptDuration = opening.match(/(?:^|[，,\s])(\d+)秒(?:[，,。\s]|$)/u)?.[1];
  const ratio = opening.match(/(?:^|\D)(16\s*:\s*9|9\s*:\s*16|4\s*:\s*3|3\s*:\s*4|1\s*:\s*1)(?=\D|$)/u)?.[1]?.replace(/\s/gu, '') ?? null;
  const issues = [];
  if (folderDuration && promptDuration && Number(folderDuration) !== Number(promptDuration)) {
    issues.push(issue('error', 'DURATION_CONFLICT', `目录时长 ${Number(folderDuration)} 秒与提示词 ${Number(promptDuration)} 秒不一致`));
  }
  const durationSeconds = Number(folderDuration ?? promptDuration) || null;
  if (!durationSeconds) issues.push(issue('error', 'DURATION_MISSING', '无法识别片段时长，需要手动设置'));
  if (!ratio) issues.push(issue('warning', 'RATIO_MISSING', '未从提示词开头识别画幅，需要手动设置'));
  return { durationSeconds, ratio, model: null, resolution: null, issues };
}

async function readText(file, issues) {
  try {
    return textDecoder.decode(await fs.readFile(file));
  } catch (error) {
    issues.push(issue('error', 'TEXT_READ_ERROR', `无法以 UTF-8 读取文本：${path.basename(file)}`, file));
    return '';
  }
}

async function walkFiles(root, current, issues) {
  const results = [];
  const entries = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => collator.compare(a.name, b.name));
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isFile() && ignoredFileNames.has(canonicalName(entry.name))) continue;
    if (entry.isSymbolicLink()) {
      issues.push(issue('error', 'LINK_NOT_IMPORTED', `未导入链接：${path.relative(root, absolutePath)}`, absolutePath));
      continue;
    }
    if (entry.isDirectory()) results.push(...await walkFiles(root, absolutePath, issues));
    else if (entry.isFile()) results.push({ name: entry.name, absolutePath, relativePath: path.relative(root, absolutePath).split(path.sep).join('/') });
  }
  return results;
}

export async function inspectEpisode(inputPath) {
  const root = path.resolve(inputPath);
  const rootInfo = await fs.lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error('请选择实际素材目录，不要选择链接目录');
  if (!rootInfo.isDirectory()) throw new Error('请选择包含镜头子目录的文件夹');
  const issues = [];
  const shots = [];
  const topLevel = (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => collator.compare(a.name, b.name));
  for (const entry of topLevel) {
    if (entry.isSymbolicLink()) {
      issues.push(issue('error', 'LINK_NOT_IMPORTED', `未导入顶层链接：${entry.name}`));
      continue;
    }
    if (!entry.isDirectory()) continue;
    const sequenceMatch = canonicalName(entry.name).match(/^(\d+)(?=$|[_\s-])/u);
    if (!sequenceMatch) {
      issues.push(issue('warning', 'NON_SHOT_DIRECTORY', `未自动加入非编号目录：${entry.name}`));
      continue;
    }
    const sequence = Number(sequenceMatch[1]);
    const shotIssues = [];
    const files = await walkFiles(root, path.join(root, entry.name), shotIssues);
    const prompts = files.filter(file => promptNames.has(file.name.toLowerCase()) && path.dirname(file.absolutePath) === path.join(root, entry.name));
    if (prompts.length !== 1) shotIssues.push(issue('error', 'PROMPT_COUNT', `需要一个明确的提示词文件，当前找到 ${prompts.length} 个`));
    const prompt = prompts.length === 1 ? await readText(prompts[0].absolutePath, shotIssues) : '';
    if (!prompt.trim()) shotIssues.push(issue('error', 'EMPTY_PROMPT', '提示词为空或无法读取'));
    const media = [];
    const notes = [];
    for (const file of files) {
      if (prompts.includes(file)) continue;
      const kind = mediaKind(file.name);
      if (kind) {
        try {
          const stat = await fs.stat(file.absolutePath);
          const hash = createHash('sha256');
          for await (const chunk of createReadStream(file.absolutePath)) hash.update(chunk);
          if (!stat.size) shotIssues.push(issue('error', 'EMPTY_MEDIA', `素材为空：${file.name}`, file.relativePath));
          media.push({ ...file, kind, bytes: stat.size, sha256: hash.digest('hex') });
        } catch {
          shotIssues.push(issue('error', 'MEDIA_READ_ERROR', `无法读取素材：${file.name}`, file.relativePath));
        }
      } else if (path.extname(file.name).toLowerCase() === '.txt') {
        notes.push({ ...file, text: await readText(file.absolutePath, shotIssues), includedInPrompt: false });
      } else {
        shotIssues.push(issue('warning', 'IGNORED_FILE', `未导入未知类型文件：${file.name}`, file.relativePath));
      }
    }
    const binding = bindReferences(media, prompt);
    const settings = inferSettings(entry.name, prompt);
    shotIssues.push(...binding.issues, ...settings.issues);
    if (notes.length) shotIssues.push(issue('warning', 'NOTES_NOT_INCLUDED', `${notes.length} 份文字备注未并入提示词，请检查是否需要采用`));
    const { issues: settingsIssues, ...parameters } = settings;
    shots.push({ sequence, name: entry.name, promptFile: prompts.length === 1 ? prompts[0].relativePath : null, prompt, parameters, mediaFiles: media, references: binding.bindings, promptReferences: binding.references, notes, issues: shotIssues });
  }
  shots.sort((a, b) => a.sequence - b.sequence || collator.compare(a.name, b.name));
  const sequences = new Set();
  for (const shot of shots) {
    if (!Number.isSafeInteger(shot.sequence) || shot.sequence < 1 || sequences.has(shot.sequence)) {
      issues.push(issue('error', 'INVALID_SHOT_SEQUENCE', `重复或不合法的片段编号：${shot.name}`));
    }
    sequences.add(shot.sequence);
  }
  if (!shots.length) issues.push(issue('error', 'NO_SHOTS', '没有找到以编号开头的片段目录'));
  const allIssues = [...issues, ...shots.flatMap(shot => shot.issues)];
  const references = shots.flatMap(shot => shot.references);
  const unique = new Map(references.map(file => [file.sha256, file]));
  const errorCount = allIssues.filter(item => item.level === 'error').length;
  return {
    schemaVersion: 1,
    inspectedAt: new Date().toISOString(),
    sourcePath: root,
    name: path.basename(root),
    status: errorCount ? 'needs-correction' : 'ready-for-parameter-selection',
    readyToSubmit: false,
    importRules: { ignoredFileNames: [...ignoredFileNames] },
    pending: ['选择模型和分辨率', '核对模型能力和账号权限', ...(shots.some(shot => shot.notes.length) ? ['处理其他文字备注采用方式'] : []), '联调确认 API 素材引用规则'],
    summary: {
      shotCount: shots.length,
      totalDurationSeconds: shots.reduce((sum, shot) => sum + (shot.parameters.durationSeconds || 0), 0),
      imageCount: references.filter(file => file.kind === 'image').length,
      audioCount: references.filter(file => file.kind === 'audio').length,
      videoCount: references.filter(file => file.kind === 'video').length,
      uniqueMediaCount: unique.size,
      totalMediaBytes: references.reduce((sum, file) => sum + file.bytes, 0),
      uniqueMediaBytes: [...unique.values()].reduce((sum, file) => sum + file.bytes, 0),
      errorCount,
      warningCount: allIssues.filter(item => item.level === 'warning').length,
    },
    issues,
    shots,
  };
}

export function renderReport(project) {
  const lines = [
    '# 样本目录导入预检', '',
    `源目录：${project.sourcePath}`, '',
    '本报告仅检查本地文件；没有上传素材，没有调用生成接口。', '',
    '按用户要求完全忽略“未提供音色说明.txt”：不读取正文、不上传、不并入提示词、不生成提醒。', '',
    `共 ${project.summary.shotCount} 个片段，${project.summary.totalDurationSeconds} 秒；图片引用 ${project.summary.imageCount} 处，音频引用 ${project.summary.audioCount} 处，视频引用 ${project.summary.videoCount} 处。`, '',
    `按完整 SHA-256 去重后共 ${project.summary.uniqueMediaCount} 份媒体。文件内容去重可供后续上传缓存使用，不改变任何片段的引用编号。`, '',
    `结构错误 ${project.summary.errorCount} 个，待检查提醒 ${project.summary.warningCount} 个。尚未设置模型和分辨率，不能直接提交。`, '',
    '| 片段 | 时长 | 画幅 | 图片 | 音频 |', '| --- | --- | --- | --- | --- |',
    ...project.shots.map(shot => `| ${shot.name} | ${shot.parameters.durationSeconds ?? '未识别'} 秒 | ${shot.parameters.ratio ?? '未识别'} | ${shot.references.filter(file => file.kind === 'image').length} | ${shot.references.filter(file => file.kind === 'audio').length} |`), '',
    '## 逐片段绑定', '',
  ];
  for (const shot of project.shots) {
    lines.push(`### ${shot.name}`, '', `提示词：${shot.promptFile ?? '无法确定'}；${shot.prompt.length} 字符（仅去除 UTF-8 BOM，不改写正文）。`, '');
    for (const reference of [...shot.references].sort((a, b) => Object.keys(kinds).indexOf(a.kind) - Object.keys(kinds).indexOf(b.kind) || a.index - b.index)) {
      lines.push(`- ${reference.label} → ${reference.relativePath}${reference.bindingRule === 'storyboard-image-1' ? '（九宫格分镜规则）' : ''}`);
    }
    lines.push('');
    for (const note of shot.notes) lines.push(`文字备注：${note.relativePath}（单独保存，未合入提示词）`, '', '> ' + note.text.trim().replace(/\r?\n/gu, '\n> '), '');
    for (const item of shot.issues) lines.push(`- ${item.level === 'error' ? '错误' : '提醒'}：${item.message}`);
    lines.push('');
  }
  if (project.issues.length) lines.push('## 项目提醒', '', ...project.issues.map(item => `- ${item.message}`), '');
  lines.push('## 尚未验证', '', '本地检查不证明 API 接受这些素材、时长或引用语法。模型、分辨率、账号权限和媒体上限需要按实际接口验证。文字备注默认不上传、不改写成音频；是否作为补充提示词采用，应在导入界面明确选择。', '');
  return lines.join('\n');
}
