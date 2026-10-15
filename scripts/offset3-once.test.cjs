'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateConfig, formBody, sign, resolveTarget, outcome } = require('./offset3-once.cjs');
const config = { username: 'test', password: 'test', triggerAt: '2026-10-13T20:00:00+08:00', beginAt: '2026-10-15T08:00:00+08:00', duration: 50400, roomId: '1559', seatTitle: '202', offsetMs: 3000 };

test('next release day + two dates and +3 second fire time are explicit', () => {
  const parsed = validateConfig(config);
  assert.equal(new Date(parsed.fireMs).toISOString(), '2026-10-13T12:00:03.000Z');
  assert.equal(new Date(parsed.beginTime * 1000).toISOString(), '2026-10-15T00:00:00.000Z');
});
test('wrong booking day, seat, missing timezone, duration and offset abort', () => {
  for (const changes of [{ beginAt: '2026-10-14T08:00:00+08:00' }, { seatTitle: '209' }, { triggerAt: '2026-10-13T20:00:00' }, { duration: 3600 }, { offsetMs: 5000 }]) {
    assert.throws(() => validateConfig({ ...config, ...changes }));
  }
});
test('mapping uses the requested room rather than the same title in another room', () => {
  const raw = { DATA: { uid: 123 }, data: { info: { id: 'other' }, POIs: [{ id: 'wrong', title: '202' }] }, allContent: [{ info: { id: 1559 }, POIs: [{ id: 'right', title: '202' }] }] };
  assert.deepEqual(resolveTarget(raw, '1559', '202'), { seatId: 'right', bookerId: '123' });
});
test('split room blocks merge but ambiguous or missing seat mappings abort', () => {
  const block = (id) => ({ info: { id: 1559 }, POIs: [{ title: '202', id }] });
  assert.deepEqual(resolveTarget({ userInfo: { id: 'booker' }, allContent: [block('a'), block('a')] }, '1559', '202'), { seatId: 'a', bookerId: 'booker' });
  assert.equal(resolveTarget({ userInfo: { id: 'booker' }, allContent: [block('a'), block('b')] }, '1559', '202'), null);
  assert.equal(resolveTarget({ userInfo: { id: 'booker' }, allContent: [] }, '1559', '202'), null);
});
test('form arrays and nested category use the captured request contract', () => {
  const form = new URLSearchParams(formBody({ seats: ['a'], seatBookers: ['b'], space_category: { category_id: '591', content_id: '3' }, is_recommend: 0 }));
  assert.equal(form.get('seats[0]'), 'a');
  assert.equal(form.get('seatBookers[0]'), 'b');
  assert.equal(form.get('space_category[category_id]'), '591');
  assert.equal(form.get('is_recommend'), '0');
});
test('API signing order matches the documented library request', () => {
  const params = { api_time: 1, beginTime: 2, duration: 3, is_recommend: 0, seatBookers: ['b'], seats: ['s'] };
  const literal = 'post&/Seat/Index/bookSeats?LAB_JSON=1&api_time1&beginTime2&duration3&is_recommend0&seatBookers[0]b&seats[0]s';
  assert.equal(sign(params), Buffer.from(crypto.createHash('md5').update(literal).digest('hex')).toString('base64'));
});
test('unavailable does not imply closed window, timeout or confirmed booking', () => {
  assert.equal(outcome({ MESSAGE: '选择的座位无法预约，可能座位不可用或已占用' }, 200), 'seat_unavailable');
  assert.equal(outcome({ MESSAGE: '超出可预约座位时间范围' }, 200), 'window_not_open');
  assert.equal(outcome({ MESSAGE: '已有预约' }, 200), 'already_booked');
  assert.equal(outcome({ DATA: { result: 'success' } }, 200), 'success');
  assert.equal(outcome(null, 429), 'rate_limit');
});
