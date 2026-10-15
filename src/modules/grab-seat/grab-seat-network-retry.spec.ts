import { GrabSeatWorker, RETRY_CONFIG } from './grab-seat-worker.service';
import { BookErrorCode } from '../hdu-library/errors/book-error-code.enum';
import { TaskStatus } from '../grab-task/entities/grab-task.entity';
import { ErrorCategory } from '../hdu-library/errors/error-category.enum';

describe('盲抢网络重试的发布回归', () => {
  let worker: any;
  let task: any;
  let entry: any;
  let search: jest.Mock;
  let book: jest.Mock;
  let updateStatus: jest.Mock;
  let cancelled: jest.Mock;
  let findMatchingBooking: jest.Mock;

  const network = { success: false, errorCode: BookErrorCode.NETWORK_ERROR, errorMessage: 'timeout' };
  beforeEach(() => {
    jest.useFakeTimers({ now: 1800000000000 });
    search = jest.fn().mockRejectedValue(new Error('不可进入同步确认查询'));
    book = jest.fn().mockResolvedValue({ success: true });
    updateStatus = jest.fn().mockResolvedValue(undefined);
    cancelled = jest.fn().mockReturnValue(false);
    findMatchingBooking = jest.fn().mockResolvedValue(null);
    worker = new GrabSeatWorker(
      { searchSeats: search, bookSeats: book, findMatchingBooking } as any,
      {} as any, {} as any,
      { updateStatus, incrementAttempts: jest.fn().mockResolvedValue(undefined), isCancellationRequested: cancelled, findById: jest.fn().mockResolvedValue({ result: { preparse: { ok: true } } }), recordSeatTaken: jest.fn().mockResolvedValue(undefined) } as any,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      {} as any, { refreshSession: jest.fn() } as any,
      { notify: jest.fn().mockResolvedValue(undefined) } as any,
    );
    worker.logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    worker.sleepInterruptible = jest.fn().mockResolvedValue(false);
    worker.jitterMs = (ms: number) => ms;
    task = { id: 'regression-task', accountId: 'regression-account', beginTime: 1800000000, duration: 50400, categoryId: '591', contentId: '3', seatPreference: ['209'], strictMode: true, result: null };
    entry = { roomId: '1559', roomName: 'test', userInfoId: 'test-booker', seats: [{ seatId: 'test-seat', title: '209' }], unresolvedTitles: [] };
  });
  afterEach(() => jest.useRealTimers());
  const run = () => worker.executeBlindGrab(task, entry, Date.now() + RETRY_CONFIG.windowMs, Date.now(), Date.now());

  it('预约超时后不查询，原 800ms 网络退避后串行重试同座并可成功', async () => {
    book.mockResolvedValueOnce(network);
    await run();
    expect(search).not.toHaveBeenCalled();
    expect(book).toHaveBeenCalledTimes(2);
    expect(book.mock.calls.map((args) => args[0].seats)).toEqual([['test-seat'], ['test-seat']]);
    expect(worker.sleepInterruptible).toHaveBeenCalledWith(800, task.id);
    expect(updateStatus).toHaveBeenCalledWith(task.id, TaskStatus.SUCCESS, expect.objectContaining({ seatId: 'test-seat' }));
  });
  it('超时退避期间取消后不再次发送，不误报失败', async () => {
    book.mockResolvedValueOnce(network);
    worker.sleepInterruptible.mockResolvedValueOnce(true);
    await run();
    expect(book).toHaveBeenCalledTimes(1);
    expect(search).not.toHaveBeenCalled();
    expect(updateStatus).not.toHaveBeenCalled();
  });
  it('业务响应打断连续超时计数，零散超时不累计提前终止', async () => {
    for (let i = 0; i < 5; i++) {
      book.mockResolvedValueOnce(network).mockResolvedValueOnce({ success: false, errorCode: BookErrorCode.UNKNOWN, errorMessage: 'unknown business response' });
    }
    await run();
    expect(book).toHaveBeenCalledTimes(11);
    expect(search).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith(task.id, TaskStatus.SUCCESS, expect.anything());
  });
  it('五次连续超时终止，保留预解析现场和结果未知标记', async () => {
    book.mockResolvedValue(network);
    await run();
    expect(book).toHaveBeenCalledTimes(5);
    expect(search).not.toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith(task.id, TaskStatus.UNCERTAIN, expect.objectContaining({ reservationOutcomeUnknown: true, preparse: { ok: true } }));
  });
  it('超时后窗口耗尽仍标记结果未知，而不误报成功', async () => {
    book.mockResolvedValueOnce(network);
    worker.sleepInterruptible.mockImplementation(async () => { jest.setSystemTime(Date.now() + RETRY_CONFIG.windowMs); return false; });
    await run();
    expect(book).toHaveBeenCalledTimes(1);
    expect(updateStatus).toHaveBeenCalledWith(task.id, TaskStatus.UNCERTAIN, expect.objectContaining({ reservationOutcomeUnknown: true, failureCategory: 'timeout' }));
  });
  it('座位不可用仍轮转候选，不破坏备选座位成功路径', async () => {
    entry.seats.push({ seatId: 'fallback-seat', title: '207' });
    book.mockResolvedValueOnce({ success: false, errorCode: BookErrorCode.SEAT_TAKEN, errorMessage: 'seat unavailable' });
    await run();
    expect(book.mock.calls.map((args) => args[0].seats)).toEqual([['test-seat'], ['fallback-seat']]);
    expect(updateStatus).toHaveBeenCalledWith(task.id, TaskStatus.SUCCESS, expect.objectContaining({ seatId: 'fallback-seat' }));
  });
  it('超时后收到已有预约，核实为本任务座位即停止并记成功', async () => {
    book.mockResolvedValueOnce(network).mockResolvedValueOnce({
      success: false, errorCode: BookErrorCode.ALREADY_BOOKED, errorMessage: '已有预约，请勿重复预约',
    }).mockResolvedValue({ success: false, errorCode: BookErrorCode.ALREADY_BOOKED, errorMessage: '已有预约，请勿重复预约' });
    findMatchingBooking.mockResolvedValue({
      bookingId: '22877846', seatId: 'test-seat', seatTitle: '209',
      roomId: '1559', beginTime: task.beginTime, duration: task.duration,
    });
    await run();
    expect(book.mock.calls.length).toBeLessThanOrEqual(3);
    expect(findMatchingBooking).toHaveBeenCalledWith(task.accountId, expect.objectContaining({
      roomId: '1559', beginTime: task.beginTime,
      seats: [{ seatId: 'test-seat', title: '209' }],
    }));
    expect(updateStatus).toHaveBeenCalledWith(task.id, TaskStatus.SUCCESS, expect.objectContaining({
      seatId: 'test-seat', bookingId: '22877846', verificationSource: 'school_booking_list',
    }));
  });
  it('已有其它预约但学校记录不匹配，不误报本任务成功', async () => {
    book.mockResolvedValue({
      success: false, errorCode: BookErrorCode.ALREADY_BOOKED, errorMessage: '已有预约，请勿重复预约',
    });
    worker.sleepInterruptible.mockImplementation(async () => {
      jest.setSystemTime(Date.now() + RETRY_CONFIG.windowMs);
      return false;
    });
    await run();
    expect(findMatchingBooking).toHaveBeenCalled();
    expect(updateStatus).toHaveBeenCalledWith(task.id, TaskStatus.UNCERTAIN, expect.objectContaining({
      reservationOutcomeUnknown: true,
    }));
    expect(updateStatus).not.toHaveBeenCalledWith(task.id, TaskStatus.SUCCESS, expect.anything());
  });
  it('预解析失败走查座路径时，重复预约也能核实指定座位', async () => {
    task.strictMode = false;
    task.roomId = '1559';
    task.triggerAt = Math.floor(Date.now() / 1000);
    worker.tryGrabOnce = jest.fn().mockImplementation(async (_task: any, _taken: any, _round: any, attempted: Map<string, string>) => {
      attempted.set('test-seat', '209');
      return {
        success: false, errorCategory: ErrorCategory.ALREADY_BOOKED,
        errorMessage: '已有预约，请勿重复预约',
        timing: { searchStartMs: Date.now(), books: [{ seatId: 'test-seat', startMs: Date.now(), endMs: Date.now() }] },
      };
    });
    findMatchingBooking.mockResolvedValue({
      bookingId: '22877846', seatId: 'test-seat', seatTitle: '209',
      roomId: '1559', beginTime: task.beginTime, duration: task.duration,
    });
    await worker.runGrabTask(task);
    expect(findMatchingBooking).toHaveBeenCalledWith(task.accountId, expect.objectContaining({
      roomId: '1559', seats: [{ seatId: 'test-seat', title: '209' }],
    }));
    expect(updateStatus).toHaveBeenCalledWith(task.id, TaskStatus.SUCCESS, expect.objectContaining({
      bookingId: '22877846', seatId: 'test-seat',
    }));
  });
});
