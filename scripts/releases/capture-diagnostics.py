"""Read-only host capture for the two October 14 booking tasks; never calls school APIs."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import threading
import time

TASK_IDS = ['36b10a38-cc6f-433d-a58f-11938721a3bb', '5e7bf128-6b63-424e-96f4-f9f5baa934c8']
SNAPSHOT_JS = r"""const m=require('mysql2/promise');(async()=>{const c=await m.createConnection({host:process.env.DB_HOST,user:process.env.DB_USERNAME,password:process.env.DB_PASSWORD,database:process.env.DB_DATABASE,charset:'utf8mb4'});const ids=JSON.parse(process.argv[1]);const [tasks]=await c.query('SELECT id,accountId,roomId,beginTime,duration,seatPreference,strictMode,triggerAt,status,attempts,result,updatedAt FROM grab_tasks WHERE id IN (?,?)',ids);const [attempts]=await c.query('SELECT taskId,accountId,seatId,result,errorMsg,timestamp,searchStartMs,searchEndMs,bookStartMs,bookEndMs FROM grab_attempt_logs WHERE taskId IN (?,?) ORDER BY timestamp',ids);console.log(JSON.stringify({tasks,attempts}));await c.end();})().catch(e=>{console.error(e.code||e.name);process.exitCode=1;});"""

def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()

def run(args, payload=None):
    return subprocess.run(args, input=payload, text=True, capture_output=True, timeout=20, check=True).stdout

def secure_file(path, mode='a'):
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    return path.open(mode, encoding='utf-8')

def capture_snapshot(output, label):
    body = run(['docker', 'exec', '-i', 'library-seat-backend', 'node', '-e', SNAPSHOT_JS, json.dumps(TASK_IDS)])
    data = json.loads(body)
    data['capturedAt'] = utc_now()
    data['delayedJobs'] = run(['docker', 'exec', 'library-seat-redis', 'redis-cli', '--raw', 'ZRANGE', 'library-seat:grab-seat:delayed', '0', '-1', 'WITHSCORES'])
    data['failedJobCount'] = run(['docker', 'exec', 'library-seat-redis', 'redis-cli', '--raw', 'ZCARD', 'library-seat:grab-seat:failed']).strip()
    with secure_file(output / (label + '.json'), 'w') as file:
        json.dump(data, file, ensure_ascii=False, indent=2)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--end', default='2026-10-14T20:06:00+08:00')
    parser.add_argument('--snapshot-only', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    output.chmod(0o700)
    if args.snapshot_only:
        capture_snapshot(output, 'snapshot-check')
        print('snapshot captured; school requests: 0')
        return
    end = dt.datetime.fromisoformat(args.end).timestamp()
    capture_since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=10)).isoformat()
    child = None
    reader = None
    current_id = None
    state_before = None
    final_snapshot_done = False
    next_resource_sample = 0.0
    with secure_file(output / 'collector-events.jsonl') as events:
        def event(name, **fields):
            events.write(json.dumps({'event': name, 'ts': utc_now(), **fields}, ensure_ascii=False) + '\n')
            events.flush()
        event('collector_start', captureSince=capture_since, end=args.end, taskIds=TASK_IDS)
        if time.time() >= end:
            event('collector_skipped_after_window')
            return
        try:
            event('host_time_sync', details=run(['timedatectl', 'show', '-p', 'Timezone', '-p', 'NTPSynchronized']).strip())
        except Exception as error:
            event('time_sync_check_failed', errorType=type(error).__name__)
        try:
            if not (output / 'before.json').exists():
                capture_snapshot(output, 'before')
                event('snapshot_saved', label='before')
        except Exception as error:
            event('snapshot_failed', label='before', errorType=type(error).__name__)
        try:
            while time.time() < end:
                try:
                    inspect = json.loads(run(['docker', 'inspect', 'library-seat-backend']))[0]
                    runtime = inspect['State']
                    state = {
                        'containerId': inspect['Id'], 'image': inspect['Image'],
                        'version': inspect['Config'].get('Labels', {}).get('org.opencontainers.image.version'),
                        'status': runtime['Status'], 'health': runtime.get('Health', {}).get('Status'),
                        'restartCount': inspect['RestartCount'], 'oomKilled': runtime['OOMKilled'],
                        'exitCode': runtime['ExitCode'], 'startedAt': runtime['StartedAt'], 'finishedAt': runtime['FinishedAt'],
                    }
                    if state != state_before:
                        event('container_state', **state)
                        state_before = state
                    if current_id != inspect['Id'] or child is None or child.poll() is not None:
                        if child is not None:
                            child.terminate()
                            child.wait(timeout=5)
                            reader.join(timeout=5)
                        current_id = inspect['Id']
                        path = output / ('backend-' + current_id[:12] + '.log')
                        target = path.open('ab', buffering=0)
                        path.chmod(0o600)
                        child = subprocess.Popen(['docker', 'logs', '--timestamps', '--follow', '--since', capture_since, current_id], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
                        def drain(stream, file):
                            try:
                                while True:
                                    line = stream.readline()
                                    if not line:
                                        break
                                    file.write(line)
                            finally:
                                file.close()
                        reader = threading.Thread(target=drain, args=(child.stdout, target), daemon=True)
                        reader.start()
                        event('log_attached', containerId=current_id, path=path.name)
                except Exception as error:
                    event('container_check_failed', errorType=type(error).__name__)
                if time.monotonic() >= next_resource_sample:
                    event('host_load', load=os.getloadavg())
                    next_resource_sample = time.monotonic() + 30
                if not final_snapshot_done and time.time() >= end - 120:
                    try:
                        capture_snapshot(output, 'after')
                        event('snapshot_saved', label='after')
                        final_snapshot_done = True
                    except Exception as error:
                        event('snapshot_failed', label='after', errorType=type(error).__name__)
                time.sleep(min(5, max(0, end - time.time())))
        finally:
            if child is not None:
                child.terminate()
                child.wait(timeout=5)
                reader.join(timeout=5)
            # Capture once more at the end to include late request completion or user cancellation.
            try:
                capture_snapshot(output, 'final')
                event('snapshot_saved', label='final')
            except Exception as error:
                event('snapshot_failed', label='final', errorType=type(error).__name__)
            event('collector_finished')

if __name__ == '__main__':
    main()
