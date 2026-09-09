import { SeatPreparseService } from './seat-preparse.service';
import { HduLibraryClientService } from '../hdu-library/hdu-library-client.service';
import type { SeatMappingCacheService } from './seat-mapping-cache.service';
import type { GrabTask } from '../grab-task/entities/grab-task.entity';

/** 与 seat-preparse.service.ts 内的 CACHE_TTL_MS 保持一致 */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 构造持久化缓存服务 mock（默认空缓存：查不到任何历史映射） */
function makeCacheMocks(overrides: Record<string, jest.Mock> = {}) {
  return {
    findSeatIds: jest.fn().mockResolvedValue(new Map()),
    saveSeatMappings: jest.fn().mockResolvedValue(undefined),
    getUserInfoId: jest.fn().mockResolvedValue(null),
    saveUserInfoId: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('SeatPreparseService 缓存生命周期', () => {
  let service: SeatPreparseService;
  let searchSeats: jest.Mock;

  const makeTask = (id: string): GrabTask =>
    ({
      id,
      accountId: 'acc-1',
      categoryId: '591',
      contentId: '3',
      roomId: 'room-1',
      roomName: '三楼自习室',
      beginTime: 1700000000,
      duration: 7200,
      seatPreference: ['001'],
      strictMode: true,
      triggerAt: 1700000300,
      status: 'pending',
      attempts: 0,
      result: null,
    }) as GrabTask;

  const seat = () => ({
    id: 'seat-001',
    title: '001',
    state: 0,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    hasSocket: false,
  });

  const makeSearchResult = () => ({
    room: { id: 'room-1', name: '三楼自习室', plan: '', width: 0, height: 0 },
    seats: [seat()],
    recommendedSeats: [],
    allRooms: [{ id: 'room-1', name: '三楼自习室', seats: [seat()] }],
    userInfoId: 'user-1',
    rawUiType: 'test',
  });

  /** 直接访问进程内缓存（测试 TTL 清扫用） */
  const cache = (): Map<string, { resolvedAt: number }> =>
    (service as any).cache as Map<string, { resolvedAt: number }>;

  beforeEach(() => {
    searchSeats = jest.fn().mockResolvedValue(makeSearchResult());
    service = new SeatPreparseService(
      { searchSeats } as unknown as HduLibraryClientService,
      makeCacheMocks() as unknown as SeatMappingCacheService,
    );
  });

  it('preparse 成功后写入缓存，get 可读取未过期条目', async () => {
    const outcome = await service.preparse(makeTask('task-a'));

    expect(outcome.entry).not.toBeNull();
    expect(outcome.entry!.seats).toEqual([
      { title: '001', seatId: 'seat-001' },
    ]);
    expect(cache().has('task-a')).toBe(true);
    expect(service.get('task-a')?.seats[0].seatId).toBe('seat-001');
  });

  it('Case 5: preparse 写入新缓存前清扫已过期条目', async () => {
    await service.preparse(makeTask('task-a'));
    expect(cache().has('task-a')).toBe(true);

    // 将 task-a 的条目回拨为已过期
    cache().get('task-a')!.resolvedAt = Date.now() - CACHE_TTL_MS - 1;

    await service.preparse(makeTask('task-b'));

    expect(cache().has('task-a')).toBe(false);
    expect(cache().has('task-b')).toBe(true);
  });

  it('TTL 清扫不会删除未过期条目', async () => {
    await service.preparse(makeTask('task-a'));
    await service.preparse(makeTask('task-b'));

    // task-a / task-b 均在有效期内，不应被清扫
    expect(cache().has('task-a')).toBe(true);
    expect(cache().has('task-b')).toBe(true);
    expect(service.get('task-a')).not.toBeNull();
    expect(service.get('task-b')).not.toBeNull();
  });

  it('get 对已过期条目返回 null 并惰性删除（原行为保持不变）', async () => {
    await service.preparse(makeTask('task-a'));
    cache().get('task-a')!.resolvedAt = Date.now() - CACHE_TTL_MS - 1;

    expect(service.get('task-a')).toBeNull();
    expect(cache().has('task-a')).toBe(false);
  });

  it('invalidate 删除指定任务的缓存条目', async () => {
    await service.preparse(makeTask('task-a'));
    expect(cache().has('task-a')).toBe(true);

    service.invalidate('task-a');

    expect(cache().has('task-a')).toBe(false);
    expect(service.get('task-a')).toBeNull();
  });

  it('invalidate 对不存在的 taskId 是安全的 no-op', () => {
    expect(() => service.invalidate('not-exist')).not.toThrow();
  });
});

/**
 * 多快照合并与持久化缓存兜底（9/7 六楼事故回归）：
 * 单次 search 快照可能因分区块返回缺失目标座位（同秒两次 220 vs 424 座），
 * 预解析必须多轮取并集；快照持续缺失时用持久化 seatId 缓存回填；
 * search 全部失败时整体退化为缓存组装，而不是直接判失败。
 */
describe('SeatPreparseService 多快照合并与缓存兜底', () => {
  let service: SeatPreparseService;
  let searchSeats: jest.Mock;
  let cacheMocks: ReturnType<typeof makeCacheMocks>;

  const makeTask = (overrides: Partial<GrabTask> = {}): GrabTask =>
    ({
      id: 'task-1',
      accountId: 'acc-1',
      categoryId: '591',
      contentId: '3',
      roomId: 'room-1',
      roomName: '六楼阅览室',
      beginTime: 1700000000,
      duration: 50400,
      seatPreference: ['204'],
      strictMode: true,
      triggerAt: 1700000300,
      status: 'pending',
      attempts: 0,
      result: null,
      ...overrides,
    }) as GrabTask;

  const seat = (title: string, id: string) => ({
    id,
    title,
    state: 0,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    hasSocket: false,
  });

  const makeSearchResult = (roomSeats: any[]) => ({
    room: { id: 'room-1', name: '六楼阅览室', plan: '', width: 0, height: 0 },
    seats: roomSeats,
    recommendedSeats: [],
    allRooms: [{ id: 'room-1', name: '六楼阅览室', seats: roomSeats }],
    userInfoId: 'user-1',
    rawUiType: 'test',
  });

  const buildService = (cacheOverrides?: Record<string, jest.Mock>) => {
    cacheMocks = makeCacheMocks(cacheOverrides);
    service = new SeatPreparseService(
      { searchSeats } as unknown as HduLibraryClientService,
      cacheMocks as unknown as SeatMappingCacheService,
    );
  };

  beforeEach(() => {
    searchSeats = jest.fn().mockResolvedValue(makeSearchResult([]));
  });

  it('P1: 首轮快照缺目标座位 —— 多轮并集后解析成功，不再发第三轮', async () => {
    searchSeats
      .mockResolvedValueOnce(makeSearchResult([]))
      .mockResolvedValueOnce(makeSearchResult([seat('204', 'seat-63102')]));
    buildService();

    const outcome = await service.preparse(makeTask());

    expect(searchSeats).toHaveBeenCalledTimes(2);
    expect(outcome.entry).not.toBeNull();
    expect(outcome.entry!.seats).toEqual([{ title: '204', seatId: 'seat-63102' }]);
    expect(outcome.entry!.unresolvedTitles).toEqual([]);
  });

  it('P2: 三轮快照全缺目标座位 —— 用持久化缓存回填，回填映射按偏好顺序归位', async () => {
    // 快照只出现 205；204 靠缓存回填
    searchSeats.mockResolvedValue(makeSearchResult([seat('205', 'seat-63103')]));
    buildService({
      findSeatIds: jest
        .fn()
        .mockResolvedValue(new Map([['204', 'seat-63102']])),
    });

    const outcome = await service.preparse(
      makeTask({ seatPreference: ['204', '205'] }),
    );

    expect(searchSeats).toHaveBeenCalledTimes(3);
    expect(cacheMocks.findSeatIds).toHaveBeenCalledWith('room-1', ['204']);
    expect(outcome.entry!.seats).toEqual([
      { title: '204', seatId: 'seat-63102' },
      { title: '205', seatId: 'seat-63103' },
    ]);
    expect(outcome.entry!.unresolvedTitles).toEqual([]);
    // 本轮确认的映射（含回填项）落持久化缓存
    expect(cacheMocks.saveSeatMappings).toHaveBeenCalledWith(
      'room-1',
      '六楼阅览室',
      [
        { title: '204', seatId: 'seat-63102' },
        { title: '205', seatId: 'seat-63103' },
      ],
    );
  });

  it('P3: search 全部失败 —— 凭持久化缓存组装盲抢参数', async () => {
    searchSeats.mockRejectedValue(new Error('timeout of 8000ms exceeded'));
    buildService({
      getUserInfoId: jest.fn().mockResolvedValue('user-9'),
      findSeatIds: jest
        .fn()
        .mockResolvedValue(new Map([['204', 'seat-63102']])),
    });

    const outcome = await service.preparse(makeTask());

    expect(searchSeats).toHaveBeenCalledTimes(3);
    expect(outcome.entry).toMatchObject({
      userInfoId: 'user-9',
      roomId: 'room-1',
      seats: [{ title: '204', seatId: 'seat-63102' }],
      unresolvedTitles: [],
    });
    // 缓存兜底组装的条目同样写入进程内缓存供 worker 读取
    expect(service.get('task-1')).not.toBeNull();
  });

  it('P4: search 全部失败且无历史缓存 —— 返回失败原因，交由 worker 回退', async () => {
    searchSeats.mockRejectedValue(new Error('network boom'));
    buildService();

    const outcome = await service.preparse(makeTask());

    expect(outcome.entry).toBeNull();
    expect(outcome.failReason).toContain('座位搜索失败');
    expect(service.get('task-1')).toBeNull();
  });
});
