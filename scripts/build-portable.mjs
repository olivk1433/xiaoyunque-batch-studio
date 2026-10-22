import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { auditDirectory } from './privacy-audit.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtimeIndex = process.argv.indexOf('--runtime-dir');
const runtimeRoot = runtimeIndex >= 0 && process.argv[runtimeIndex + 1] ? path.resolve(process.argv[runtimeIndex + 1]) : null;
if (!runtimeRoot) throw new Error('请通过 --runtime-dir 指定官方 Windows x64 Node.js 解压目录，包含 node.exe 和 LICENSE');
const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(metadata.version)) throw new Error('版本号不合法');
const name = `xiaoyunque-batch-studio-v${metadata.version}-windows-x64`;
const destination = path.join(root, 'dist', name);
const sourceAudit = await auditDirectory(root);
if (sourceAudit.findings.length) throw new Error('源码隐私检查未通过，请先运行 npm run audit:privacy');
try { await fs.access(destination); throw new Error('构建目录已存在，请保留旧包并使用新的版本号构建'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const runtime = await fs.readFile(path.join(runtimeRoot, 'node.exe'));
if (runtime.subarray(0, 2).toString() !== 'MZ') throw new Error('运行环境不是 Windows 可执行文件');
const pe = runtime.readUInt32LE(0x3c);
if (runtime.readUInt16LE(pe + 4) !== 0x8664) throw new Error('运行环境必须为 Windows x64');
let license;
for (const filename of ['LICENSE', 'Node-LICENSE.txt']) {
  try { license = await fs.readFile(path.join(runtimeRoot, filename), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!license?.includes('Node.js')) throw new Error('缺少 Node.js 完整许可证，停止打包');
await fs.mkdir(path.join(destination, 'bin'), { recursive: true });
for (const directory of ['lib', 'public']) await fs.cp(path.join(root, directory), path.join(destination, directory), { recursive: true });
for (const filename of ['server.mjs', 'launch.mjs', 'package.json', '启动工作台.cmd', 'API密钥.example.txt', 'README.md', 'LICENSE', 'SECURITY.md']) await fs.copyFile(path.join(root, filename), path.join(destination, filename));
await fs.copyFile(path.join(root, 'API密钥.example.txt'), path.join(destination, 'API密钥.txt'));
await fs.writeFile(path.join(destination, 'bin', 'node.exe'), runtime);
await fs.writeFile(path.join(destination, 'bin', 'Node-LICENSE.txt'), license, 'utf8');
await fs.writeFile(path.join(destination, '使用说明.txt'), '1. 完整解压文件夹到可写位置。\r\n2. 在 API密钥.txt 填写自己的小云雀 Key 并保存。\r\n3. 双击 启动工作台.cmd，保留后台窗口。\r\n4. 导入自己的整集素材目录，先选一个片段试跑。\r\n\r\n内置 Node.js，无需安装依赖。适用于 Windows 10/11 x64。\r\n默认并发 3。目录内没有任何真实密钥、项目或媒体。\r\n详细使用说明见 README.md。再次转发前请移除自己的 Key 和数据。\r\n', 'utf8');
await fs.writeFile(path.join(destination, '第三方组件说明.txt'), '包含未经修改的 Node.js Windows x64 运行环境。\r\n官网：https://nodejs.org/\r\n完整许可证：bin/Node-LICENSE.txt\r\n', 'utf8');
const files = [];
async function collect(current) {
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) await collect(file);
    else files.push({ file: path.relative(destination, file).split(path.sep).join('/'), sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') });
  }
}
await collect(destination);
await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ name: metadata.name, version: metadata.version, platform: 'windows-x64', defaultConcurrency: 3, files }, null, 2));
const finalAudit = await auditDirectory(destination, { portable: true });
if (finalAudit.findings.length) throw new Error('便携包隐私检查失败，禁止发布');
console.log(JSON.stringify({ directory: path.relative(root, destination).split(path.sep).join('/'), fileCount: finalAudit.fileCount, privacyPassed: true }, null, 2));
