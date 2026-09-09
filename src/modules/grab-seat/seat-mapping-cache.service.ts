import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SeatMappingCache } from './entities/seat-mapping-cache.entity';
import { UserInfoCache } from './entities/user-info-cache.entity';

/**
 * 座位映射"新鲜度"窗口：超过该时长未再被实时解析确认的映射视为陈旧，
 * 读取/缓存兜底时不再采用——宁可回退 search-first，也不拿可能已失效的 seatId 盲发（防污染）
 */
const SEAT_MAPPING_FRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 抢座静态参数持久化缓存
 * - (roomId, title) → seatId：seatId 跨天稳定，解析成功一次即可长期复用
 * - accountId → userInfoId：预约人内部 id
 *
 * 定位是"保险"而非主链路：一切读写失败都只告警、返回空，绝不阻断抢座流程。
 * 9/7 六楼事故：预解析把成败押在单次 search 快照上，快照缺座位则全盘退化；
 * 有了持久化映射，即使后续快照持续异常，盲抢仍能凭历史 seatId 直发 bookSeats
 */
@Injectable()
export class SeatMappingCacheService {
  private readonly logger = new Logger(SeatMappingCacheService.name);

  constructor(
    @InjectRepository(SeatMappingCache)
    private readonly seatRepo: Repository<SeatMappingCache>,
    @InjectRepository(UserInfoCache)
    private readonly userRepo: Repository<UserInfoCache>,
  ) {}

  /** 批量查询房间内座位号的历史 seatId；查不到/异常一律返回空结果 */
  async findSeatIds(
    roomId: string,
    titles: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!roomId || titles.length === 0) {
      return result;
    }
    try {
      const rows = await this.seatRepo.find({
        where: { roomId, title: In(titles) },
      });
      const freshCutoff = Date.now() - SEAT_MAPPING_FRESH_TTL_MS;
      for (const row of rows) {
        // V1 防污染：陈旧映射不返回，宁可视为缺失回退 search-first，也不盲发可能已失效的 seatId
        if (!row.updatedAt || row.updatedAt.getTime() < freshCutoff) {
          continue;
        }
        result.set(row.title, row.seatId);
      }
    } catch (e) {
      this.logger.warn(
        `[座位映射缓存查询失败·已忽略] roomId=${roomId} message=${(e as Error).message}`,
      );
    }
    return result;
  }

  /** 保存/更新座位映射（seatId 变化时以最新解析为准并告警） */
  async saveSeatMappings(
    roomId: string,
    roomName: string,
    seats: Array<{ title: string; seatId: string }>,
  ): Promise<void> {
    if (!roomId || seats.length === 0) {
      return;
    }
    for (const seat of seats) {
      try {
        const existing = await this.seatRepo.findOne({
          where: { roomId, title: seat.title },
        });
        if (existing) {
          if (existing.seatId !== seat.seatId) {
            // V1 防污染：seatId 跨天稳定，突变通常是第三方重排座位/解析异常。
            // 不无条件覆盖——保留旧值并升级为 error，避免把可疑映射永久写库后被跨天盲发
            this.logger.error(
              `[座位映射变更·保留旧值防污染] roomId=${roomId} title=${seat.title} ` +
                `旧=${existing.seatId} 新=${seat.seatId}（第三方系统可能重排了座位，请人工确认后清理缓存）`,
            );
            continue;
          }
          // 同值确认：刷新 updatedAt 保持"新鲜"，避免正确映射因长期未再确认而过期失效
          existing.roomName = roomName;
          await this.seatRepo.save(existing);
        } else {
          await this.seatRepo.save(
            this.seatRepo.create({
              roomId,
              title: seat.title,
              seatId: seat.seatId,
              roomName,
            }),
          );
        }
      } catch (e) {
        this.logger.warn(
          `[座位映射缓存写入失败·已忽略] roomId=${roomId} title=${seat.title} message=${(e as Error).message}`,
        );
      }
    }
  }

  /** 查询账号的历史预约人 id；查不到/异常返回 null */
  async getUserInfoId(accountId: string): Promise<string | null> {
    try {
      const row = await this.userRepo.findOne({ where: { accountId } });
      return row?.userInfoId ?? null;
    } catch (e) {
      this.logger.warn(
        `[预约人缓存查询失败·已忽略] accountId=${accountId} message=${(e as Error).message}`,
      );
      return null;
    }
  }

  /** 保存/更新账号的预约人 id */
  async saveUserInfoId(accountId: string, userInfoId: string): Promise<void> {
    if (!accountId || !userInfoId) {
      return;
    }
    try {
      const existing = await this.userRepo.findOne({ where: { accountId } });
      if (existing) {
        if (existing.userInfoId !== userInfoId) {
          existing.userInfoId = userInfoId;
          await this.userRepo.save(existing);
        }
      } else {
        await this.userRepo.save(
          this.userRepo.create({ accountId, userInfoId }),
        );
      }
    } catch (e) {
      this.logger.warn(
        `[预约人缓存写入失败·已忽略] accountId=${accountId} message=${(e as Error).message}`,
      );
    }
  }
}
