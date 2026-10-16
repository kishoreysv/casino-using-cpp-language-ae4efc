#!/usr/bin/env python3
"""Production-container regression: independent SPA startup and real API workflow.
Build tenfold-backend:rehearsal and tenfold-frontend:rehearsal first.
Only run-owned containers/network are removed. Capabilities stay in memory.
"""
import json
import re
import subprocess
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]

def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()

def http(base, path, body=None, token=None, method=None):
    headers = {}
    if body is not None:
        headers['Content-Type'] = 'application/json'
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = Request(base + path, data=None if body is None else json.dumps(body).encode(),
                  headers=headers, method=method)
    try:
        response = urlopen(req, timeout=5)
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.read().decode()

def ready(base, path):
    for _ in range(60):
        try:
            if http(base, path)[0] == 200:
                return
        except (URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(1)
    raise AssertionError('HTTP readiness timed out: ' + path)

def main():
    suffix = uuid.uuid4().hex[:10]
    network, backend, frontend = ['tenfold-' + role + '-' + suffix for role in ['net', 'api', 'web']]
    names = []
    docker('network', 'create', network)
    try:
        docker('run', '-d', '--name', frontend, '--network', network,
               '-p', '127.0.0.1::80', 'tenfold-frontend:rehearsal')
        names.append(frontend)
        web = 'http://' + docker('port', frontend, '80/tcp')
        ready(web, '/')
        status, html = http(web, '/play')
        assert status == 200 and '<div id="root">' in html
        for asset in re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html):
            assert http(web, asset)[0] == 200
        docker('exec', frontend, 'nginx', '-t')
        print('PASS: independent frontend startup, SPA fallback, assets, nginx configuration')
        docker('run', '-d', '--name', backend, '--network', network, '--network-alias', 'backend',
               '--env-file', str(ROOT / 'backend' / '.env.local'),
               '-p', '127.0.0.1::3000', 'tenfold-backend:rehearsal')
        names.append(backend)
        api = 'http://' + docker('port', backend, '3000/tcp')
        ready(api, '/api/health')
        ready(web, '/api/health')
        assert json.loads(http(api, '/api/health')[1]) == {'status': 'ok'}
        assert json.loads(http(web, '/api/health')[1]) == {'status': 'ok'}
        assert http(web, '/api/v1/sessions/current')[0] == 401
        status, data = http(web, '/api/v1/sessions', {'name': 'Rehearsal', 'deposit': 1000})
        assert status == 201
        created = json.loads(data)
        token = created['token']
        session_id = created['session']['id']
        status, data = http(web, '/api/v1/rounds', {'bet': 100, 'guess': 7}, token)
        assert status == 201
        session = json.loads(data)['session']
        assert session['id'] == session_id and len(session['rounds']) == 1
        round_ = session['rounds'][0]
        expected_delta = 1000 if round_['draw'] == 7 else -100
        assert round_['delta'] == expected_delta and session['balance'] == 1000 + expected_delta
        assert http(web, '/api/v1/rounds', {'bet': 100, 'guess': 7})[0] == 401
        docker('restart', backend)
        # Docker may reassign an ephemeral host port on container restart.
        api = 'http://' + docker('port', backend, '3000/tcp')
        ready(api, '/api/health')
        ready(web, '/api/health')
        status, data = http(web, '/api/v1/sessions/current', token=token)
        assert status == 200 and json.loads(data)['session'] == session
        status, data = http(web, '/api/v1/sessions/stop', token=token, method='POST')
        assert status == 200 and json.loads(data)['session']['status'] == 'stopped'
        assert http(web, '/api/v1/rounds', {'bet': 100, 'guess': 7}, token)[0] == 409
        print('PASS: direct/proxied health, real create/play/recover/stop, authorization, same-container restart persistence')
        for _ in range(45):
            health = docker('inspect', '--format', '{{.State.Health.Status}}', backend)
            if health == 'healthy':
                break
            time.sleep(1)
        assert health == 'healthy'
        for name in names:
            assert docker('inspect', '--format', '{{.State.Running}}', name) == 'true'
            logs = docker('logs', '--tail', '30', name)
            assert '[emerg]' not in logs
            print('PASS: running container ' + name)
        subprocess.check_call(['git', 'check-ignore', '--no-index', 'backend/.env.prod', 'frontend/.env.prod'], cwd=ROOT)
        print('PASS: private production files ignored; complete rehearsal passed')
    except Exception:
        for name in names:
            print(docker('inspect', '--format', '{{.State.Status}} exit={{.State.ExitCode}}', name))
            print(docker('logs', '--tail', '20', name))
        raise
    finally:
        for name in reversed(names):
            subprocess.run(['docker', 'rm', '-f', name], check=False, stdout=subprocess.DEVNULL)
        subprocess.run(['docker', 'network', 'rm', network], check=False, stdout=subprocess.DEVNULL)

if __name__ == '__main__':
    main()
