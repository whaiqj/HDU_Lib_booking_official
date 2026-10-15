import { Injectable, Inject, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'node:crypto';
import { SearchSeatsParams } from './dto/search-seats-params.dto';
import {
  SearchSeatsResult,
  SeatInfo,
  RoomInfo,
  RoomSeats,
} from './dto/search-seats-result.dto';
import { BookSeatsParams } from './dto/book-seats-params.dto';
import { BookSeatsResult } from './dto/book-seats-result.dto';
import { BookErrorCode } from './errors/book-error-code.enum';
import { classifyError } from './errors/error-classifier';
import type { IAuthKeeperService } from '../session/auth-keeper.service';
import { LIBRARY_API } from '../../common/constants/api-endpoints';
import { buildFormBody, FORM_CONTENT_TYPE } from '../../common/utils/form-urlencoded.util';
import type { AppointmentMessageItem } from './dto/appoint-messages.dto';
import type { BookingMatchQuery, VerifiedBooking } from './dto/verified-booking.dto';
import { bookTimeoutStage, createBookTransportTrace } from './book-transport-trace';

/**
 * 明确登录失效错误
 * 仅在以下两种场景抛出（严格保守判定，其余异常一律不抛此错误）：
 * 1. 接口明确返回 is_login = false
 * 2. 3xx 重定向且 Location 包含 sso.hdu.edu.cn / login 登录页
 */
export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

/**
 * bookSeats 的 Api-Token 签名：base64(md5(canonical_string))
 * canonical 串的字段名与顺序必须与前端 app.es6.min.js 完全一致
 */
function signBookToken(params: BookSeatsParams): string {
  const seatBookersPart = params.seatBookers
    .map((x, i) => `seatBookers[${i}]${x}`)
    .join('&');
  const seatsPart = params.seats.map((x, i) => `seats[${i}]${x}`).join('&');
  const canonical =
    `post&${LIBRARY_API.BOOK_SEATS}` +
    `&api_time${params.api_time}` +
    `&beginTime${params.beginTime}` +
    `&duration${params.duration}` +
    `&is_recommend${params.is_recommend}` +
    `&${seatBookersPart}` +
    `&${seatsPart}`;
  const md5Hex = crypto.createHash('md5').update(canonical, 'utf8').digest('hex');
  return Buffer.from(md5Hex, 'utf8').toString('base64');
}

/**
 * 图书馆底层 API 客户端
 * 封装 searchSeats / bookSeats 接口，负责：
 * 1. 发 HTTP 请求（form-urlencoded 编码 + 自动附带登录凭证 Cookie + Api-Token 签名）
 * 2. 将第三方 data.info / data.POIs 结构 → 内部 DTO
 * 3. 标准化错误分类
 */
@Injectable()
export class HduLibraryClientService {
  private readonly logger = new Logger(HduLibraryClientService.name);
  private baseUrl: string;

  // RTT 滑动窗口：search 和 book 是两种量级的耗时分布，分开追踪，避免互相污染估计值
  private readonly searchRttWindow: number[] = [];
  private readonly bookRttWindow: number[] = [];
  private readonly bookRequestSequence = new Map<string, number>();
  private readonly messageRttWindow: number[] = [];
  private readonly RTT_WINDOW_SIZE = 5;
  private readonly MIN_TIMEOUT_MS = 8_000;   // search/message 硬下限 8 秒
  private readonly MAX_TIMEOUT_MS = 15_000;  // 硬上限 15 秒
  private readonly RTT_MULTIPLIER = 3;       // RTT 倍数（search/message）
  /** 预约固定等待 8 秒；跨账号历史 RTT 不再拉长后续预约等待。超时结果仍未知。 */
  private readonly BOOK_TIMEOUT_MS = 8_000;

  constructor(
    private readonly httpService: HttpService,
    @Inject('IAuthKeeperService')
    private readonly authKeeper: IAuthKeeperService,
  ) {
    this.baseUrl =
      process.env.LIBRARY_API_BASE_URL ?? 'https://hdu.huitu.zhishulib.com';
  }

  /** 记录一次 RTT 样本到指定滑动窗口 */
  private recordRtt(window: number[], ms: number): void {
    window.push(ms);
    if (window.length > this.RTT_WINDOW_SIZE) {
      window.shift();
    }
  }

  /**
   * 从滑动窗口计算自适应超时：max(中位数 × 倍数, 下限)，硬上限 MAX_TIMEOUT_MS。
   * 用于 search/message；book 使用独立固定 8 秒超时。
   */
  private computeAdaptiveTimeout(
    window: number[],
    minTimeoutMs: number = this.MIN_TIMEOUT_MS,
    rttMultiplier: number = this.RTT_MULTIPLIER,
  ): number {
    if (window.length === 0) {
      return minTimeoutMs; // 冷启动
    }
    const sorted = [...window].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return Math.min(
      Math.max(median * rttMultiplier, minTimeoutMs),
      this.MAX_TIMEOUT_MS,
    );
  }

  /**
   * 查询可用座位
   * 发起 HTTP 请求，将第三方 data.info / data.POIs 结构拍平为 SearchSeatsResult DTO
   */
  async searchSeats(params: SearchSeatsParams, accountId: string, taskId: string): Promise<SearchSeatsResult> {
    // 调试日志：打印实际发出的 beginTime 及对应北京时间（debug 级别，生产默认不输出）
    const beginTimeBeijing = new Date(params.beginTime * 1000).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    this.logger.debug(
      `taskId=${taskId} [searchSeats 请求参数] beginTime=${params.beginTime} (北京时间: ${beginTimeBeijing}) ` +
      `duration=${params.duration} category_id=${params.space_category.category_id} ` +
      `content_id=${params.space_category.content_id}`,
    );

    const searchStartMs = Date.now();
    const response = await firstValueFrom(
      this.httpService.post(
        `${this.baseUrl}${LIBRARY_API.SEARCH_SEATS}`,
        buildFormBody(params),
        {
          headers: {
            ...this.getAuthHeaders(accountId),
            'Content-Type': FORM_CONTENT_TYPE,
          },
          timeout: this.computeAdaptiveTimeout(this.searchRttWindow),
        },
      ),
    );
    this.recordRtt(this.searchRttWindow, Date.now() - searchStartMs);

    const raw = response.data;

    // 调试日志：降噪，只打印摘要（seats总数 / available数 / recommended数）
    const seatsTotal = raw?.data?.POIs?.length ?? 0;
    const availableCount = raw?.data?.POIs?.filter((p: any) => p.state === 0).length ?? 0;
    const recommendedCount = raw?.data?.bestPairSeats?.seats?.filter((s: any) => s.recommend === true).length ?? 0;
    this.logger.debug(
      `taskId=${taskId} [searchSeats 响应摘要] seats总数=${seatsTotal} available数=${availableCount} recommended数=${recommendedCount}`,
    );

    // 错误响应识别：ui_type === "com.Message" 表示第三方返回的是消息提示（如"预约人数过多"）
    // 不是正常的座位列表数据，应作为业务错误抛出
    if (raw?.ui_type === 'com.Message') {
      const msg = raw?.MESSAGE ?? raw?.DATA?.MESSAGE ?? '未知错误';
      const code = raw?.CODE;
      this.logger.warn(`taskId=${taskId} [searchSeats 返回业务错误] CODE=${code} MESSAGE=${msg}`);
      const err = new Error(`searchSeats 业务错误: ${msg} (CODE=${code})`);
      (err as any).code = code;
      (err as any).message = msg;
      (err as any).isBusinessError = true;
      throw err;
    }

    return this.transformSearchResponse(raw);
  }

  /**
   * 提交预约
   * 返回标准化结果
   */
  async bookSeats(params: BookSeatsParams, accountId: string, taskId: string): Promise<BookSeatsResult> {
    // Only non-secret parameters are logged; Cookie, Api-Token and userInfoId stay out of diagnostics.
    this.logger.debug(
      `taskId=${taskId} [bookSeats 请求参数] beginTime=${params.beginTime} ` +
      `duration=${params.duration} seats=${params.seats.join(',')} api_time=${params.api_time}`,
    );

    const timeoutSamplesMs = [...this.bookRttWindow];
    const requestSeq = (this.bookRequestSequence.get(taskId) ?? 0) + 1;
    this.bookRequestSequence.set(taskId, requestSeq);
    const timeoutMs = this.BOOK_TIMEOUT_MS;
    const diagnostic = createBookTransportTrace();
    const startedAtMs = Date.now();
    const emitTrace = (outcome: string, httpStatus?: number, applicationCode?: unknown, errorCode?: unknown) => {
      const safeCode = (value: unknown) =>
        String(value ?? '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || null;
      this.logger.log(JSON.stringify({
        event: 'book_transport',
        taskId,
        accountId,
        requestSeq,
        seatId: params.seats[0] ?? null,
        startedAtMs,
        durationMs: diagnostic.elapsedMs(),
        timeoutMs,
        timeoutSamplesMs,
        outcome,
        timeoutStage: outcome === 'transport_error' ? bookTimeoutStage(diagnostic.trace) : null,
        httpStatus: httpStatus ?? diagnostic.trace.httpStatus ?? null,
        applicationCode: safeCode(applicationCode),
        errorCode: safeCode(errorCode),
        ...diagnostic.trace,
      }));
    };
    try {
      const bookStartMs = Date.now();
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}${LIBRARY_API.BOOK_SEATS}`,
          buildFormBody(params),
          {
            headers: {
              ...this.getAuthHeaders(accountId),
              'Content-Type': FORM_CONTENT_TYPE,
              'Api-Token': signBookToken(params),
            },
            timeout: timeoutMs,
            transport: diagnostic.transport,
          },
        ),
      );
      this.recordRtt(this.bookRttWindow, Date.now() - bookStartMs);
      const raw = response.data;

      // 成功判定层级：DATA.result === 'success'（顶层无 result）
      if (raw?.DATA?.result === 'success') {
        emitTrace('success', response.status, raw?.CODE);
        this.logger.debug(`taskId=${taskId} [bookSeats 响应] code=success`);
        return {
          success: true,
          bookedSeatId: params.seats[0],
        };
      }

      // 分类错误
      const errorCode = this.classifyBookError(raw);
      const code = raw?.CODE ?? raw?.code ?? 'unknown';
      const message = raw?.MESSAGE ?? raw?.msg ?? '';
      this.logger.debug(`taskId=${taskId} [bookSeats 响应] code=${code}`);

      emitTrace('business_error', response.status, code, errorCode);

      return {
        success: false,
        errorCode,
        errorMessage: message,
      };
    } catch (error) {
      emitTrace(
        (error as any)?.response ? 'http_error' : 'transport_error',
        (error as any)?.response?.status,
        (error as any)?.response?.data?.CODE,
        (error as any)?.code,
      );
      // 网络异常
      const category = classifyError(null, error);
      let errorCode: BookErrorCode;
      switch (category) {
        case 'network':
          errorCode = BookErrorCode.NETWORK_ERROR;
          break;
        default:
          errorCode = BookErrorCode.UNKNOWN;
      }
      const message = error.message ?? 'Network error';
      this.logger.debug(`taskId=${taskId} [bookSeats 网络异常] errorCode=${errorCode}`);
      return {
        success: false,
        errorCode,
        errorMessage: message,
      };
    }
  }

  /**
   * 解析第三方 data.info / data.POIs 结构为内部 DTO
   * 同时提取 content 里内嵌的 userInfo.id（预约人内部 id）
   * 以及 allContent 里各房间的完整座位表（房间目录）
   */
  private transformSearchResponse(raw: any): SearchSeatsResult {
    const info = raw?.data?.info ?? {};
    const pois = raw?.data?.POIs ?? [];

    // 房间信息（data.info）
    const room: RoomInfo = {
      id: String(info.id ?? ''),
      name: String(info.title ?? ''),
      plan: String(info.plan ?? ''),
      width: Number(info.width ?? 0),
      height: Number(info.height ?? 0),
    };

    // 座位列表（data.POIs，have_socket → hasSocket，state 转数字）
    const seats: SeatInfo[] = pois.map((poi: any) => this.toSeatInfo(poi));

    // 推荐座位：取 data.bestPairSeats.seats 与 POIs 里 recommend=true 的 id
    const recommendedSeats: string[] = [];
    const recommendedIds = new Set<string>();
    const bestPairSeats = raw?.data?.bestPairSeats;
    if (Array.isArray(bestPairSeats?.seats)) {
      for (const s of bestPairSeats.seats) {
        if (s?.recommend === true && s?.id !== undefined) {
          recommendedIds.add(String(s.id));
          recommendedSeats.push(String(s.id));
        }
      }
    }
    for (const poi of pois) {
      if (
        poi?.recommend === true &&
        poi?.id !== undefined &&
        !recommendedIds.has(String(poi.id))
      ) {
        recommendedIds.add(String(poi.id));
        recommendedSeats.push(String(poi.id));
      }
    }

    // 双人推荐组合：data.bestPairSeats.seats 为一组
    let bestPairSeatsPairs: string[][] | undefined;
    if (Array.isArray(bestPairSeats?.seats)) {
      bestPairSeatsPairs = [bestPairSeats.seats.map((s: any) => String(s.id))];
    }

    return {
      room,
      seats,
      recommendedSeats,
      bestPairSeats: bestPairSeatsPairs,
      allRooms: this.extractAllRooms(raw, room, seats),
      userInfoId: this.extractUserInfoId(raw),
      rawUiType: String(raw?.ui_type ?? ''),
    };
  }

  /** 第三方 POI 节点 → 内部 SeatInfo（data.POIs 与各房间 seatMap.POIs 共用） */
  private toSeatInfo(poi: any): SeatInfo {
    return {
      id: String(poi.id ?? ''),
      title: String(poi.title ?? ''),
      state: Number(poi.state ?? 0),
      x: Number(poi.x ?? 0),
      y: Number(poi.y ?? 0),
      w: Number(poi.w ?? 0),
      h: Number(poi.h ?? 0),
      hasSocket:
        poi.have_socket === '1' ||
        poi.have_socket === 1 ||
        poi.have_socket === true,
    };
  }

  /**
   * 提取分类下所有房间的完整座位表：
   * 深搜 allContent（以及兜底整个响应）中形如 { info:{id,title}, POIs:[...] } 的房间块，
   * 同一 roomId 的所有区块按座位 id 取并集合并，并确保 data 指向的推荐房间也在目录里。
   *
   * 注意：搜索响应的"推荐房间"在多房间分类下会轮换，只有 allContent 才是稳定全量目录。
   * 合并背景（9/7 六楼事故）：部分房间（如六楼 1559）会被拆成多个区块返回，
   * 且 data.POIs 数量波动（同秒两次 220 vs 424）。旧实现"首个区块胜出"会丢弃
   * 后续区块的全部座位，导致目标座位号在房间目录中缺失、预解析失败。
   */
  private extractAllRooms(raw: any, dataRoom: RoomInfo, dataSeats: SeatInfo[]): RoomSeats[] {
    const roomsById = new Map<string, RoomSeats>();

    const visitRoomBlock = (block: any): void => {
      const roomId = String(block?.info?.id ?? '');
      if (!roomId) {
        return;
      }
      if (!Array.isArray(block?.POIs) || block.POIs.length === 0) {
        return;
      }
      const seats = block.POIs.map((poi: any) => this.toSeatInfo(poi));
      const existing = roomsById.get(roomId);
      if (!existing) {
        roomsById.set(roomId, {
          id: roomId,
          name: String(block.info.title ?? ''),
          seats,
        });
        return;
      }
      this.mergeSeatList(existing.seats, seats);
      if (!existing.name) {
        existing.name = String(block.info.title ?? '');
      }
    };

    const walk = (o: any): void => {
      if (!o || typeof o !== 'object') {
        return;
      }
      if (Array.isArray(o)) {
        o.forEach(walk);
        return;
      }
      if (o.info?.id !== undefined && Array.isArray(o.POIs)) {
        visitRoomBlock(o);
      }
      Object.values(o).forEach(walk);
    };

    // data（推荐房间）先入目录，再深搜 allContent 合并同房间其余区块、补齐其余房间。
    // 座位对象拷贝一份，避免并集合并反向污染顶层 searchResult.seats
    if (dataRoom.id && dataSeats.length > 0) {
      roomsById.set(dataRoom.id, {
        id: dataRoom.id,
        name: dataRoom.name,
        seats: dataSeats.map((s) => ({ ...s })),
      });
    }
    walk(raw?.allContent);
    return [...roomsById.values()];
  }

  /**
   * 将 incoming 座位并入 existing（按座位 id 去重）。
   * 同一座位在不同区块状态不一致时以空闲(state=0)为准：
   * 宁可多发一次会被 SEAT_TAKEN 弹回的预约，也不把可用座位藏起来
   */
  private mergeSeatList(existing: SeatInfo[], incoming: SeatInfo[]): void {
    const byId = new Map(existing.map((s) => [s.id, s]));
    for (const seat of incoming) {
      const known = byId.get(seat.id);
      if (!known) {
        byId.set(seat.id, seat);
        existing.push(seat);
      } else if (known.state !== 0 && seat.state === 0) {
        known.state = 0;
      }
    }
  }

  /**
   * 从响应中提取预约人内部 id（userInfo.id）
   * 优先从 DATA.uid 取（错误响应和正常响应都有这个字段）
   * 兜底：从 content.children 的 userInfo.id 深搜
   */
  private extractUserInfoId(raw: any): string {
    // 优先从 DATA.uid 取，这是最稳定的字段
    if (raw?.DATA?.uid) {
      return String(raw.DATA.uid);
    }

    let found = '';
    const walk = (o: any): void => {
      if (found || !o || typeof o !== 'object') return;
      if (Array.isArray(o)) {
        o.forEach(walk);
        return;
      }
      if (o.userInfo && o.userInfo.id !== undefined) {
        found = String(o.userInfo.id);
        return;
      }
      Object.values(o).forEach(walk);
    };
    walk(raw);
    return found;
  }

  /**
   * 分类 bookSeats 错误
   * 调用 classifyError 获取 ErrorCategory，映射为 BookErrorCode
   */
  private classifyBookError(raw: any): BookErrorCode {
    const category = classifyError(raw);

    switch (category) {
      case 'seat_unavailable':
        return BookErrorCode.SEAT_TAKEN;
      case 'already_booked':
        return BookErrorCode.ALREADY_BOOKED;
      case 'blacklist':
        return BookErrorCode.BLACKLISTED;
      case 'session_expired':
        return BookErrorCode.NOT_LOGIN;
      case 'network':
        return BookErrorCode.NETWORK_ERROR;
      case 'rate_limit':
        return BookErrorCode.RATE_LIMIT;
      case 'window_not_open':
        return BookErrorCode.WINDOW_NOT_OPEN;
      default:
        return BookErrorCode.UNKNOWN;
    }
  }

  /**
   * Read the account's own bookings and confirm a candidate through bookingInfo.
   * Both endpoints are GETs. A list card alone cannot establish the room or seat ID.
   * A missing match means "not confirmed", never "the timed-out booking failed".
   */
  async findMatchingBooking(accountId: string, query: BookingMatchQuery): Promise<VerifiedBooking | null> {
    const seatsById = new Map(query.seats.map((seat) => [seat.seatId, seat.title]));
    const wantedTitles = new Set(query.seats.map((seat) => seat.title));
    let path = '/Seat/Index/myBookingList?LAB_JSON=1';

    for (let page = 0; page < 2; page++) {
      const response = await firstValueFrom(this.httpService.get(`${this.baseUrl}${path}`, {
        headers: this.getAuthHeaders(accountId), timeout: 5_000, maxRedirects: 0,
      }));
      const raw = response.data;
      if (raw?.is_login === false || !Array.isArray(raw?.content?.defaultItems)) {
        throw new Error('myBookingList did not return an authenticated booking list');
      }

      for (const item of raw.content.defaultItems) {
        if (String(item?.status) !== '0' ||
            Number(item?.time) !== query.beginTime ||
            Number(item?.duration) !== query.duration ||
            !wantedTitles.has(String(item?.seatNum))) {
          continue;
        }
        const bookingId = String(item?.id ?? '');
        if (!/^\d+$/.test(bookingId)) continue;

        const detail = await firstValueFrom(this.httpService.get(
          `${this.baseUrl}/Seat/Index/bookingInfo?bookingId=${bookingId}&LAB_JSON=1`,
          { headers: this.getAuthHeaders(accountId), timeout: 5_000, maxRedirects: 0 },
        ));
        const booking = detail.data?.data?.booking;
        const seatId = String(booking?.seat?.id ?? '');
        if (detail.data?.data?.is_login === false ||
            String(booking?.id ?? '') !== bookingId ||
            String(booking?.status) !== '0' ||
            Number(booking?.begin_time) !== query.beginTime ||
            Number(booking?.duration) !== query.duration ||
            String(booking?.space?.id ?? '') !== query.roomId ||
            !seatsById.has(seatId) ||
            String(booking?.seat?.title ?? '') !== seatsById.get(seatId)) {
          continue;
        }
        return {
          bookingId, seatId, seatTitle: seatsById.get(seatId)!,
          roomId: query.roomId, beginTime: query.beginTime, duration: query.duration,
        };
      }

      const next = String(raw.content.defaultNextUrl ?? '');
      if (!/^\/Seat\/Index\/myBookingList\?(?:[A-Za-z0-9_=&%-]+)$/.test(next)) break;
      path = next;
    }
    return null;
  }

  /**
   * 获取图书馆预约消息列表（全量消息，不做过滤）
   *
   * Session 失效判定（严格保守，4.1 规则）：
   * - 仅当接口明确返回 is_login = false，或 3xx 重定向且 Location 指向 SSO 登录页时，
   *   抛出 SessionExpiredError（由上层决定是否刷新会话）
   * - 网络超时、5xx、普通 302 重定向（非登录页）、业务异常、数据为空等一切其他异常：
   *   仅打 warn 日志、返回空数组，绝不抛 SessionExpiredError，杜绝误刷新
   */
  async getAppointMessages(accountId: string): Promise<AppointmentMessageItem[]> {
    const messageStartMs = Date.now();
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}${LIBRARY_API.APPOINT_MESSAGES}`, {
          headers: {
            ...this.getAuthHeaders(accountId),
            Accept: 'application/json, text/plain, */*',
          },
          timeout: this.computeAdaptiveTimeout(this.messageRttWindow),
        }),
      );
      this.recordRtt(this.messageRttWindow, Date.now() - messageStartMs);

      const raw = response.data;

      // 保守判定：仅明确的 is_login = false 才视为登录失效
      if (raw?.is_login === false) {
        throw new SessionExpiredError(
          `appointMessages 明确返回 is_login=false accountId=${accountId}`,
        );
      }

      return this.transformAppointMessages(raw);
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        throw error;
      }

      const status = (error as any)?.response?.status;
      const location = String((error as any)?.response?.headers?.location ?? '');

      // 3xx 重定向：仅 Location 指向 SSO 登录页才判定为登录失效
      if (status >= 300 && status < 400) {
        if (
          location.includes('sso.hdu.edu.cn') ||
          location.toLowerCase().includes('login')
        ) {
          throw new SessionExpiredError(
            `appointMessages 3xx 跳转 SSO 登录页 accountId=${accountId} status=${status} location=${location}`,
          );
        }
        // 普通 302 重定向（非登录页）：保守处理，仅告警，不刷新会话
        this.logger.warn(
          `[appointMessages 普通 3xx 重定向·保守跳过] accountId=${accountId} status=${status} location=${location}`,
        );
        return [];
      }

      // 网络超时 / 5xx / 业务异常 / 未知异常：一律保守处理，仅告警，不刷新会话
      this.logger.warn(
        `[appointMessages 请求异常·保守跳过] accountId=${accountId} status=${status ?? 'N/A'} message=${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * 解析 appointMessages 响应为标准化消息数组
   * 字段存在性校验：消息列表字段缺失或非数组时返回空数组
   */
  private transformAppointMessages(raw: any): AppointmentMessageItem[] {
    const content = raw?.content;
    const items: any[] =
      content?.defaultItems ?? content?.items ?? content?.list ?? content?.data;

    if (!Array.isArray(items)) {
      this.logger.warn('[appointMessages 响应无消息列表字段，视为空消息]');
      return [];
    }

    return items.map((item: any) => {
      const url = String(item?.url ?? '');
      return {
        time: String(item?.time ?? ''),
        title: String(item?.title ?? ''),
        desc: String(item?.desc ?? ''),
        url,
        bookingId: this.extractBookingId(url),
      };
    });
  }

  /** 从消息 url 中提取 bookingId；无法提取时返回 null */
  private extractBookingId(url: string): string | null {
    const match = url.match(/bookingId=([^&]+)/);
    return match ? match[1] : null;
  }

  /**
   * 从 AuthKeeperService 获取凭证，构造请求头
   */
  private getAuthHeaders(accountId: string): Record<string, string> {
    const credential = this.authKeeper.getCredentials(accountId);
    if (!credential.value) {
      return {};
    }
    return { Cookie: credential.value };
  }
}
