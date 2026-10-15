import { of } from 'rxjs';
import { GrabSeatWorker } from './grab-seat-worker.service';
import { SeatPreparseService } from './seat-preparse.service';
import { HduLibraryClientService } from '../hdu-library/hdu-library-client.service';

describe('预约提速策略', () => {
  const originalOrder = process.env.GRAB_FIRST_FIRE_ACCOUNT_IDS;
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalOrder === undefined) delete process.env.GRAB_FIRST_FIRE_ACCOUNT_IDS;
    else process.env.GRAB_FIRST_FIRE_ACCOUNT_IDS = originalOrder;
  });

  function makeWorker() {
    const bookSeats = jest.fn().mockResolvedValue({ success: true });
    const entry = { roomId: '1559', roomName: '六楼', userInfoId: 'user', seats: [{ title: '209', seatId: '63105' }], unresolvedTitles: [] };
    const worker = new GrabSeatWorker(
      { bookSeats } as any, {} as any,
      { get: () => entry, invalidate() {} } as any,
      { updateStatus: async () => {}, incrementAttempts: async () => {}, isCancellationRequested: () => false } as any,
      {} as any, {} as any, {} as any, { notify: async () => {} } as any,
    );
    (worker as any).logger = { log() {}, warn() {}, debug() {}, error() {} };
    jest.spyOn(worker as any, 'writeAttemptLog').mockImplementation(() => {});
    jest.spyOn(worker as any, 'markSuccess').mockResolvedValue(undefined);
    return { worker, bookSeats };
  }

  it.each([['first', 3000], ['second', 3100], ['unlisted', 3000]])(
    '%s 账号准时首发且不带随机上浮', async (accountId, offset) => {
      const anchor = Date.UTC(2026, 9, 14, 12);
      jest.useFakeTimers({ now: anchor });
      jest.spyOn(Math, 'random').mockReturnValue(1);
      process.env.GRAB_FIRST_FIRE_ACCOUNT_IDS = 'first,second';
      const { worker, bookSeats } = makeWorker();
      const task = { id: 'task', accountId, strictMode: true, seatPreference: ['209'], triggerAt: anchor / 1000, beginTime: 1792108800, duration: 50400 };
      const promise = worker.executeGrab(task as any);
      await jest.advanceTimersByTimeAsync(offset - 1);
      expect(bookSeats).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(bookSeats).toHaveBeenCalledTimes(1);
      expect(bookSeats.mock.calls[0][0].seats).toEqual(['63105']);
      await promise;
    },
  );

  it('唤醒已晚于首发时刻时立即预约', async () => {
    const anchor = Date.UTC(2026, 9, 14, 12);
    jest.useFakeTimers({ now: anchor + 4000 });
    const { worker, bookSeats } = makeWorker();
    await worker.executeGrab({ id: 'late', accountId: 'first', strictMode: true, seatPreference: ['209'], triggerAt: anchor / 1000, beginTime: 1792108800, duration: 50400 } as any);
    expect(bookSeats).toHaveBeenCalledTimes(1);
  });

  it('其他账号慢响应不会将预约超时抬到 15 秒', async () => {
    const post = jest.fn().mockReturnValue(of({ status: 200, data: { DATA: { result: 'success' } } }));
    const client = new HduLibraryClientService({ post } as any, { getCredentials: () => ({ value: 'mock' }) } as any);
    (client as any).bookRttWindow.push(5854, 12000, 14000);
    const result = await client.bookSeats({ beginTime: 1792108800, duration: 50400, seats: ['63105'], is_recommend: 0, api_time: 1791979203, seatBookers: ['mock'] }, 'first', 'task');
    expect(result.success).toBe(true);
    expect(post.mock.calls[0][2].timeout).toBe(8000);
  });

  it.each([['cached-user', true], [null, false]])('快照缺预约人 ID 时缓存为 %s', async (cachedId, expectedReady) => {
    const searchSeats = jest.fn().mockResolvedValue({ room: { id: '1559', name: '六楼' }, seats: [{ id: '63105', title: '209' }], recommendedSeats: [], userInfoId: '' });
    const cache = { getUserInfoId: jest.fn().mockResolvedValue(cachedId), saveUserInfoId: jest.fn(), saveSeatMappings: jest.fn().mockResolvedValue(undefined), findSeatIds: jest.fn().mockResolvedValue(new Map()) };
    const preparse = new SeatPreparseService({ searchSeats } as any, cache as any);
    const result = await preparse.preparse({ id: 'task', accountId: 'first', roomId: '1559', roomName: '六楼', categoryId: '591', contentId: '3', seatPreference: ['209'], beginTime: 1792108800, duration: 50400 } as any);
    expect(Boolean(result.entry)).toBe(expectedReady);
    if (result.entry) {
      expect(result.entry.userInfoId).toBe(cachedId);
      expect(result.entry.seats).toEqual([{ title: '209', seatId: '63105' }]);
    }
    expect(cache.getUserInfoId).toHaveBeenCalledWith('first');
  });
});
