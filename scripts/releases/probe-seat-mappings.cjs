'use strict';

// 只读诊断：使用测试账号查询目标日期的六楼座位映射；绝不调用 bookSeats。
const readline = require('node:readline');
const https = require('node:https');
const { casLogin } = require(process.env.CAS_MODULE_PATH ?? '/app/dist/cas/cas-login.js');

const targetTitles = ['201', '203', '204', '205', '206', '207', '208', '209', '210'];
const roomId = '1559';
const beginTime = 1792022400;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function search(cookie) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      beginTime: String(beginTime), duration: '50400', num: '1',
      'space_category[category_id]': '591', 'space_category[content_id]': '3',
    }).toString();
    const request = https.request('https://hdu.huitu.zhishulib.com/Seat/Index/searchSeats?LAB_JSON=1', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0',
        'X-Requested-With': 'XMLHttpRequest',
      },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          request.destroy(new Error('response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, raw: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
    });
    request.setTimeout(8000, () => request.destroy(new Error('search_timeout')));
    request.on('error', reject);
    request.end(body);
  });
}

function extract(raw) {
  const byTitle = new Map(targetTitles.map((title) => [title, new Set()]));
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (String(value.info?.id ?? '') === roomId && Array.isArray(value.POIs)) {
      for (const seat of value.POIs) {
        const ids = byTitle.get(String(seat.title ?? '').trim());
        if (ids && seat.id != null) ids.add(String(seat.id));
      }
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(raw);
  return byTitle;
}

async function main() {
  const input = readline.createInterface({ input: process.stdin });
  const line = await new Promise((resolve) => input.once('line', resolve));
  input.close();
  const credentials = JSON.parse(line);
  if (!credentials.username || !credentials.password) throw new Error('credentials_missing');
  const originalLog = console.log;
  let session;
  try {
    console.log = () => {};
    session = await casLogin({
      username: credentials.username,
      password: credentials.password,
      serviceUrl: 'https://hdu.huitu.zhishulib.com/User/Index/hduCASLogin?forward=%2FSpace%2FCategory%2Flist%3Fcategory_id%3D591',
    });
  } finally { console.log = originalLog; }
  const cookie = Object.entries(session.cookies ?? {}).map(([name, value]) => `${name}=${value}`).join('; ');
  if (!cookie) throw new Error('no_session');
  const aggregate = new Map(targetTitles.map((title) => [title, new Set()]));
  for (let round = 1; round <= 3; round++) {
    const result = await search(cookie);
    const current = extract(result.raw);
    for (const [title, ids] of current) for (const id of ids) aggregate.get(title).add(id);
    console.log(JSON.stringify({ round, httpStatus: result.status, found: [...current].filter(([, ids]) => ids.size === 1).map(([title]) => title) }));
    if ([...aggregate.values()].every((ids) => ids.size === 1)) break;
    if (round < 3) await sleep(1150);
  }
  console.log(JSON.stringify({ mappings: Object.fromEntries([...aggregate].map(([title, ids]) => [title, [...ids]])), bookingRequests: 0 }));
}

main().catch((error) => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
