import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectEpisode, renderReport } from './lib/importer.mjs';

const args = process.argv.slice(2);
const sourcePath = args[0];
const outputIndex = args.indexOf('--output');
if (!sourcePath || (outputIndex >= 0 && !args[outputIndex + 1])) {
  console.error('用法：node inspect.mjs "整集目录" [--output "报告输出目录"]');
  process.exitCode = 1;
} else {
  try {
    const project = await inspectEpisode(sourcePath);
    if (outputIndex >= 0) {
      const outputPath = path.resolve(args[outputIndex + 1]);
      const relative = path.relative(project.sourcePath, outputPath);
      if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('请将报告写入源素材目录之外，保持源素材只读');
      }
      await fs.mkdir(outputPath, { recursive: true });
      // Exclusive creation prevents accidentally replacing an earlier inspection.
      await fs.writeFile(path.join(outputPath, 'project.json'), JSON.stringify(project, null, 2), { encoding: 'utf8', flag: 'wx' });
      await fs.writeFile(path.join(outputPath, '预检报告.md'), renderReport(project), { encoding: 'utf8', flag: 'wx' });
      console.log(JSON.stringify({ outputPath, status: project.status, summary: project.summary }, null, 2));
    } else console.log(JSON.stringify(project, null, 2));
    if (project.summary.errorCount) process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
