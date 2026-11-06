"""Verify byte-preserved original fixtures and exact Builder regeneration, not Editor parsing."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

fixture = Path(__file__).resolve().parents[1] / 'packages/e4-import/src/bmb026-fixtures'
builder = Path(sys.argv[1]).resolve()
manifest = json.loads((fixture / 'manifest.json').read_text())
receipt = json.loads((fixture / 'receipt.json').read_text())
head = subprocess.check_output(['git', '-C', str(builder), 'rev-parse', 'HEAD'], text=True).strip()
assert head == manifest['builderSha'] == '8fc6ebbeb1996889983bd6fff0958d1f9a7aaf00'
for name, entry in manifest['files'].items():
    raw = (fixture / name).read_bytes()
    assert len(raw) == entry['bytes'] and hashlib.sha256(raw).hexdigest() == entry['sha256'], name
def canonical_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
for label, key in [('baseline', 'beforeModuleHashes'), ('revised', 'afterModuleHashes')]:
    document = json.loads((fixture / f'{label}.json').read_text())
    assert {m['moduleId']: canonical_hash(m) for m in document['modules']} == receipt[key]
with tempfile.TemporaryDirectory(prefix='bmb026-reproduction-') as temporary:
    subprocess.run([sys.executable, '-m', 'examples.bmb026_house', '--out-dir', temporary], cwd=builder, check=True, stdout=subprocess.DEVNULL)
    for label in ['baseline', 'revised']:
        assert (Path(temporary) / f'{label}.bomc').read_bytes() == (fixture / f'{label}.bomc').read_bytes(), label + ' binary reproduction'
        assert json.loads((Path(temporary) / f'{label}.json').read_text()) == json.loads((fixture / f'{label}.json').read_text())
print('PASS: exact Builder SHA, five original file digests, canonical Python module hashes, both independently regenerated binary SHA256 values')
