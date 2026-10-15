'use strict';
// 使用独立测试账号验证候选镜像的真实查询/预解析；不写数据库、不提交预约。
const fs = require('node:fs');
const { Logger } = require('/app/node_modules/@nestjs/common');
const { HttpService } = require('/app/node_modules/@nestjs/axios');
const axios = require('/app/node_modules/axios');
const { casLogin } = require('/app/dist/cas/cas-login.js');
const { HduLibraryClientService } = require('/app/dist/modules/hdu-library/hdu-library-client.service.js');
const { SeatPreparseService } = require('/app/dist/modules/grab-seat/seat-preparse.service.js');
const { CAS_SERVICE_URL } = require('/app/dist/common/constants/study-room.js');
const output = console.log;
Logger.overrideLogger(false);
console.log = () => {};
(async () => {
  const c = JSON.parse(fs.readFileSync(0, 'utf8'));
  const login = await casLogin({ username: c.username, password: c.password, serviceUrl: CAS_SERVICE_URL });
  const cookie = Object.entries(login.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const client = new HduLibraryClientService(new HttpService(axios.default.create()), { getCredentials: () => ({ type: 'cookie', value: cookie }) });
  const cache = { saveUserInfoId: async () => {}, saveSeatMappings: async () => {}, findSeatIds: async () => new Map(), getUserInfoId: async () => null };
  const service = new SeatPreparseService(client, cache);
  const start = Date.now();
  const result = await service.preparse({ id: 'release-preparse-diagnostic', accountId: 'standalone-diagnostic', categoryId: '591', contentId: '3', roomId: '1559', beginTime: Date.parse(c.beginAt) / 1000, duration: c.duration, seatPreference: ['202', '209', '207', '210'], strictMode: true });
  if (!result.entry || result.entry.unresolvedTitles.length || !result.entry.userInfoId) throw Error('preparse_unresolved');
  output(JSON.stringify({ livePreparse: 'passed', actualBookings: 0, databaseWrites: 0, elapsedMs: Date.now() - start, roomId: result.entry.roomId, seats: result.entry.seats.map(s => ({ title: s.title, seatId: s.seatId })) }));
})().catch(() => { output(JSON.stringify({ livePreparse: 'failed', actualBookings: 0 })); process.exitCode = 1; });
