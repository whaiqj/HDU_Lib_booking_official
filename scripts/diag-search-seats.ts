/**
 * searchSeats 返回结构诊断脚本
 *
 * 背景（9/7 六楼事故）：六楼 1559 抢座失败，预解析快照缺失 204-209；
 * 同秒两次 search 一次返回 220 座一次返回 424 座。需要实证：
 *   1. 指定 beginTime+duration 下，searchSeats 是否返回目标座位号？
 *   2. 目标房间是否被拆成多个区块（同 roomId 多个块）返回？
 *   3. 不同轮次之间返回的座位集合是否波动？
 *
 * 运行方式：
 *   npx tsx scripts/diag-search-seats.ts \
 *     --begin "2026-09-08 12:00" --duration 50400 \
 *     --rounds 3 --room 1559 --titles 204,205,206,207,208,209
 *
 *   参数说明：
 *   --begin     预约开始时间（本地时区 "YYYY-MM-DD HH:mm"）或 Unix 秒级时间戳
 *   --duration  预约时长秒数（整天 50400 / 一小时 3600，用于对照实验）
 *   --rounds    重复请求轮数（默认 3），用于观察波动
 *   --room      目标房间 ID（默认 1559 六楼）
 *   --titles    关注的座位号，逗号分隔
 *   --category  空间分类 ID（默认 591）
 *   --content   空间内容 ID（默认 3）
 *   --dump      可选，原始响应输出目录（每轮存一个 JSON 文件）
 *
 * 需要在 .env 中配置 CAS_USERNAME / CAS_PASSWORD
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 加载 .env ----
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
import { LIBRARY_API } from '../src/common/constants/api-endpoints';
import { buildFormBody, FORM_CONTENT_TYPE } from '../src/common/utils/form-urlencoded.util';

const LIBRARY_BASE =
  process.env.LIBRARY_API_BASE_URL ?? 'https://hdu.huitu.zhishulib.com';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---- CLI 参数解析 ----
function parseArgs(): {
  beginTime: number;
  duration: number;
  rounds: number;
  roomId: string;
  titles: string[];
  categoryId: string;
  contentId: string;
  dumpDir: string | null;
} {
  const argv = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const beginRaw = get('--begin');
  if (!beginRaw) {
    console.error('❌ 缺少 --begin 参数（"YYYY-MM-DD HH:mm" 或 Unix 秒级时间戳）');
    process.exit(1);
  }
  let beginTime: number;
  if (/^\d+$/.test(beginRaw)) {
    beginTime = Number(beginRaw);
  } else {
    const parsed = new Date(beginRaw.replace(' ', 'T'));
    if (Number.isNaN(parsed.getTime())) {
      console.error(`❌ 无法解析 --begin: ${beginRaw}`);
      process.exit(1);
    }
    beginTime = Math.floor(parsed.getTime() / 1000);
  }

  return {
    beginTime,
    duration: Number(get('--duration') ?? 50400),
    rounds: Number(get('--rounds') ?? 3),
    roomId: get('--room') ?? '1559',
    titles: (get('--titles') ?? '204,205,206,207,208,209')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    categoryId: get('--category') ?? '591',
    contentId: get('--content') ?? '3',
    dumpDir: get('--dump') ?? null,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: any) {
    if (e.name === 'AbortError') {
      throw new Error(`请求超时 (${timeoutMs}ms): ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 深搜响应中形如 { info:{id,title}, POIs:[...] } 的房间块（保留全部区块，不去重） */
function collectRoomBlocks(raw: any): Array<{ roomId: string; roomTitle: string; pois: any[]; path: string }> {
  const blocks: Array<{ roomId: string; roomTitle: string; pois: any[]; path: string }> = [];
  const walk = (o: any, path: string): void => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      o.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (o.info?.id !== undefined && Array.isArray(o.POIs)) {
      blocks.push({
        roomId: String(o.info.id),
        roomTitle: String(o.info.title ?? ''),
        pois: o.POIs,
        path,
      });
    }
    for (const [k, v] of Object.entries(o)) {
      walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(raw?.allContent, 'allContent');
  // 兜底：推荐房间的 data.info+data.POIs 也是座位块（脚本早先只搜 allContent，
  // 会漏掉"推荐房间即目标房间"的返回体——2026-09-08 实证六楼座位全在 data.POIs）
  if (raw?.data?.info?.id !== undefined && Array.isArray(raw?.data?.POIs)) {
    blocks.push({
      roomId: String(raw.data.info.id),
      roomTitle: String(raw.data.info.title ?? ''),
      pois: raw.data.POIs,
      path: 'data',
    });
  }
  return blocks;
}

function beijingTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

// ---- 主流程 ----
async function main() {
  const args = parseArgs();
  const username = process.env.CAS_USERNAME;
  const password = process.env.CAS_PASSWORD;
  const serviceUrl = process.env.CAS_SERVICE ?? CAS_SERVICE_URL;

  if (!username || !password) {
    console.error('❌ 缺少 CAS_USERNAME 或 CAS_PASSWORD 环境变量');
    process.exit(1);
  }

  console.log('='.repeat(70));
  console.log('🔬 searchSeats 返回结构诊断');
  console.log('='.repeat(70));
  console.log(`账号:       ${username}`);
  console.log(`beginTime:  ${args.beginTime} (北京时间 ${beijingTime(args.beginTime)})`);
  console.log(`duration:   ${args.duration}s (${(args.duration / 3600).toFixed(1)}h)`);
  console.log(`轮次:       ${args.rounds}`);
  console.log(`目标房间:   ${args.roomId}`);
  console.log(`关注座位:   ${args.titles.join(', ')}`);
  console.log('');

  if (args.dumpDir) {
    mkdirSync(args.dumpDir, { recursive: true });
  }

  console.log('🔐 CAS 登录...');
  const loginResult = await casLogin({ username, password, serviceUrl });
  const cookieHeader = Object.entries(loginResult.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  console.log(`✅ 登录成功`);
  console.log('');

  const body = buildFormBody({
    beginTime: args.beginTime,
    duration: args.duration,
    num: 1,
    space_category: {
      category_id: args.categoryId,
      content_id: args.contentId,
    },
  });

  // 各轮目标房间座位 id 集合，用于轮次间对比
  const roundSeatIdSets: Set<string>[] = [];

  for (let round = 1; round <= args.rounds; round++) {
    console.log('─'.repeat(70));
    console.log(`📡 第 ${round}/${args.rounds} 轮`);

    let raw: any;
    const startMs = Date.now();
    try {
      const res = await fetchWithTimeout(
        `${LIBRARY_BASE}${LIBRARY_API.SEARCH_SEATS}`,
        {
          method: 'POST',
          redirect: 'manual',
          headers: {
            'User-Agent': UA,
            Cookie: cookieHeader,
            'Content-Type': FORM_CONTENT_TYPE,
            Accept: 'application/json, text/plain, */*',
            Referer: `${LIBRARY_BASE}/Seat/Index/index`,
          },
          body,
        },
        15_000,
      );
      if (res.status >= 300 && res.status < 400) {
        console.log(`⚠️  3xx 重定向 → ${res.headers.get('location')}（会话可能失效）`);
        process.exit(1);
      }
      const text = await res.text();
      raw = JSON.parse(text);
    } catch (e: any) {
      console.log(`❌ 请求失败: ${e.message}`);
      continue;
    }
    const elapsedMs = Date.now() - startMs;

    if (args.dumpDir) {
      const file = resolve(args.dumpDir, `search_${args.duration}s_round${round}.json`);
      writeFileSync(file, JSON.stringify(raw, null, 2), 'utf-8');
      console.log(`   原始响应已存: ${file}`);
    }

    if (raw?.ui_type === 'com.Message') {
      console.log(`❌ 业务错误: CODE=${raw?.CODE} MESSAGE=${raw?.MESSAGE ?? raw?.DATA?.MESSAGE}`);
      continue;
    }

    const pois: any[] = raw?.data?.POIs ?? [];
    const info = raw?.data?.info ?? {};
    const availableCount = pois.filter((p) => p.state === 0).length;
    console.log(`   耗时=${elapsedMs}ms ui_type=${raw?.ui_type ?? '-'} userInfoId=${raw?.DATA?.uid ?? '(未提取到)'}`);
    console.log(`   data.info 推荐房间: ${info.title ?? '-'}(id=${info.id ?? '-'})  data.POIs 总数=${pois.length} 空闲=${availableCount}`);

    // 目标房间在 data.POIs 中的覆盖（仅当推荐房间就是目标房间时有意义）
    if (String(info.id ?? '') === args.roomId) {
      const dataTitles = new Set(pois.map((p) => String(p.title ?? '')));
      const missingInData = args.titles.filter((t) => !dataTitles.has(t));
      console.log(`   data.POIs 即目标房间座位表: 关注座位缺失=${missingInData.length > 0 ? missingInData.join(',') : '无'}`);
    }

    // allContent 区块结构（不去重，逐块列出）
    const blocks = collectRoomBlocks(raw);
    const targetBlocks = blocks.filter((b) => b.roomId === args.roomId);
    const allRoomIds = [...new Set(blocks.map((b) => b.roomId))];
    console.log(`   allContent 房间块总数=${blocks.length} 涉及房间=${allRoomIds.length} 个: ${allRoomIds.join(',')}`);

    if (targetBlocks.length === 0) {
      console.log(`   ⚠️  目标房间 ${args.roomId} 在 allContent 中没有区块！`);
    } else {
      console.log(`   🎯 目标房间 ${args.roomId} 共 ${targetBlocks.length} 个区块:`);
      const mergedIds = new Map<string, { title: string; state: number }>();
      targetBlocks.forEach((b, i) => {
        const blockTitles = new Set(b.pois.map((p) => String(p.title ?? '')));
        const hitsHere = args.titles.filter((t) => blockTitles.has(t));
        console.log(`      区块#${i + 1} (${b.roomTitle}) 座位数=${b.pois.length} 含关注座位=[${hitsHere.join(',') || '无'}] 路径=${b.path}`);
        for (const p of b.pois) {
          const id = String(p.id ?? '');
          const prev = mergedIds.get(id);
          if (!prev) {
            mergedIds.set(id, { title: String(p.title ?? ''), state: Number(p.state ?? 0) });
          } else if (prev.state !== 0 && Number(p.state ?? 0) === 0) {
            prev.state = 0;
          }
        }
      });

      // 合并视图：目标座位解析结果
      console.log(`   合并后目标房间座位数=${mergedIds.size}`);
      const byTitle = new Map<string, { id: string; state: number }>();
      for (const [id, s] of mergedIds) {
        if (!byTitle.has(s.title)) {
          byTitle.set(s.title, { id, state: s.state });
        }
      }
      for (const title of args.titles) {
        const seat = byTitle.get(title);
        if (seat) {
          const stateText = seat.state === 0 ? '空闲' : `state=${seat.state}`;
          console.log(`      ✅ 座位 ${title} → seatId=${seat.id} (${stateText})`);
        } else {
          console.log(`      ❌ 座位 ${title} 未在本轮任何区块中出现`);
        }
      }
      roundSeatIdSets.push(new Set(mergedIds.keys()));
    }

    // 稍等再打下一轮，避免触发频控
    if (round < args.rounds) {
      await new Promise((r) => setTimeout(r, 1_500));
    }
  }

  // 轮次间波动对比
  console.log('─'.repeat(70));
  if (roundSeatIdSets.length >= 2) {
    console.log('📊 轮次间波动对比（目标房间合并座位集）:');
    for (let i = 1; i < roundSeatIdSets.length; i++) {
      const prev = roundSeatIdSets[i - 1];
      const curr = roundSeatIdSets[i];
      const added = [...curr].filter((id) => !prev.has(id));
      const removed = [...prev].filter((id) => !curr.has(id));
      console.log(`   第${i}轮→第${i + 1}轮: 座位数 ${prev.size} → ${curr.size}  新增=${added.length} 缺失=${removed.length}`);
      if (added.length > 0 && added.length <= 20) console.log(`      新增 ids: ${added.join(',')}`);
      if (removed.length > 0 && removed.length <= 20) console.log(`      缺失 ids: ${removed.join(',')}`);
    }
  } else {
    console.log('📊 有效轮次不足 2 轮，无法对比波动');
  }
  console.log('='.repeat(70));
  console.log('✅ 诊断完成');
}

main().catch((e) => {
  console.error('未预期错误:', e);
  process.exit(1);
});
