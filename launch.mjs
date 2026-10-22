import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createStudio } from './server.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataRoot = path.join(root, 'runtime');
const outputRoot = path.join(root, 'outputs');
const keyFile = path.join(root, 'API密钥.txt');
if (!fs.existsSync(keyFile)) {
  fs.copyFileSync(path.join(root, 'API密钥.example.txt'), keyFile, fs.constants.COPYFILE_EXCL);
}
const firstRun = !fs.existsSync(path.join(dataRoot, 'studio.sqlite'));
let studio;
try {
  // Repeated double-clicks reuse this folder's existing service; another copy uses another port.
  for (let port = 3280; port <= 3300; port++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/api/state', { signal: AbortSignal.timeout(300), redirect: 'error' });
      const data = await response.json();
      if (data.settings?.outputRoot === outputRoot) {
        const url = 'http://127.0.0.1:' + port;
        console.log('工作台已经启动：' + url);
        if (!process.argv.includes('--no-open')) execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
        process.exit(0);
      }
    } catch { /* Port not serving this copy. */ }
  }
  studio = await createStudio({ dataRoot, outputRoot, key: '', keyFile: path.join(root, 'API密钥.txt') });
  if (firstRun) studio.store.saveSettings({ concurrency: 3 });
  let url;
  for (let port = 3280; port <= 3300; port++) {
    try { url = await studio.listen(port, { seed: false }); break; }
    catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  if (!url) throw new Error('3280–3300 端口均被占用，请关闭多余的工作台后重试');
  console.log('小云雀批量工作台已启动：' + url);
  console.log('Key：本文件夹内 API密钥.txt；默认并发为 3。');
  console.log('保留此窗口；关闭窗口将停止本地队列。');
  if (!process.argv.includes('--no-open')) execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true }, () => {});
  process.on('SIGINT', () => { studio.queue.stop(); process.exit(0); });
  process.on('SIGTERM', () => { studio.queue.stop(); process.exit(0); });
} catch (error) {
  console.error('启动失败：' + error.message);
  if (studio) { studio.queue.stop(); studio.store.close(); }
  process.exitCode = 1;
}
