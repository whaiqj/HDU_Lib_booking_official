import { SeatMappingCacheService } from './seat-mapping-cache.service';
import type { SeatMappingCache } from './entities/seat-mapping-cache.entity';
import type { UserInfoCache } from './entities/user-info-cache.entity';

/** 与服务内 SEAT_MAPPING_FRESH_TTL_MS 保持一致（7 天） */
const FRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 构造 seat 仓库 mock */
function makeSeatRepo(overrides: Record<string, jest.Mock> = {}) {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((e: Partial<SeatMappingCache>) => e),
    save: jest.fn((e) => Promise.resolve(e)),
    ...overrides,
  };
}

/** 构造 user 仓库 mock */
function makeUserRepo(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((e: Partial<UserInfoCache>) => e),
    save: jest.fn((e) => Promise.resolve(e)),
    ...overrides,
  };
}

const makeRow = (overrides: Partial<SeatMappingCache> = {}): SeatMappingCache =>
  ({
    id: 1,
    roomId: 'room-1',
    title: '204',
    seatId: 'seat-63102',
    roomName: '六楼阅览室',
    updatedAt: new Date(),
    ...overrides,
  }) as SeatMappingCache;

describe('SeatMappingCacheService 座位映射新鲜度（V1/V2 防污染）', () => {
  let service: SeatMappingCacheService;
  let seatRepo: ReturnType<typeof makeSeatRepo>;
  let userRepo: ReturnType<typeof makeUserRepo>;

  beforeEach(() => {
    seatRepo = makeSeatRepo();
    userRepo = makeUserRepo();
    service = new SeatMappingCacheService(
      seatRepo as any,
      userRepo as any,
    );
  });

  it('findSeatIds 只返回新鲜映射，陈旧映射被过滤（陈旧数据不盲信）', async () => {
    seatRepo.find.mockResolvedValue([
      makeRow({ title: '204', seatId: 'seat-204', updatedAt: new Date() }),
      // 超过 7 天未再确认：视为陈旧，不得返回
      makeRow({
        title: '205',
        seatId: 'seat-205',
        updatedAt: new Date(Date.now() - FRESH_TTL_MS - DAY_MS),
      }),
    ]);

    const result = await service.findSeatIds('room-1', ['204', '205']);

    expect(seatRepo.find).toHaveBeenCalledWith({
      where: { roomId: 'room-1', title: expect.objectContaining({ _value: ['204', '205'] }) },
    });
    expect(result.has('204')).toBe(true);
    expect(result.get('204')).toBe('seat-204');
    expect(result.has('205')).toBe(false);
  });

  it('findSeatIds 空参数/空标题 直接返回空集，不发查询', async () => {
    expect(await service.findSeatIds('', ['204'])).toEqual(new Map());
    expect(await service.findSeatIds('room-1', [])).toEqual(new Map());
    expect(seatRepo.find).not.toHaveBeenCalled();
  });

  it('findSeatIds 查询异常被吞掉并返回空集，不阻断主流程', async () => {
    seatRepo.find.mockRejectedValue(new Error('db boom'));
    const result = await service.findSeatIds('room-1', ['204']);
    expect(result).toEqual(new Map());
  });

  it('saveSeatMappings 首次写入：新增映射', async () => {
    seatRepo.findOne.mockResolvedValue(null);

    await service.saveSeatMappings('room-1', '六楼阅览室', [
      { title: '204', seatId: 'seat-204' },
    ]);

    expect(seatRepo.create).toHaveBeenCalledWith({
      roomId: 'room-1',
      title: '204',
      seatId: 'seat-204',
      roomName: '六楼阅览室',
    });
    expect(seatRepo.save).toHaveBeenCalledTimes(1);
  });

  it('saveSeatMappings 同值确认：刷新新鲜度（updatedAt），不报异常', async () => {
    const existing = makeRow({ seatId: 'seat-204', roomName: '旧房间名' });
    seatRepo.findOne.mockResolvedValue(existing);

    await service.saveSeatMappings('room-1', '六楼阅览室', [
      { title: '204', seatId: 'seat-204' },
    ]);

    // 同值：更新 roomName 并 save 以刷新 updatedAt，保持映射"新鲜"
    expect(existing.roomName).toBe('六楼阅览室');
    expect(seatRepo.save).toHaveBeenCalledWith(existing);
  });

  it('saveSeatMappings 映射变更：保留旧值不覆盖，绝不把可疑 seatId 永久写库', async () => {
    const existing = makeRow({ seatId: 'seat-OLD' });
    seatRepo.findOne.mockResolvedValue(existing);

    await service.saveSeatMappings('room-1', '六楼阅览室', [
      { title: '204', seatId: 'seat-NEW' },
    ]);

    // 旧值未被覆盖，seatId 仍是 seat-OLD
    expect(existing.seatId).toBe('seat-OLD');
    expect(seatRepo.save).not.toHaveBeenCalled();
  });

  it('saveSeatMappings 写入异常被吞掉并仅告警', async () => {
    seatRepo.findOne.mockRejectedValue(new Error('db boom'));
    await expect(
      service.saveSeatMappings('room-1', '六楼阅览室', [
        { title: '204', seatId: 'seat-204' },
      ]),
    ).resolves.toBeUndefined();
  });

  it('saveSeatMappings 空参数/空座位列表 直接 no-op', async () => {
    await service.saveSeatMappings('', 'x', [{ title: '204', seatId: 's' }]);
    await service.saveSeatMappings('room-1', 'x', []);
    expect(seatRepo.findOne).not.toHaveBeenCalled();
  });

  it('userInfoId 缓存：查询/写入/变更覆盖', async () => {
    userRepo.findOne.mockResolvedValue(null);
    await service.saveUserInfoId('acc-1', 'user-9');
    expect(userRepo.save).toHaveBeenCalledTimes(1);

    userRepo.findOne.mockResolvedValue({ accountId: 'acc-1', userInfoId: 'user-old' });
    await service.saveUserInfoId('acc-1', 'user-new');
    expect(userRepo.save).toHaveBeenCalledTimes(2);

    userRepo.findOne.mockResolvedValue({ accountId: 'acc-1', userInfoId: 'user-9' });
    expect(await service.getUserInfoId('acc-1')).toBe('user-9');
  });
});