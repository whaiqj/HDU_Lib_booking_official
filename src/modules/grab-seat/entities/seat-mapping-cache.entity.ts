import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';

/**
 * 座位号 → seatId 持久化映射缓存
 * seatId 跨天稳定（预解析设计前提），解析成功一次即可长期复用：
 * 即使某次 searchSeats 快照缺失目标座位（分区块波动/时段差异），
 * 盲抢仍能用历史映射直发 bookSeats
 */
@Entity('seat_mapping_cache')
@Unique(['roomId', 'title'])
export class SeatMappingCache {
  @PrimaryGeneratedColumn()
  id: number;

  /** 房间 ID（同座位号在不同房间是不同 seatId，必须按房间隔离） */
  @Column({ type: 'varchar', length: 64 })
  roomId: string;

  /** 座位号（用户输入的 title） */
  @Column({ type: 'varchar', length: 64 })
  title: string;

  /** 系统内部座位 ID */
  @Column({ type: 'varchar', length: 64 })
  seatId: string;

  /** 房间名称（冗余，便于排查） */
  @Column({ type: 'varchar', length: 128, nullable: true })
  roomName: string | null;

  @UpdateDateColumn()
  updatedAt: Date;
}
