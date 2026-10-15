'use strict';
// 在候选生产镜像内执行，所有业务依赖均替换为内存 stub，不发送真实预约。
const assert = require('node:assert/strict');
const { GrabSeatWorker, RETRY_CONFIG } = require('/app/dist/modules/grab-seat/grab-seat-worker.service.js');
const { BookErrorCode } = require('/app/dist/modules/hdu-library/errors/book-error-code.enum.js');
let requests = 0, searches = 0;
const waits = [], statuses = [];
const worker = new GrabSeatWorker(
  { searchSeats: async () => { searches++; throw Error('sync_search_forbidden'); }, bookSeats: async () => ++requests === 1 ? { success: false, errorCode: BookErrorCode.NETWORK_ERROR, errorMessage: 'timeout' } : { success: true } },
  {}, {},
  { incrementAttempts: async () => {}, isCancellationRequested: () => false, updateStatus: async (...args) => statuses.push(args), findById: async () => ({ result: {} }) },
  { log: async () => {} }, {}, {}, { notify: async () => {} },
);
worker.logger = { log() {}, warn() {}, debug() {}, error() {} };
worker.sleepInterruptible = async (ms) => { waits.push(ms); return false; };
worker.jitterMs = (ms) => ms;
const task = { id: 'smoke', accountId: 'stub', beginTime: 1800000000, duration: 50400, categoryId: '591', contentId: '3', seatPreference: ['209'], result: null };
const entry = { roomId: '1559', roomName: 'stub', userInfoId: 'stub', seats: [{ title: '209', seatId: 'stub' }], unresolvedTitles: [] };
worker.executeBlindGrab(task, entry, Date.now() + 180000, Date.now(), Date.now()).then(() => {
  assert.equal(searches, 0);
  assert.equal(requests, 2);
  assert.deepEqual(waits, [800]);
  assert.equal(statuses[0][1], 'success');
  assert.equal(RETRY_CONFIG.blindStartOffsetMs, 5000);
  assert.equal(RETRY_CONFIG.blindRateLimitBackoffMs, 1400);
  console.log(JSON.stringify({ smoke: 'passed', realRequests: 0, sourceConfirmMethodPresent: typeof worker.confirmSeatState === 'function', retryWaitMs: waits[0] }));
}).catch((e) => { console.error(e.message); process.exitCode = 1; });
