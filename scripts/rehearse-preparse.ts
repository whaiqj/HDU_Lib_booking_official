/**
 * 今晚抢座预演：用真实生产代码链（HduLibraryClientService + SeatPreparseService）
 * 验证 9/10 整天时段盲抢参数能否就绪。
 *
 * 场景 A（放号后可查时段，以 9/9 整天为样本）：
 *   完整走 searchSeats → extractAllRooms 合并 → resolvePreferenceSeats，
 *   验证 204-208 全部解析为 seatId、userInfoId 正确提取。
 *
 * 场景 B（放号前，即今晚 19:55 预解析 9/10 整天会遇到的空返回）：
 *   search 返回"没有符合条件的座位预约" → 生产代码应退化为持久化缓存组装。
 *   缓存 stub 返回实测映射（204→63100…208→63104、userInfoId=410958），
 *   验证 buildEntryFromCache 兜底路径能产出完整盲抢参数。
 *
 * 运行：npx tsx scripts/rehearse-preparse.ts
 * 依赖 .env 的 CAS_USERNAME / CAS_PASSWORD
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { from } from 'rxjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');
if (existsSync(envPath)) {
  const envText = readFileSync(envPath, 'utf-8');
  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

import { casLogin } from '../src/cas/cas-login';
import { CAS_SERVICE_URL } from '../src/common/constants/study-room';
import { HduLibraryClientService } from '../src/modules/hdu-library/hdu-library-client.service';
import { SeatPreparseService } from '../src/modules/grab-seat/seat-preparse.service';
import type { GrabTask } from '../src/modules/grab-task/entities/grab-task.entity';

const LIBRARY_BASE =
  process.env.LIBRARY_API_BASE_URL ?? 'https://hdu.huitu.zhishulib.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const CATEGORY_ID = '591';
const CONTENT_ID = '3';
const ROOM_ID = '1559';
const ROOM_NAME = '杭韵数阁（六楼）';
const PREFERENCES = ['204', '205', '206', '207', '208'];

/** 实测稳定的座位映射与预约人 id（2026-09-08 诊断得出，落库后即缓存兜底数据源） */
const KNOWN_SEAT_MAP = new Map([
  ['204', '63100'],
  ['205', '63101'],
  ['206', '63102'],
  ['207', '63103'],
  ['208', '63104'],
]);
const KNOWN_USER_INFO_ID = '410958';

const ACCOUNT = process.env.CAS_USERNAME ?? '';

/** 2026-09-09 08:00 与 2026-09-10 08:00 的 Unix 秒（整条时段约定：08:00 起 + 50400s） */
const BEGIN_0909 = 1788912000;
const BEGIN_0910 = 1788998400;

const makeTask = (beginTime: number): GrabTask =>
  ({
    id: 'rehearsal-task',
    accountId: ACCOUNT,
    categoryId: CATEGORY_ID,
    contentId: CONTENT_ID,
    roomId: ROOM_ID,
    roomName: ROOM_NAME,
    beginTime,
    duration: 50400,
    seatPreference: PREFERENCES,
    strictMode: true,
    triggerAt: beginTime - 600,
    status: 'pending',
    attempts: 0,
    result: null,
  }) as GrabTask;

function beijing(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}

function printEntry(label: string, entry: any, failReason?: string): void {
  console.log('');
  console.log(`▶ ${label}`);
  if (!entry) {
    console.log(`  ❌ entry=null failReason=${failReason}`);
    return;
  }
  console.log(`  roomId=${entry.roomId} (${entry.roomName})`);
  console.log(`  userInfoId=${entry.userInfoId}`);
  console.log(`  候选队列（按偏好顺序）:`);
  for (const s of entry.seats) {
    console.log(`    ${s.title} → seatId=${s.seatId}`);
  }
  console.log(`  unresolvedTitles=${entry.unresolvedTitles.join(',') || '无'}`);
  const allResolved =
    entry.seats.length === PREFERENCES.length &&
    entry.unresolvedTitles.length === 0 &&
    entry.userInfoId;
  console.log(
    allResolved
      ? '  ✅ 盲抢参数齐备（可直接 bookSeats 直发）'
      : '  ⚠️ 参数不齐，需人工检查',
  );
}

async function main(): Promise<void> {
  console.log('='.repeat(70));
  console.log('🎭 今晚抢座预演（真实生产代码链）');
  console.log('='.repeat(70));
  console.log(`账号: ${ACCOUNT}`);
  console.log(`目标: 六楼 ${ROOM_NAME}(${ROOM_ID}) 偏好=${PREFERENCES.join(',')}`);
  console.log(`时段约定: 08:00 + 50400s（整天）`);

  console.log('\n🔐 CAS 登录...');
  const login = await casLogin({
    username: ACCOUNT,
    password: process.env.CAS_PASSWORD ?? '',
    serviceUrl: process.env.CAS_SERVICE ?? CAS_SERVICE_URL,
  });
  const cookie = Object.entries(login.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  console.log('✅ 登录成功');

  // ---- 用真实客户端服务，仅替换 HTTP 传输与凭据来源（与生产等价的适配层）----
  const httpAdapter = {
    post: (url: string, body: string, config: any) =>
      from(
        (async () => {
          const res = await fetch(url, {
            method: 'POST',
            redirect: 'manual',
            headers: { ...config.headers, 'User-Agent': UA },
            body,
          });
          const data = JSON.parse(await res.text());
          return { data };
        })(),
      ),
  };
  const authAdapter = {
    getCredentials: () => ({ type: 'cookie' as const, value: cookie }),
  };
  const client = new HduLibraryClientService(
    httpAdapter as any,
    authAdapter as any,
  );

  // 缓存 stub：记录写入、场景 B 时返回实测映射（模拟已落库的持久化缓存）
  const cacheWrites: string[] = [];
  const cacheStub = {
    findSeatIds: async (roomId: string, titles: string[]) => {
      const m = new Map<string, string>();
      for (const t of titles) {
        const id = KNOWN_SEAT_MAP.get(t);
        if (id) m.set(t, id);
      }
      console.log(`  [cache.findSeatIds] roomId=${roomId} titles=${titles.join(',')} → 命中 ${m.size}`);
      return m;
    },
    saveSeatMappings: async (roomId: string, _roomName: string, seats: any[]) => {
      cacheWrites.push(
        `roomId=${roomId} seats=${seats.map((s) => `${s.title}→${s.seatId}`).join(',')}`,
      );
    },
    getUserInfoId: async (accountId: string) => {
      console.log(`  [cache.getUserInfoId] ${accountId} → ${KNOWN_USER_INFO_ID}`);
      return KNOWN_USER_INFO_ID;
    },
    saveUserInfoId: async (accountId: string, userInfoId: string) => {
      cacheWrites.push(`userInfo ${accountId}→${userInfoId}`);
    },
  };

  // ---- 场景 A：可查时段（9/9 整天，昨晚已放号）----
  console.log('\n' + '─'.repeat(70));
  console.log(`场景 A：放号后可查时段 9/9 整天（begin=${BEGIN_0909} 北京时间 ${beijing(BEGIN_0909)}）`);
  const preparseA = new SeatPreparseService(client, cacheStub as any);
  const outcomeA = await preparseA.preparse(makeTask(BEGIN_0909));
  printEntry('场景 A 结果', outcomeA.entry, outcomeA.failReason);

  // ---- 场景 B：放号前（今晚 19:55 预解析 9/10 整天 → 预期空返回走缓存兜底）----
  console.log('\n' + '─'.repeat(70));
  console.log(`场景 B：放号前时段 9/10 整天（begin=${BEGIN_0910} 北京时间 ${beijing(BEGIN_0910)}）`);
  console.log('  预期：search 返回"没有符合条件的座位预约"→ 代码应走持久化缓存兜底');
  const preparseB = new SeatPreparseService(client, cacheStub as any);
  const outcomeB = await preparseB.preparse(makeTask(BEGIN_0910));
  printEntry('场景 B 结果', outcomeB.entry, outcomeB.failReason);

  console.log('\n' + '─'.repeat(70));
  console.log('缓存写入记录（生产中应落到 seat_mapping_cache / user_info_cache 表）:');
  for (const w of cacheWrites) console.log(`  ${w}`);

  console.log('\n' + '='.repeat(70));
  const aOk =
    outcomeA.entry?.seats.length === PREFERENCES.length &&
    outcomeA.entry?.userInfoId === KNOWN_USER_INFO_ID;
  const bOk =
    outcomeB.entry?.seats.length === PREFERENCES.length &&
    outcomeB.entry?.userInfoId === KNOWN_USER_INFO_ID;
  console.log(`场景 A（放号后预解析）: ${aOk ? '✅ 通过' : '❌ 未通过'}`);
  console.log(`场景 B（放号前缓存兜底）: ${bOk ? '✅ 通过' : '❌ 未通过'}`);
  console.log(
    aOk && bOk
      ? '\n结论：两条路径均可产出盲抢参数，今晚 20:00 可按此执行。'
      : '\n结论：存在未通过项，今晚前需修复。',
  );
}

main().catch((e) => {
  console.error('预演失败:', e);
  process.exit(1);
});
