import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mediaKind } from './importer.mjs';

export const MEDIA_LIMITS = { image: 50 * 1024 ** 2, audio: 200 * 1024 ** 2, video: 500 * 1024 ** 2 };

export async function safeMediaPath(root, filename) {
  const relative = path.relative(root, filename);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('素材路径越过允许目录');
  let current = root;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('素材路径包含链接，请选择实际文件');
  }
  return filename;
}

export async function saveManagedMedia(request, { root, name, expectedKind }) {
  name = String(name || '').normalize('NFKC');
  if (!name || name.length > 240 || /[\\/\x00-\x1f]/u.test(name)) throw new Error('素材文件名不合法');
  const kind = mediaKind(name);
  if (!kind) throw new Error('请选择支持的图片、音频或视频文件');
  if (expectedKind && expectedKind !== kind) throw new Error('替换素材必须与原素材属于同一类型');
  const limit = MEDIA_LIMITS[kind];
  if (Number(request.headers['content-length']) > limit) throw new Error(`文件超过本地导入上限 ${limit / 1024 ** 2} MB`);
  await fs.mkdir(root, { recursive: true });
  await safeMediaPath(root, root);
  const id = randomUUID(), filename = path.join(root, `${id}${path.extname(name).toLowerCase()}`);
  const handle = await fs.open(filename, 'wx');
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error(`文件超过本地导入上限 ${limit / 1024 ** 2} MB`);
      hash.update(chunk); await handle.writeFile(chunk);
    }
    if (!bytes) throw new Error('不能导入空素材');
    return { id, name, kind, bytes, sha256: hash.digest('hex'), absolutePath: filename, relativePath: `本地添加/${name}`, storage: 'managed' };
  } catch (error) {
    await handle.close(); await fs.unlink(filename).catch(() => {}); throw error;
  } finally { await handle.close().catch(() => {}); }
}
