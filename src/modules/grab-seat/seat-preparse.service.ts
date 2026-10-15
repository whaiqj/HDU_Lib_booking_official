import { Injectable, Logger } from '@nestjs/common';
import { HduLibraryClientService } from '../hdu-library/hdu-library-client.service';
import {
  RoomSeats,
  SearchSeatsResult,
} from '../hdu-library/dto/search-seats-result.dto';
import { GrabTask } from '../grab-task/entities/grab-task.entity';
import { SeatMappingCacheService } from './seat-mapping-cache.service';

/** 预解析出的单个偏好座位 */
export interface PreparsedSeat {
  /** 偏好座位号（用户输入的 title） */
  title: string;
  /** 锁定房间内该座位号对应的系统内部 seatId */
  seatId: string;
}

/**
 * 触发前预解析结果：盲抢所需的全部静态参数
 * - 偏好座位号 → seatId（必须先锁定房间，多房间分类下同座位号是不同 seatId）
 * - 预约人 userInfo.id（bookSeats 的 seatBookers[0]）
 */
export interface PreparseEntry {
  taskId: string;
  accountId: string;
  /** 预约人图书馆内部 id */
  userInfoId: string;
  /** 实际锁定的房间 */
  roomId: string;
  roomName: string;
  /** 按偏好顺序解析出的座位（仅含解析成功的） */
  seats: PreparsedSeat[];
  /** 未能解析成 seatId 的偏好座位号（快照缺失且无历史缓存，盲抢窗口内后台补解析） */
  unresolvedTitles: string[];
  /** 是否存在跨房间同名座位、由系统自动挑选的房间（提醒用户确认） */
  autoPickedRoom: boolean;
  resolvedAt: number;
}

/**
 * 预解析执行结果
 * - entry 非空：解析成功（含全部静态参数）
 * - entry 为空 + failReason：解析失败及原因（透出给前端展示）
 */
export interface PreparseOutcome {
  entry: PreparseEntry | null;
  failReason?: string;
}

/** 缓存有效期：预检在 T-5min 执行，触发距预检不超过 5 分钟，10 分钟 TTL 留足余量 */
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * 预解析多快照轮数：单次 search 快照可能因分区块返回/数量波动缺失目标座位
 * （9/7 六楼事故：同秒两次 search 一个 220 座一个 424 座），多轮取并集兜底
 */
const PREPARSE_MAX_ROUNDS = 3;
/** 各轮 search 之间的间隔 */
const PREPARSE_RETRY_DELAY_MS = 1_150;

/**
 * 偏好座位预解析服务
 * 在 session-precheck（触发前 5 分钟）执行 searchSeats（最多 PREPARSE_MAX_ROUNDS 轮，取并集）：
 * 1. 从 allContent 房间目录锁定目标房间（任务指定 roomId 优先）
 * 2. 把偏好座位号解析成 seatId（seatId 跨天稳定，触发时刻可直接盲发 bookSeats）
 * 3. 缓存 userInfoId，抢座热路径不再依赖 searchSeats
 * 4. 快照缺失的座位号用持久化映射缓存回填；search 全部失败时整体退化为缓存组装
 *
 * 解析失败（网络/会话问题）不阻断主流程：worker 回退到 search-first 循环
 */
@Injectable()
export class SeatPreparseService {
  private readonly logger = new Logger(SeatPreparseService.name);
  /** 进程内缓存：taskId → 预解析结果。后端重启即失效，worker 会做一次惰性补解析 */
  private readonly cache = new Map<string, PreparseEntry>();

  constructor(
    private readonly hduLibraryClient: HduLibraryClientService,
    private readonly seatMappingCache: SeatMappingCacheService,
  ) {}

  /**
   * 执行预解析并写缓存
   * @returns 解析结果；searchSeats 失败或无可用房间时 entry 为 null 并携带 failReason（调用方回退 search-first）
   */
  async preparse(task: GrabTask): Promise<PreparseOutcome> {
    const preferences = task.seatPreference ?? [];
    let mergedRooms: RoomSeats[] = [];
    let userInfoId = '';
    let recommendedRoomId = '';
    let successRounds = 0;
    let lastFailReason = '';

    for (let round = 1; round <= PREPARSE_MAX_ROUNDS; round++) {
      let searchResult: SearchSeatsResult;
      try {
        searchResult = await this.hduLibraryClient.searchSeats(
          {
            beginTime: Number(task.beginTime),
            duration: task.duration,
            num: 1,
            space_category: {
              category_id: task.categoryId,
              content_id: task.contentId,
            },
          },
          task.accountId,
          task.id,
        );
      } catch (e) {
        lastFailReason = `座位搜索失败: ${(e as Error).message}`;
        this.logger.warn(
          `[预解析] taskId=${task.id} 第${round}/${PREPARSE_MAX_ROUNDS}轮 ${lastFailReason}`,
        );
        if (round < PREPARSE_MAX_ROUNDS) {
          await this.sleep(PREPARSE_RETRY_DELAY_MS);
        }
        continue;
      }

      successRounds++;
      if (!userInfoId && searchResult.userInfoId) {
        userInfoId = searchResult.userInfoId;
      }
      if (!recommendedRoomId && searchResult.room.id) {
        recommendedRoomId = searchResult.room.id;
      }

      const roundRooms: RoomSeats[] =
        searchResult.allRooms && searchResult.allRooms.length > 0
          ? searchResult.allRooms
          : [
              {
                id: searchResult.room.id,
                name: searchResult.room.name,
                seats: searchResult.seats,
              },
            ];
      mergedRooms = this.mergeRoomCatalog(mergedRooms, roundRooms);

      // 提前退出：全部偏好座位号已解析，无需再打快照
      const probe = this.resolvePreferenceSeats(
        mergedRooms,
        recommendedRoomId,
        task,
      );
      if (probe.roomId && probe.unresolvedTitles.length === 0) {
        break;
      }
      if (round < PREPARSE_MAX_ROUNDS) {
        await this.sleep(PREPARSE_RETRY_DELAY_MS);
      }
    }

    // 预约人 id 落持久化缓存（服务内部容错，失败仅告警）
    if (userInfoId) {
      void this.seatMappingCache.saveUserInfoId(task.accountId, userInfoId);
    }

    if (successRounds === 0) {
      // search 全部失败：尝试完全凭持久化缓存组装盲抢参数
      return this.buildEntryFromCache(task, lastFailReason || '座位搜索失败');
    }

    if (!userInfoId) {
      userInfoId = await this.seatMappingCache.getUserInfoId(task.accountId) ?? '';
    }

    if (!userInfoId) {
      this.logger.warn(`[预解析失败] taskId=${task.id} 未能提取 userInfoId`);
      return { entry: null, failReason: '未能提取预约人 userInfoId' };
    }

    const { roomId, roomName, seats, unresolvedTitles, autoPickedRoom } =
      this.resolvePreferenceSeats(mergedRooms, recommendedRoomId, task);

    if (!roomId) {
      const failReason = task.roomId
        ? `指定房间（roomId=${task.roomId}）不在房间目录中`
        : mergedRooms.length === 0
          ? '房间目录为空'
          : '偏好座位号在所有房间中均不存在';
      this.logger.warn(`[预解析失败] taskId=${task.id} ${failReason}`);
      return this.buildEntryFromCache(task, failReason);
    }

    // 仍缺失的座位号用持久化 seatId 缓存回填（seatId 跨天稳定）
    const cacheFilled: string[] = [];
    if (unresolvedTitles.length > 0) {
      // 传快照而非原数组：下方 splice 会原地修改 unresolvedTitles，
      // 外部服务若持有引用（含测试断言）会看到被篡改后的内容
      const cached = await this.seatMappingCache.findSeatIds(roomId, [
        ...unresolvedTitles,
      ]);
      for (let i = unresolvedTitles.length - 1; i >= 0; i--) {
        const title = unresolvedTitles[i];
        const seatId = cached.get(title);
        if (seatId) {
          seats.push({ title, seatId });
          unresolvedTitles.splice(i, 1);
          cacheFilled.push(`${title}→${seatId}`);
        }
      }
      // 缓存回填的座位追加在尾部，恢复偏好顺序
      seats.sort(
        (a, b) =>
          preferences.indexOf(a.title) - preferences.indexOf(b.title),
      );
    }

    // 本轮确认的映射落持久化缓存（含缓存回填项，幂等）
    if (seats.length > 0) {
      void this.seatMappingCache.saveSeatMappings(roomId, roomName, seats);
    }

    const entry: PreparseEntry = {
      taskId: task.id,
      accountId: task.accountId,
      userInfoId,
      roomId,
      roomName,
      seats,
      unresolvedTitles,
      autoPickedRoom,
      resolvedAt: Date.now(),
    };
    this.storeEntry(task.id, entry);

    this.logger.log(
      `[预解析完成] taskId=${task.id} 房间=${roomName}(${roomId}) 快照轮数=${successRounds} ` +
        `座位映射=${seats.map((s) => `${s.title}→${s.seatId}`).join(',')} ` +
        `未解析=${unresolvedTitles.join(',') || '-'} ` +
        (cacheFilled.length > 0 ? `缓存回填=${cacheFilled.join(',')} ` : '') +
        `自动挑房=${autoPickedRoom}`,
    );
    return { entry };
  }

  /** 读取未过期的缓存条目 */
  get(taskId: string): PreparseEntry | null {
    const entry = this.cache.get(taskId);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.resolvedAt > CACHE_TTL_MS) {
      this.cache.delete(taskId);
      return null;
    }
    return entry;
  }

  /** 任务终态后清理缓存 */
  invalidate(taskId: string): void {
    this.cache.delete(taskId);
  }

  /**
   * search 全部失败/房间目录缺失时的最后手段：
   * 凭持久化缓存（账号→userInfoId、房间+座位号→seatId）组装盲抢参数。
   * 组装不出来才返回 failReason（调用方回退 search-first）
   */
  private async buildEntryFromCache(
    task: GrabTask,
    failReason: string,
  ): Promise<PreparseOutcome> {
    const preferences = task.seatPreference ?? [];
    if (!task.roomId || preferences.length === 0) {
      return { entry: null, failReason };
    }
    const userInfoId = await this.seatMappingCache.getUserInfoId(
      task.accountId,
    );
    if (!userInfoId) {
      this.logger.warn(
        `[预解析失败] taskId=${task.id} ${failReason}，且无历史预约人缓存可兜底`,
      );
      return { entry: null, failReason };
    }
    const cached = await this.seatMappingCache.findSeatIds(
      task.roomId,
      preferences,
    );
    const seats: PreparsedSeat[] = [];
    const unresolvedTitles: string[] = [];
    for (const title of preferences) {
      const seatId = cached.get(title);
      if (seatId) {
        seats.push({ title, seatId });
      } else {
        unresolvedTitles.push(title);
      }
    }
    if (seats.length === 0) {
      this.logger.warn(
        `[预解析失败] taskId=${task.id} ${failReason}，且无历史座位映射可兜底`,
      );
      return { entry: null, failReason };
    }
    const entry: PreparseEntry = {
      taskId: task.id,
      accountId: task.accountId,
      userInfoId,
      roomId: task.roomId,
      roomName: task.roomName ?? '',
      seats,
      unresolvedTitles,
      autoPickedRoom: false,
      resolvedAt: Date.now(),
    };
    this.storeEntry(task.id, entry);
    this.logger.warn(
      `[预解析缓存兜底] taskId=${task.id} search 不可用（${failReason}），` +
        `凭历史 seatId 缓存组装盲抢参数: ${seats
          .map((s) => `${s.title}→${s.seatId}`)
          .join(',')}`,
    );
    return { entry };
  }

  /**
   * 合并多轮 search 的房间目录：同 roomId 的座位按 seatId 取并集。
   * 状态冲突时以空闲(state=0)为准——宁可多试一次被弹回的预约，也不藏起可用座位
   */
  private mergeRoomCatalog(
    base: RoomSeats[],
    incoming: RoomSeats[],
  ): RoomSeats[] {
    if (base.length === 0) {
      return incoming.map((r) => ({ ...r, seats: [...r.seats] }));
    }
    const byId = new Map(base.map((r) => [r.id, r]));
    for (const room of incoming) {
      const existing = byId.get(room.id);
      if (!existing) {
        const copy: RoomSeats = { ...room, seats: [...room.seats] };
        byId.set(room.id, copy);
        base.push(copy);
        continue;
      }
      const knownSeats = new Map(existing.seats.map((s) => [s.id, s]));
      for (const seat of room.seats) {
        const known = knownSeats.get(seat.id);
        if (!known) {
          knownSeats.set(seat.id, seat);
          existing.seats.push(seat);
        } else if (known.state !== 0 && seat.state === 0) {
          known.state = 0;
        }
      }
      if (!existing.name && room.name) {
        existing.name = room.name;
      }
    }
    return base;
  }

  /** 写进程内缓存，顺带 TTL 兜底清扫 */
  private storeEntry(taskId: string, entry: PreparseEntry): void {
    // 终态主动清理（worker finally）覆盖不到"预检写缓存后任务
    // 在 pending 阶段被取消/覆盖而从未执行"的路径，在每次写入新缓存前清扫
    // 已过期条目，防止进程内缓存随历史任务缓慢增长
    for (const [cachedTaskId, cached] of this.cache) {
      if (Date.now() - cached.resolvedAt > CACHE_TTL_MS) {
        this.cache.delete(cachedTaskId);
      }
    }
    this.cache.set(taskId, entry);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 房间锁定与座位号解析规则：
   * 1. 任务指定 roomId：严格在该房间内解析；房间不在目录中 → 返回空 roomId（回退）
   * 2. 未指定：逐个座位号找包含它的房间；
   *    - 唯一房间 → 直接锁定
   *    - 多房间同名 → 优先推荐房间（data.info），否则取第一个并标记 autoPickedRoom
   * 3. 所有座位号均无法解析到任何房间 → 返回空 roomId（回退）
   */
  private resolvePreferenceSeats(
    rooms: RoomSeats[],
    recommendedRoomId: string,
    task: GrabTask,
  ): {
    roomId: string;
    roomName: string;
    seats: PreparsedSeat[];
    unresolvedTitles: string[];
    autoPickedRoom: boolean;
  } {
    const preferences = task.seatPreference ?? [];
    const empty = {
      roomId: '',
      roomName: '',
      seats: [] as PreparsedSeat[],
      unresolvedTitles: preferences,
      autoPickedRoom: false,
    };

    if (rooms.length === 0) {
      return empty;
    }

    // 情形 1：任务显式指定房间
    if (task.roomId) {
      const pinned = rooms.find((r) => r.id === task.roomId);
      if (!pinned) {
        return empty;
      }
      const seats: PreparsedSeat[] = [];
      const unresolvedTitles: string[] = [];
      for (const title of preferences) {
        const seat = pinned.seats.find((s) => s.title === title);
        if (seat) {
          seats.push({ title, seatId: seat.id });
        } else {
          unresolvedTitles.push(title);
        }
      }
      return {
        roomId: pinned.id,
        roomName: pinned.name,
        seats,
        unresolvedTitles,
        autoPickedRoom: false,
      };
    }

    // 情形 2：自动挑房
    // 候选房间 = 包含全部偏好座位号的房间；不存在时退化为包含任一座位号的房间
    let candidates = rooms.filter((r) =>
      preferences.every((t) => r.seats.some((s) => s.title === t)),
    );
    if (candidates.length === 0) {
      candidates = rooms.filter((r) =>
        preferences.some((t) => r.seats.some((s) => s.title === t)),
      );
    }
    if (candidates.length === 0) {
      return empty;
    }

    // 多候选时优先推荐房间（服务端当前 data.info 指向的房间），否则取第一个
    let autoPickedRoom = false;
    let picked = candidates.find((r) => r.id === recommendedRoomId);
    if (!picked) {
      picked = candidates[0];
      autoPickedRoom = candidates.length > 1;
    } else if (candidates.length > 1) {
      autoPickedRoom = true;
    }

    const seats: PreparsedSeat[] = [];
    const unresolvedTitles: string[] = [];
    for (const title of preferences) {
      const seat = picked.seats.find((s) => s.title === title);
      if (seat) {
        seats.push({ title, seatId: seat.id });
      } else {
        unresolvedTitles.push(title);
      }
    }
    return {
      roomId: picked.id,
      roomName: picked.name,
      seats,
      unresolvedTitles,
      autoPickedRoom,
    };
  }
}
