import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = process.cwd();
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');
const ASSETS_DIR = path.join(DIST_DIR, 'assets');

const runBuild = () => {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'npm';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm run build'] : ['run', 'build'];
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
  });
  return result.status === 0;
};

const listChunks = () => {
  if (!fs.existsSync(ASSETS_DIR)) return [];
  return fs
    .readdirSync(ASSETS_DIR)
    .filter((file) => file.endsWith('.js') || file.endsWith('.css'))
    .map((file) => {
      const fullPath = path.join(ASSETS_DIR, file);
      return {
        file: `dist/assets/${file}`,
        bytes: fs.statSync(fullPath).size,
        kb: Number((fs.statSync(fullPath).size / 1024).toFixed(1)),
      };
    })
    .sort((left, right) => right.bytes - left.bytes);
};

const main = () => {
  const buildOk = runBuild();
  const report = {
    generatedAt: new Date().toISOString(),
    buildOk,
    indexHtmlExists: fs.existsSync(INDEX_HTML),
    assetsDirExists: fs.existsSync(ASSETS_DIR),
    chunks: listChunks(),
  };

  console.log(JSON.stringify(report, null, 2));

  if (!report.buildOk || !report.indexHtmlExists || !report.assetsDirExists || !report.chunks.some((chunk) => chunk.file.endsWith('.js'))) {
    process.exitCode = 1;
  }
};

main();
