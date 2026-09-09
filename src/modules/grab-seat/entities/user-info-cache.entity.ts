import {
  Entity,
  Column,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 账号 → 图书馆内部预约人 id（userInfo.id）持久化缓存
 * userInfo.id 是账号在第三方系统的内部用户 id，跨天稳定。
 * searchSeats 全部失败时，盲抢凭此缓存 + 座位映射缓存仍可组装完整预约参数
 */
@Entity('user_info_cache')
export class UserInfoCache {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  accountId: string;

  /** 图书馆内部预约人 id（bookSeats 的 seatBookers[0]） */
  @Column({ type: 'varchar', length: 64 })
  userInfoId: string;

  @UpdateDateColumn()
  updatedAt: Date;
}
