'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { from } = require('/app/node_modules/rxjs');
const axios = require('/app/node_modules/axios');
const { HduLibraryClientService } = require('/app/dist/modules/hdu-library/hdu-library-client.service');
const { GrabSeatWorker } = require('/app/dist/modules/grab-seat/grab-seat-worker.service');
const { SeatPreparseService } = require('/app/dist/modules/grab-seat/seat-preparse.service');
const { createBookTransportTrace, bookTimeoutStage } = require('/app/dist/modules/hdu-library/book-transport-trace');

(async () => {
  let localRequests = 0;
  const server = http.createServer((req, res) => {
    localRequests++;
    if (req.url === '/slow') {
      setTimeout(() => res.end('late'), 150);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"DATA":{"result":"success"}}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const events = [];
    const client = new HduLibraryClientService(
      { post: (url, body, config) => from(axios.post(url, body, { ...config, maxRedirects: 0 })) },
      { getCredentials: () => ({ value: 'mock=1' }) },
    );
    client.baseUrl = `http://127.0.0.1:${server.address().port}`;
    client.logger = { log: line => events.push(JSON.parse(line)), debug() {}, warn() {} };
    client.bookRttWindow.push(12000, 14000);
    assert.equal((await client.bookSeats({ beginTime: 1792108800, duration: 50400, seats: ['63105'], is_recommend: 0, api_time: 1791979203, seatBookers: ['mock'] }, 'first', 'mock')).success, true);
    assert.equal(events[0].timeoutMs, 8000);
    assert.ok(events[0].requestFinishedMs >= 0);
    assert.equal(events[0].httpStatus, 200);
    const preparse = new SeatPreparseService(
      { searchSeats: async () => ({ room: { id: '1559', name: 'mock' }, seats: [{ id: '63105', title: '209' }], recommendedSeats: [] }) },
      { getUserInfoId: async () => 'cached-user', saveSeatMappings: async () => {} },
    );
    const task = { id: 'mock', accountId: 'first', roomId: '1559', categoryId: '591', contentId: '3', seatPreference: ['209'], strictMode: true, triggerAt: Math.floor(Date.now() / 1000) + 60, beginTime: 1792108800, duration: 50400 };
    const entry = (await preparse.preparse(task)).entry;
    assert.equal(entry.userInfoId, 'cached-user');
    assert.deepEqual(entry.seats, [{ title: '209', seatId: '63105' }]);
    const plans = [];
    const worker = new GrabSeatWorker({}, {}, { get: () => entry, invalidate() {} }, { updateStatus: async () => {} }, {}, {}, {}, { notify: async () => {} });
    worker.logger = { log() {}, warn() {}, debug() {}, error() {} };
    worker.executeBlindGrab = async (_task, _entry, _deadline, _start, firstFire) => plans.push(firstFire - task.triggerAt * 1000);
    process.env.GRAB_FIRST_FIRE_ACCOUNT_IDS = 'first,second';
    await worker.executeGrab(task);
    await worker.executeGrab({ ...task, accountId: 'second' });
    assert.deepEqual(plans, [3000, 3100]);
    const slow = createBookTransportTrace();
    await assert.rejects(axios.post(client.baseUrl + '/slow', '', { timeout: 70, transport: slow.transport, maxRedirects: 0 }));
    assert.equal(bookTimeoutStage(slow.trace), 'waiting_response_headers');
    assert.equal(localRequests, 2);
    console.log(JSON.stringify({ smoke: 'passed', schoolRequests: 0, timeoutMs: 8000, offsetsMs: plans, cachedUserReady: true, timeoutStage: bookTimeoutStage(slow.trace) }));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
