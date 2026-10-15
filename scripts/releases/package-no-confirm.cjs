'use strict';
// 已验证的隔离构建目录打包；不包含 .env、认证文件、数据库或正式账号。
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const stage = path.resolve(process.argv[2]);
const worker = 'src/modules/grab-seat/grab-seat-worker.service.ts';
fs.writeFileSync(path.join(stage, 'Dockerfile.release'), [
  'FROM hdu_libseat_server-backend:rollback-20261012',
  'COPY dist/modules/grab-seat/grab-seat-worker.service.js dist/modules/grab-seat/grab-seat-worker.service.js.map /app/dist/modules/grab-seat/',
  'LABEL org.opencontainers.image.version="2026.10.12-no-confirm"',
  '',
].join('\n'));
const before = path.join(stage, 'baseline-worker.ts');
fs.writeFileSync(before, cp.execFileSync('git', ['show', 'HEAD:' + worker]));
let diff;
try { diff = cp.execFileSync('git', ['diff', '--no-index', '--no-color', before, path.join(stage, worker)], { encoding: 'utf8' }); }
catch (e) { if (e.status !== 1) throw e; diff = e.stdout; }
diff = diff.replace(/^diff --git .*$/m, `diff --git a/${worker} b/${worker}`)
  .replace(/^--- .*$/m, `--- a/${worker}`)
  .replace(/^\+\+\+ .*$/m, `+++ b/${worker}`);
fs.writeFileSync(path.join(__dirname, '20261012-no-confirm.patch'), diff);
fs.copyFileSync(path.join(__dirname, 'no-confirm-smoke.cjs'), path.join(stage, 'no-confirm-smoke.cjs'));
cp.execFileSync('tar', ['-czf', path.join(stage, 'release.tar.gz'), '-C', stage,
  'Dockerfile.release', 'no-confirm-smoke.cjs', worker,
  'dist/modules/grab-seat/grab-seat-worker.service.js',
  'dist/modules/grab-seat/grab-seat-worker.service.js.map']);
console.log(JSON.stringify({ archiveBytes: fs.statSync(path.join(stage, 'release.tar.gz')).size }));
