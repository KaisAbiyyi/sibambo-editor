"""SE-05 bounded diagnostic of the two merged owner API contracts (synthetic only).

Run with the SE-03 hash-locked Python environment. No product source is modified.
The diagnostic succeeds when it reproduces the recorded blocker, not when SE-05 works.
"""
import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

BUILDER_BASE = '6e3990f4cc57a3b2e8eab431aa263003a69afc16'
EDITOR_BASE = '4166e829840e393541506f4963995f193cc93d07'


async def probe(output):
    from tests.remote_support import Env
    env = Env().start()
    try:
        owner = await env.setup_project('se05-contract', agents=())
        async with env.http(owner) as http:
            rows = []
            for method, path in [
                ('GET', '/v1/projects/se05-contract/owner/mcp'),
                ('POST', '/v1/projects/se05-contract/owner/mcp/ticket'),
                ('GET', '/owner/v1/projects/se05-contract'),
                ('POST', '/owner/v1/projects/se05-contract/ticket'),
            ]:
                response = await http.request(method, env.base + path,
                                              **({'json': {}} if method == 'POST' else {}))
                row = {'method': method, 'path': path, 'httpStatus': response.status_code}
                if response.status_code == 200:
                    body = response.json()
                    # Never serialize token values, request text, headers or full response bodies.
                    row.update(responseKeys=sorted(body), contract=body.get('contract'),
                               ttlSeconds=body.get('ttlSeconds'), epochType=type(body.get('epoch')).__name__)
                rows.append(row)
        assert [x['httpStatus'] for x in rows] == [404, 404, 200, 200], 'baseline behaviour changed: REVIEW/PLAN'
        assert rows[3]['contract'] is None and rows[3]['ttlSeconds'] == 120
        assert 'expiresAt' in rows[3]['responseKeys'] and 'ticketExpiresAt' not in rows[3]['responseKeys']
        report = {'editorBase': EDITOR_BASE, 'builderBase': BUILDER_BASE,
                  'fixture': 'synthetic RSA IdP + loopback TLS',
                  'result': 'BLOCKED_CONTRACT_MISMATCH', 'requests': rows}
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
        print('REPRODUCED: BLOCKED_CONTRACT_MISMATCH (not an SE-05 acceptance PASS)')
    finally:
        env.stop()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--builder-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if os.name == 'nt' and (Path(tempfile.gettempdir()).drive.upper() != 'D:' or args.output.resolve().drive.upper() != 'D:'):
        parser.error('Set TEMP and TMP and --output to dedicated D: paths before running')
    actual = subprocess.check_output(['git', '-C', str(args.builder_root), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != BUILDER_BASE:
        parser.error('Builder HEAD differs from the recorded baseline; REVIEW/PLAN before reproducing')
    # Refuse a dirty service/core/harness: a commit SHA alone does not identify changed bytes.
    dirty = subprocess.check_output(['git', '-C', str(args.builder_root), 'status', '--porcelain', '--',
                                     'service', 'core', 'tests/remote_support.py'], text=True)
    if dirty.strip():
        parser.error('Builder diagnostic inputs have local changes; do not claim exact-base evidence')
    sys.path.insert(0, str(args.builder_root.resolve()))
    asyncio.run(probe(args.output.resolve()))
