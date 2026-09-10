#!/usr/bin/env python3
"""Detached preview/Chromium processes. No shell, pkill or GNU tools."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import urllib.request

STATE = Path(os.environ.get('AIDCREW_BROWSER_RUNTIME', Path.home() / '.aidcrew' / 'browser-chromium-runtime'))


def probe(url):
    try:
        with urllib.request.urlopen(url, timeout=2) as response:
            return response.status
    except Exception:
        return None


def identity(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart=,command='],
                            capture_output=True, text=True)
    return result.stdout.strip()


def stop_owned(record):
    if not record.exists():
        return
    old = json.loads(record.read_text())
    pid = old['pid']
    if identity(pid) and identity(pid) == old['identity']:
        os.killpg(pid, signal.SIGTERM)
        for _ in range(30):
            if not identity(pid):
                break
            time.sleep(.1)
        else:
            raise RuntimeError(f'Process {pid} did not stop; inspect it before retrying.')
    record.unlink(missing_ok=True)


def ensure_watcher(port, debug_port):
    record = STATE / 'watcher.json'
    script = Path(__file__).resolve().with_name('watch-preview.ts')
    command = [shutil.which('bun') or str(Path.home() / '.bun/bin/bun'), str(script),
               f'http://localhost:{port}/', f'http://127.0.0.1:{debug_port}']
    if record.exists():
        old = json.loads(record.read_text())
        if identity(old['pid']) == old['identity'] and old['command'] == command:
            return
        stop_owned(record)
    log = STATE / 'watcher.log'
    with log.open('ab', buffering=0) as output:
        child = subprocess.Popen(command, cwd=STATE, stdin=subprocess.DEVNULL,
                                 stdout=output, stderr=output, start_new_session=True)
    time.sleep(.1)
    if child.poll() is not None:
        raise RuntimeError(f'Preview watcher failed; read {log}')
    record.write_text(json.dumps({'pid': child.pid, 'identity': identity(child.pid),
                                 'command': command, 'log': str(log)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('service', choices=['preview', 'chromium'])
    parser.add_argument('action', choices=['start', 'status', 'stop', 'restart'])
    parser.add_argument('--cwd', type=Path)
    parser.add_argument('--port', type=int, default=8787)
    parser.add_argument('--debug-port', type=int, default=9222)
    parser.add_argument('--executable', default='/Applications/Chromium.app/Contents/MacOS/Chromium')
    args = parser.parse_args()
    if args.service == 'preview' and args.action in ('start', 'restart') and not args.cwd:
        parser.error('preview start/restart requires --cwd')
    STATE.mkdir(parents=True, exist_ok=True)
    record = STATE / f'{args.service}.json'
    app_url = f'http://localhost:{args.port}/'
    url = app_url if args.service == 'preview' else f'http://127.0.0.1:{args.debug_port}/json/version'
    if args.action in ('stop', 'restart'):
        if args.service == 'chromium':
            stop_owned(STATE / 'watcher.json')
        stop_owned(record)
        if args.action == 'stop':
            print('Stopped owned process only.')
            return
    status = probe(url)
    if args.action == 'status' or status:
        if status and args.service == 'chromium' and args.action != 'status':
            ensure_watcher(args.port, args.debug_port)
        print(json.dumps({'url': url, 'httpStatus': status,
                          'process': json.loads(record.read_text()) if record.exists() else None}))
        if status and args.action != 'status' and args.service == 'preview':
            if not record.exists() or Path(json.loads(record.read_text())['cwd']) != args.cwd.resolve():
                raise RuntimeError(f'Port {args.port} belongs to a different/unmanaged preview; do not kill it blindly.')
        return
    if args.service == 'preview':
        if not args.cwd or not (args.cwd / 'package.json').is_file():
            raise RuntimeError('Provide --cwd pointing to the implemented working checkout with package.json.')
        cwd = args.cwd.resolve()
        command = [shutil.which('bun') or str(Path.home() / '.bun/bin/bun'), 'run', 'dev']
    else:
        cwd = STATE
        command = [args.executable,
                   f'--user-data-dir={STATE / "chromium-profile"}',
                   '--remote-debugging-address=127.0.0.1', f'--remote-debugging-port={args.debug_port}',
                   '--no-first-run', '--no-default-browser-check',
                   '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
                   '--disable-background-timer-throttling',
                   '--window-size=1720,1349', '--window-position=1720,25',
                   app_url]
    log = STATE / f'{args.service}.log'
    with log.open('ab', buffering=0) as output:
        child = subprocess.Popen(command, cwd=cwd, env={**os.environ, 'PORT': str(args.port)},
                                 stdin=subprocess.DEVNULL, stdout=output, stderr=output,
                                 start_new_session=True)
    time.sleep(.2)
    record.write_text(json.dumps({'pid': child.pid, 'identity': identity(child.pid),
                                 'cwd': str(cwd), 'command': command, 'log': str(log)}, indent=2))
    for _ in range(30):
        status = probe(url)
        if status:
            if args.service == 'chromium':
                ensure_watcher(args.port, args.debug_port)
            print(json.dumps({'pid': child.pid, 'url': url, 'httpStatus': status, 'log': str(log)}))
            return
        if child.poll() is not None:
            break
        time.sleep(.3)
    raise RuntimeError(f'Service is not ready. Read {log}; do not launch repeated copies.')


if __name__ == '__main__':
    main()
