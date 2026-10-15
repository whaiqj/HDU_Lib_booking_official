'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const stage = path.resolve(process.argv[2]);
if (!fs.existsSync(path.join(stage, 'dist/main.js'))) throw new Error('built stage required');

const modules = [
  'cas/cas-login',
  'modules/grab-seat/grab-seat-worker.service',
  'modules/hdu-library/hdu-library-client.service',
  'modules/hdu-library/book-transport-trace',
  'modules/grab-task/grab-task.controller',
  'modules/grab-task/grab-task.service',
  'modules/queue/grab-seat.processor',
  'modules/session/real-auth-keeper.service',
];
const sources = modules.map((m) => `src/${m}.ts`);
const compiled = modules.flatMap((m) => [`dist/${m}.js`, `dist/${m}.js.map`]);
for (const file of [...sources, ...compiled]) {
  if (!fs.existsSync(path.join(stage, file))) throw new Error(`missing ${file}`);
}
const dockerfile = [
  'FROM hdu_libseat_server-backend:release-20261012-no-confirm',
  ...modules.map((m) => `COPY dist/${m}.js dist/${m}.js.map /app/dist/${path.posix.dirname(m)}/`),
  'LABEL org.opencontainers.image.version="2026.10.13-diagnostics"',
  '',
].join('\n');
fs.writeFileSync(path.join(stage, 'Dockerfile.release'), dockerfile);
fs.copyFileSync(path.join(__dirname, 'diagnostics-smoke.cjs'), path.join(stage, 'diagnostics-smoke.cjs'));
const archive = path.join(stage, 'diagnostics-release.tar.gz');
cp.execFileSync('tar', ['-czf', archive, '-C', stage,
  'Dockerfile.release', 'diagnostics-smoke.cjs', ...sources, ...compiled]);
console.log(JSON.stringify({ archive, bytes: fs.statSync(archive).size, modules }));
