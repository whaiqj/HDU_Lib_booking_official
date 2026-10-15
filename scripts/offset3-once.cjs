'use strict';

// 独立、单次实约实验。凭证从 stdin JSON 读取，不启动 Nest/队列，不读取 .env。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const BASE = 'https://hdu.huitu.zhishulib.com';
const SEARCH = '/Seat/Index/searchSeats?LAB_JSON=1';
const BOOK = '/Seat/Index/bookSeats?LAB_JSON=1';
const SERVICE = BASE + '/User/Index/hduCASLogin?forward=%2FSpace%2FCategory%2Flist%3Fcategory_id%3D591';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (event, details = {}) => console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...details }));

function validateConfig(c) {
  if (!c.username || !c.password) throw new Error('credentials_missing');
  for (const key of ['triggerAt', 'beginAt']) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(c[key] ?? '')) throw new Error('explicit_timezone_required');
  }
  const trigger = Date.parse(c.triggerAt);
  const begin = Date.parse(c.beginAt);
  if (!Number.isFinite(trigger) || !Number.isFinite(begin)) throw new Error('invalid_date');
  if (!c.triggerAt.endsWith('T20:00:00+08:00') || !c.beginAt.endsWith('T08:00:00+08:00')) throw new Error('wrong_time_of_day');
  if (begin - trigger !== 36 * 3600000) throw new Error('target_must_be_trigger_day_plus_two');
  if (c.duration !== 50400 || c.roomId !== '1559' || c.seatTitle !== '202' || c.offsetMs !== 3000) throw new Error('unexpected_target');
  return { ...c, fireMs: trigger + c.offsetMs, beginTime: begin / 1000 };
}

function formBody(params) {
  const form = new URLSearchParams();
  function add(obj, prefix = '') {
    for (const [key, value] of Object.entries(obj)) {
      const name = prefix ? `${prefix}[${key}]` : key;
      if (Array.isArray(value)) value.forEach((item, i) => form.append(`${name}[${i}]`, String(item)));
      else if (value && typeof value === 'object') add(value, name);
      else form.append(name, String(value));
    }
  }
  add(params);
  return form.toString();
}

function sign(params) {
  const bookers = params.seatBookers.map((v, i) => `seatBookers[${i}]${v}`).join('&');
  const seats = params.seats.map((v, i) => `seats[${i}]${v}`).join('&');
  const canonical = `post&${BOOK}&api_time${params.api_time}&beginTime${params.beginTime}&duration${params.duration}&is_recommend${params.is_recommend}&${bookers}&${seats}`;
  return Buffer.from(crypto.createHash('md5').update(canonical).digest('hex')).toString('base64');
}

function resolveTarget(raw, roomId, title) {
  const seatIds = new Set();
  const bookers = new Set();
  if (raw?.DATA?.uid) bookers.add(String(raw.DATA.uid));
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (!raw?.DATA?.uid && obj.userInfo?.id != null) bookers.add(String(obj.userInfo.id));
    if (String(obj.info?.id) === roomId && Array.isArray(obj.POIs)) {
      for (const p of obj.POIs) if (String(p.title).trim() === title && p.id != null) seatIds.add(String(p.id));
    }
    Object.values(obj).forEach(walk);
  }
  walk(raw);
  if (seatIds.size !== 1 || bookers.size !== 1) return null;
  return { seatId: [...seatIds][0], bookerId: [...bookers][0] };
}

function outcome(raw, status) {
  const message = String(raw?.MESSAGE ?? raw?.msg ?? '');
  if (raw?.DATA?.result === 'success') return 'success';
  if (status === 429 || /请求太频繁|请求过于频繁|操作太频繁|操作过于频繁/.test(message)) return 'rate_limit';
  if (raw?.is_login === false || raw?.DATA?.is_login === false || /未登录|登录已过期/.test(message)) return 'session_expired';
  if (/^超出可预约座位时间范围$/.test(message)) return 'window_not_open';
  if (/已有预约|重复预约|已预约过/.test(message)) return 'already_booked';
  if (/座位不可用|座位已被预约|已被占用/.test(message)) return 'seat_unavailable';
  if (status >= 300 && status < 400) return 'redirect';
  return 'unknown';
}

function request(endpoint, body, cookie, apiToken, agent, diagnostics = false) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const times = {};
    const headers = { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'Content-Length': Buffer.byteLength(body), 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'XMLHttpRequest' };
    if (apiToken) headers['Api-Token'] = apiToken;
    const req = https.request(BASE + endpoint, { method: 'POST', headers, agent }, (res) => {
      times.responseHeadersMs = Date.now() - started;
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) { req.destroy(new Error('response_too_large')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let raw;
        try { raw = JSON.parse(text); } catch { raw = null; }
        resolve({ raw, status: res.statusCode, elapsedMs: Date.now() - started, serverDate: res.headers.date ?? null, times, reusedSocket: req.reusedSocket, bodyHash: crypto.createHash('sha256').update(text).digest('hex') });
      });
    });
    req.on('socket', (socket) => {
      times.socketAssignedMs = Date.now() - started;
      if (!req.reusedSocket) {
        socket.once('lookup', () => { times.dnsMs = Date.now() - started; });
        socket.once('connect', () => { times.tcpMs = Date.now() - started; });
        socket.once('secureConnect', () => { times.tlsMs = Date.now() - started; });
      }
    });
    req.once('finish', () => {
      times.requestFinishedAt = new Date().toISOString();
      times.requestFinishedMs = Date.now() - started;
      if (diagnostics) log('request_written', { ...times, reusedSocket: req.reusedSocket });
    });
    // 总时间限制，既涵盖连接，也涵盖响应；不会自动重试。
    const timer = setTimeout(() => req.destroy(new Error('request_deadline')), 15000);
    req.once('error', reject);
    req.once('close', () => clearTimeout(timer));
    req.end(body);
  });
}

async function run(config, preflight = false) {
  const c = validateConfig(config);
  if (!preflight && Date.now() >= c.fireMs - 5000) throw new Error('missed_preparation_cutoff');
  const { casLogin } = require(path.resolve(process.env.CAS_MODULE_PATH ?? '/app/dist/cas/cas-login.js'));
  log('experiment_start', { mode: preflight ? 'preflight_no_booking' : 'single_booking', triggerAt: c.triggerAt, fireAt: new Date(c.fireMs).toISOString(), beginAt: c.beginAt, duration: c.duration, roomId: c.roomId, seatTitle: c.seatTitle, offsetMs: c.offsetMs });
  const originalLog = console.log;
  let session;
  try {
    console.log = () => {}; // CAS 工具原有日志包含 ticket，禁止转存。
    session = await casLogin({ username: c.username, password: c.password, serviceUrl: SERVICE });
  } finally { console.log = originalLog; }
  const cookie = Object.entries(session.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  if (!cookie) throw new Error('no_session');
  log('authentication_ready');
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    let target;
    for (let round = 1; round <= 3; round++) {
      const response = await request(SEARCH, formBody({ beginTime: c.beginTime, duration: c.duration, num: 1, space_category: { category_id: '591', content_id: '3' } }), cookie, null, agent);
      target = resolveTarget(response.raw, c.roomId, c.seatTitle);
      log('mapping_check', { round, resolved: Boolean(target), httpStatus: response.status, elapsedMs: response.elapsedMs });
      if (target) break;
      if (round < 3) await sleep(2000);
    }
    if (!target) throw new Error('exact_mapping_unresolved');
    log('preparation_ready', { roomId: c.roomId, seatTitle: c.seatTitle, seatId: target.seatId });
    if (preflight) { log('preflight_complete_no_booking'); return; }
    // 准备过早完成后的时钟等待；不发送预开闸 book 请求。
    while (c.fireMs > Date.now()) {
      const remaining = c.fireMs - Date.now();
      await sleep(remaining > 30 ? Math.min(1000, remaining - 15) : Math.max(1, remaining));
    }
    const lateMs = Date.now() - c.fireMs;
    if (lateMs > 150) throw new Error('fire_too_late_no_booking');
    const marker = path.join(process.env.EXPERIMENT_STATE_DIR ?? '/experiment-state', c.triggerAt.slice(0, 10) + '-202.sent');
    const fd = fs.openSync(marker, 'wx', 0o600); // 重启/重复调用也不能多次提交。
    fs.writeFileSync(fd, JSON.stringify({ intendedFireAt: new Date(c.fireMs).toISOString() }));
    fs.closeSync(fd);
    const params = { beginTime: c.beginTime, duration: c.duration, seats: [target.seatId], seatBookers: [target.bookerId], is_recommend: 0, api_time: Math.floor(Date.now() / 1000) };
    const body = formBody(params);
    const token = sign(params);
    const issuedMs = Date.now();
    if (issuedMs - c.fireMs > 150) throw new Error('fire_too_late_no_booking');
    log('booking_invoked', { issuedAt: new Date(issuedMs).toISOString(), offsetFromTriggerMs: issuedMs - Date.parse(c.triggerAt), lateMs: issuedMs - c.fireMs, count: 1 });
    try {
      const response = await request(BOOK, body, cookie, token, agent, true);
      const category = outcome(response.raw, response.status);
      const code = String(response.raw?.CODE ?? response.raw?.code ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
      log('booking_result', { category, resultCertain: category === 'success', httpStatus: response.status, applicationCode: code, elapsedMs: response.elapsedMs, serverDate: response.serverDate, reusedSocket: response.reusedSocket, timings: response.times, responseHash: response.bodyHash });
    } catch (error) {
      log('booking_result', { category: 'outcome_unknown', errorCode: error.code ?? 'request_error', elapsedMs: Date.now() - issuedMs, retried: false });
      process.exitCode = 2;
    }
    log('experiment_finished', { requestsIssued: 1, retry: false });
  } finally { agent.destroy(); }
}

module.exports = { validateConfig, formBody, sign, resolveTarget, outcome };
if (require.main === module) {
  Promise.resolve().then(() => run(JSON.parse(fs.readFileSync(0, 'utf8')), process.argv.includes('--preflight'))).catch((error) => {
    // 不输出 CAS 异常信息/响应原文，避免 URL ticket 或账号信息进入日志。
    const known = /^(credentials_missing|explicit_timezone_required|invalid_date|wrong_time_of_day|target_must_be_trigger_day_plus_two|unexpected_target|missed_preparation_cutoff|no_session|exact_mapping_unresolved|fire_too_late_no_booking|request_deadline|response_too_large)$/;
    log('experiment_aborted', { reason: known.test(error.message) ? error.message : 'preparation_or_execution_error', errorCode: error.code ?? null });
    process.exitCode = 1;
  });
}
