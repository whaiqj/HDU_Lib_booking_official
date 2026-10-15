import { GrabSeatWorker } from './grab-seat-worker.service';
import { bookTimeoutStage, BookTransportTrace } from '../hdu-library/book-transport-trace';

describe('诊断失败现场', () => {
  it.each<[BookTransportTrace, string]>([
    [{}, 'before_socket'],
    [{ socketAssignedMs: 1, dnsErrorCode: 'ENOTFOUND' }, 'dns_lookup_failed'],
    [{ socketAssignedMs: 1, dnsMs: 2 }, 'tcp_connect'],
    [{ protocol: 'https:', socketAssignedMs: 1, tcpMs: 2 }, 'tls'],
    [{ protocol: 'https:', socketAssignedMs: 1, tcpMs: 2, tlsMs: 3 }, 'request_write'],
    [{ protocol: 'http:', socketAssignedMs: 1, tcpMs: 2, requestFinishedMs: 3 }, 'waiting_response_headers'],
    [{ reusedSocket: true, socketAssignedMs: 1, requestFinishedMs: 2, responseHeadersMs: 3 }, 'reading_response_body'],
    [{ reusedSocket: true, socketAssignedMs: 1, requestFinishedMs: 2, responseHeadersMs: 3, responseEndedMs: 4 }, 'after_response'],
  ])('超时阶段 %j -> %s', (trace, stage) => {
    expect(bookTimeoutStage(trace)).toBe(stage);
  });

  it.each(['success', 'uncertain'])('通知异常仍保留 %s 状态及执行收尾', async (status) => {
    const entries: any[] = [];
    const invalidate = jest.fn();
    const updateStatus = jest.fn().mockResolvedValue(undefined);
    const worker = new GrabSeatWorker(
      {} as any, {} as any, { invalidate } as any,
      { updateStatus, findById: async () => ({ result: {} }) } as any,
      {} as any, {} as any, {} as any,
      { notify: async () => { throw new Error('mock_cookie=private; ticket=private'); } } as any,
    );
    (worker as any).logger = { log: (line: string) => entries.push(JSON.parse(line)), error: (line: string) => entries.push(JSON.parse(line)) };
    const task = { id: 'task', accountId: 'account', result: { reservationOutcomeUnknown: true } };
    (worker as any).runGrabTask = async () => {
      if (status === 'success') await (worker as any).markSuccess(task, { bookedSeatId: '63105', seatTitle: '209' }, 1, Date.now());
      else await (worker as any).markFailed(task, '超出时间窗口', 2, Date.now());
    };
    await expect(worker.executeGrab(task as any)).rejects.toThrow('mock_cookie');
    expect(entries[0]).toMatchObject({ event: 'task_status_persisted', status, reservationOutcomeUnknown: status === 'uncertain' });
    expect(entries.slice(-2).map(x => x.event)).toEqual(['task_execution_error', 'task_execution_closed']);
    expect(invalidate).toHaveBeenCalledWith('task');
    expect(JSON.stringify(entries)).not.toContain('private');
  });
});
