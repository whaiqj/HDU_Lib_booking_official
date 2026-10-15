'use strict';
// In candidate image: local HTTP only, all booking dependencies stubbed.
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const appRoot = process.env.APP_ROOT || '/app';
const axios = require(path.join(appRoot, 'node_modules/axios'));
const { from } = require(path.join(appRoot, 'node_modules/rxjs'));
const { createBookTransportTrace, bookTimeoutStage } = require(path.join(appRoot, 'dist/modules/hdu-library/book-transport-trace.js'));
const { HduLibraryClientService } = require(path.join(appRoot, 'dist/modules/hdu-library/hdu-library-client.service.js'));
const { GrabSeatWorker, RETRY_CONFIG } = require(path.join(appRoot, 'dist/modules/grab-seat/grab-seat-worker.service.js'));

async function transportChecks() {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url.startsWith('/slow')) {
      setTimeout(() => { res.writeHead(200); res.end('late'); }, 250);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"DATA":{"result":"success"}}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const good = createBookTransportTrace();
    const response = await axios.post(url + '/ok', 'x=1', { timeout: 1000, maxRedirects: 0, transport: good.transport });
    assert.equal(response.data.DATA.result, 'success');
    assert.equal(good.trace.httpStatus, 200);
    assert.ok(good.trace.requestFinishedMs >= 0);
    assert.ok(good.trace.responseHeadersMs >= good.trace.requestFinishedMs);
    assert.ok(good.trace.responseEndedMs >= good.trace.responseHeadersMs);
    const slow = createBookTransportTrace();
    await assert.rejects(
      axios.post(url + '/slow', 'x=1', { timeout: 70, maxRedirects: 0, transport: slow.transport }),
      (error) => error.code === 'ECONNABORTED',
    );
    assert.equal(bookTimeoutStage(slow.trace), 'waiting_response_headers');
    const events = [];
    const client = new HduLibraryClientService(
      { post: (endpoint, body, config) => from(axios.post(endpoint, body, { ...config, maxRedirects: 0 })) },
      { getCredentials: () => ({ type: 'cookie', value: 'mock_session=1' }) },
    );
    client.baseUrl = url;
    client.logger = { log: (line) => events.push(JSON.parse(line)), debug() {}, warn() {} };
    const params = { beginTime: 1800000000, duration: 50400, seats: ['63106'], is_recommend: 0, api_time: 1799990000, seatBookers: ['mock-user'] };
    const booked = await client.bookSeats(params, 'mock-account', 'mock-task');
    assert.equal(booked.success, true);
    assert.equal(events[0].event, 'book_transport');
    assert.equal(events[0].outcome, 'success');
    assert.equal(events[0].timeoutMs, 8000);
    assert.equal(events[0].httpStatus, 200);
    assert.equal(events[0].requestSeq, 1);
    assert.ok(!JSON.stringify(events).includes('mock_session'));
    client.baseUrl = url + '/slow';
    client.computeAdaptiveTimeout = () => 70;
    const timedOut = await client.bookSeats(params, 'mock-account', 'mock-task');
    assert.equal(timedOut.success, false);
    assert.equal(events[1].outcome, 'transport_error');
    assert.equal(events[1].timeoutStage, 'waiting_response_headers');
    assert.equal(events[1].requestSeq, 2);
    assert.equal(requests, 4);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function offsetChecks() {
  const firstFire = [];
  const worker = new GrabSeatWorker(
    {}, {}, { invalidate() {} },
    { updateStatus: async () => {}, isCancellationRequested: () => false },
    {}, {}, {}, { notify: async () => {} },
  );
  worker.logger = { log() {}, warn() {}, debug() {}, error() {} };
  worker.fireAndForget = () => {};
  worker.resolvePreparse = async () => ({ roomId: '1559', roomName: 'mock', userInfoId: 'mock', seats: [{ title: '210', seatId: '63106' }], unresolvedTitles: [] });
  worker.executeBlindGrab = async (_task, _entry, _deadline, _startMs, fireMs) => { firstFire.push(fireMs); };
  const triggerAt = Math.floor(Date.now() / 1000) + 60;
  const task = { id: 'mock', triggerAt, beginTime: 1800000000, duration: 50400, seatPreference: ['210'], strictMode: true };
  process.env.GRAB_EARLY_ACCOUNT_IDS = 'account-early';
  await worker.runGrabTask({ ...task, accountId: 'account-early' });
  await worker.runGrabTask({ ...task, accountId: 'account-normal' });
  assert.deepEqual(firstFire, [triggerAt * 1000 + 3000, triggerAt * 1000 + RETRY_CONFIG.blindStartOffsetMs]);
}

Promise.all([transportChecks(), offsetChecks()]).then(() => {
  console.log(JSON.stringify({ smoke: 'passed', schoolRequests: 0, offsetEarlyMs: 3000, offsetNormalMs: 5000 }));
}).catch((error) => { console.error(error); process.exitCode = 1; });
