import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceSkip = new Set(['.git', '.tmp', 'node_modules', 'dist', 'runtime', 'outputs', 'reports', 'bin']);
const sourceBinaryExtensions = new Set(['.exe', '.dll', '.sqlite', '.db', '.png', '.jpg', '.jpeg', '.mp3', '.wav', '.mp4', '.zip', '.pfx', '.pem', '.key']);
const patterns = [
  ['credential-token', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,})/gu],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu],
  ['literal-bearer', /Bearer\s+[A-Za-z0-9_.-]{28,}/gu],
  ['personal-windows-path', /[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.~-]+[\\/]/gu],
  ['local-workspace-path', /[A-Za-z]:[\\/]+minimax(?:[\\/]|\b)/giu],
];

export function textFindings(text) {
  const findings = [];
  for (const [rule, expression] of patterns) {
    expression.lastIndex = 0;
    if (expression.test(text)) findings.push(rule);
  }
  const emails = text.match(/[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu) || [];
  if (emails.some(email => !email.endsWith('@users.noreply.github.com') && !email.endsWith('@example.com') && !email.endsWith('@example.invalid'))) findings.push('non-example-email');
  return [...new Set(findings)];
}

async function walk(root, relative = '', skip = new Set()) {
  const results = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const name = path.posix.join(relative.split(path.sep).join('/'), entry.name);
    if (entry.isSymbolicLink()) throw new Error(`不允许发布链接：${name}`);
    if (entry.isDirectory()) results.push(...await walk(root, name, skip));
    else results.push(name);
  }
  return results;
}

export async function auditDirectory(root, { portable = false, tracked = true } = {}) {
  let files;
  if (!portable && tracked) {
    try {
      files = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
    } catch { /* A fresh directory can be audited before git init. */ }
  }
  if (!files?.length) files = await walk(root, '', portable ? new Set() : sourceSkip);
  const findings = [];
  for (const name of files) {
    const normalized = name.replaceAll('\\', '/');
    const basename = path.posix.basename(normalized);
    const parts = normalized.split('/');
    const extension = path.extname(name).toLowerCase();
    if (parts.some(part => ['runtime', 'outputs', 'reports', '.tmp', 'node_modules', '.git'].includes(part))) findings.push({ file: normalized, rule: 'private-data-directory' });
    if (/\.(?:sqlite(?:-.*)?|db|log|pem|pfx|p12|key)$/iu.test(basename) || (basename.startsWith('.env') && basename !== '.env.example')) findings.push({ file: normalized, rule: 'private-data-file' });
    if (basename === 'API密钥.txt') {
      if (!portable) findings.push({ file: normalized, rule: 'real-key-filename' });
      else {
        const content = await fs.readFile(path.join(root, name), 'utf8');
        if (content.replace(/^\uFEFF/u, '').split(/\r?\n/u).some(line => line.trim() && !line.trim().startsWith('#'))) findings.push({ file: normalized, rule: 'nonempty-key-file' });
      }
      continue;
    }
    if (!portable && sourceBinaryExtensions.has(extension)) { findings.push({ file: normalized, rule: 'binary-not-allowed-in-source' }); continue; }
    if (portable && extension === '.exe') {
      if (normalized !== 'bin/node.exe') findings.push({ file: normalized, rule: 'unexpected-executable' });
      continue;
    }
    const data = await fs.readFile(path.join(root, name));
    if (data.includes(0)) { findings.push({ file: normalized, rule: 'unexpected-binary' }); continue; }
    for (const rule of textFindings(data.toString('utf8'))) {
      // Preserve upstream author notices in the unmodified Node.js license.
      if (portable && normalized === 'bin/Node-LICENSE.txt' && rule === 'non-example-email') continue;
      findings.push({ file: normalized, rule });
    }
  }
  return { fileCount: files.length, findings };
}

export function auditHistory(root) {
  const findings = [];
  try {
    const authors = execFileSync('git', ['log', '--all', '--format=%an <%ae>'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const rule of textFindings(authors)) findings.push({ file: '(git authors)', rule });
    const objects = execFileSync('git', ['rev-list', '--objects', '--all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    for (const line of objects) {
      const match = line.match(/^([a-f0-9]+) (.+)$/u);
      if (!match) continue;
      const [, sha, name] = match;
      const type = execFileSync('git', ['cat-file', '-t', sha], { cwd: root, encoding: 'utf8' }).trim();
      if (type !== 'blob') continue;
      if (name.split('/').some(part => ['runtime', 'outputs', 'reports', '.tmp'].includes(part)) || path.posix.basename(name) === 'API密钥.txt') findings.push({ file: name, rule: 'private-file-in-history' });
      const content = execFileSync('git', ['cat-file', 'blob', sha], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
      if (content.includes(0)) findings.push({ file: name, rule: 'binary-in-history' });
      else for (const rule of textFindings(content.toString('utf8'))) findings.push({ file: name, rule: `history-${rule}` });
    }
  } catch (error) {
    if (error.status && !findings.length) return [];
    throw error;
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const portableIndex = process.argv.indexOf('--portable');
  const root = portableIndex >= 0 ? path.resolve(process.argv[portableIndex + 1]) : projectRoot;
  try {
    const result = await auditDirectory(root, { portable: portableIndex >= 0 });
    if (portableIndex < 0) result.findings.push(...auditHistory(root));
    console.log(JSON.stringify({ scannedFiles: result.fileCount, passed: result.findings.length === 0, findings: result.findings }, null, 2));
    if (result.findings.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
