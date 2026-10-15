import * as http from 'node:http';
import * as https from 'node:https';
import { performance } from 'node:perf_hooks';

/** Request-local timings. Offsets are monotonic milliseconds from the Axios call. */
export interface BookTransportTrace {
  protocol?: string;
  dnsErrorCode?: string;
  socketAssignedMs?: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  requestFinishedMs?: number;
  responseHeadersMs?: number;
  responseEndedMs?: number;
  requestClosedMs?: number;
  reusedSocket?: boolean;
  remoteAddress?: string;
  httpStatus?: number;
  bytesReceived?: number;
  transportErrorCode?: string;
}

/** Preserve Axios's native Node transport while observing one booking request. */
export function createBookTransportTrace(): {
  trace: BookTransportTrace;
  elapsedMs: () => number;
  transport: { request: typeof https.request };
} {
  const started = performance.now();
  const elapsedMs = () => Math.round((performance.now() - started) * 1000) / 1000;
  const trace: BookTransportTrace = {};
  const transport = {
    request(options: any, onResponse: (response: http.IncomingMessage) => void): http.ClientRequest {
      trace.protocol = options.protocol;
      const native = options.protocol === 'https:' ? https : http;
      const req = native.request(options, (response) => {
        trace.responseHeadersMs = elapsedMs();
        trace.httpStatus = response.statusCode;
        let bytes = 0;
        response.on('data', (chunk: Buffer) => { bytes += chunk.length; });
        response.once('end', () => {
          trace.responseEndedMs = elapsedMs();
          trace.bytesReceived = bytes;
        });
        onResponse(response);
      });
      req.once('socket', (socket) => {
        trace.socketAssignedMs = elapsedMs();
        trace.reusedSocket = req.reusedSocket;
        if (req.reusedSocket) {
          trace.remoteAddress = socket.remoteAddress;
        } else {
          socket.once('lookup', (error: NodeJS.ErrnoException | null) => {
            trace.dnsMs = elapsedMs();
            if (error) trace.dnsErrorCode = error.code ?? 'lookup_error';
          });
          socket.once('connect', () => {
            trace.tcpMs = elapsedMs();
            trace.remoteAddress = socket.remoteAddress;
          });
          socket.once('secureConnect', () => { trace.tlsMs = elapsedMs(); });
        }
      });
      req.once('finish', () => { trace.requestFinishedMs = elapsedMs(); });
      req.once('close', () => {
        trace.requestClosedMs = elapsedMs();
        trace.reusedSocket = req.reusedSocket;
      });
      req.once('error', (error: NodeJS.ErrnoException) => {
        trace.transportErrorCode = error.code ?? 'request_error';
      });
      return req;
    },
  };
  return { trace, elapsedMs, transport: transport as { request: typeof https.request } };
}

export function bookTimeoutStage(trace: BookTransportTrace): string {
  if (trace.socketAssignedMs === undefined) return 'before_socket';
  if (trace.dnsErrorCode) return 'dns_lookup_failed';
  if (!trace.reusedSocket && trace.tcpMs === undefined) {
    return trace.dnsMs === undefined ? 'dns_or_tcp' : 'tcp_connect';
  }
  if (trace.protocol !== 'http:' && !trace.reusedSocket && trace.tlsMs === undefined) return 'tls';
  if (trace.requestFinishedMs === undefined) return 'request_write';
  if (trace.responseHeadersMs === undefined) return 'waiting_response_headers';
  if (trace.responseEndedMs === undefined) return 'reading_response_body';
  return 'after_response';
}
