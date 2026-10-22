import { readFileSync } from 'node:fs';

export function parseKeyText(value) {
  const lines = String(value).replace(/^\uFEFF/u, '').split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!lines.length) return '';
  if (lines.length !== 1) throw new Error('API密钥.txt 只需填写一行 Key，其余说明请以 # 开头');
  let key = lines[0].replace(/^(?:XIAOYUNQUE_API_KEY|API_KEY)\s*=\s*/iu, '').replace(/^Bearer\s+/iu, '').trim();
  if (!key || /\s/u.test(key) || key.length > 4096 || /^['"]/u.test(key) || /['"]$/u.test(key)) throw new Error('API密钥.txt 格式不正确，请只填写 Key 本身，不加引号');
  return key;
}

export function createKeyConfig({ filePath = null, fallbackKey = '' } = {}) {
  let temporaryKey = null;
  let suppressed = false;
  function current() {
    if (suppressed) return { key: '', source: 'disabled', error: null };
    if (temporaryKey !== null) return { key: temporaryKey, source: 'session', error: null };
    if (filePath) {
      try {
        const buffer = readFileSync(filePath);
        if (buffer.length > 16 * 1024) throw new Error('API密钥.txt 内容过长，请只保留说明和一行 Key');
        const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le' : 'utf-8';
        const key = parseKeyText(new TextDecoder(encoding, { fatal: true }).decode(buffer));
        if (key) return { key, source: 'file', error: null };
      } catch (error) {
        if (error.code !== 'ENOENT') return { key: '', source: 'file-error', error: error.code ? '无法读取 API密钥.txt，请检查文件访问权限' : error.message.includes('API密钥.txt') ? error.message : 'API密钥.txt 编码不正确，请保存为 UTF-8 文本' };
      }
    }
    return { key: fallbackKey, source: fallbackKey ? 'environment' : 'none', error: null };
  }
  return {
    getKey() { return current().key; },
    status() { const { source, error } = current(); return { source, error, filePath }; },
    setTemporary(key) { temporaryKey = key; suppressed = false; },
    disable() { temporaryKey = null; suppressed = true; },
    useFile() { temporaryKey = null; suppressed = false; },
  };
}
