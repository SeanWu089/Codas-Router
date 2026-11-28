#!/usr/bin/env python3
"""Reject fixed deployment origins and private runtime state in the public source."""
from pathlib import Path
import re,sys
root=Path(sys.argv[1])
assert root.is_dir()
allowed={'127.0.0.1','localhost','example.com','example.test','fixture.invalid',
         'www.apache.org','registry.npmjs.org','docs.microsoft.com','github.com',
         'user','core','pub.dev','storage.googleapis.com','dart.dev','flutter.dev'}
for p in root.rglob('*'):
    if not p.is_file(): continue
    assert p.name not in {'agent.json','auth.json','profile.json','.env'},'Unexpected state file: '+p.name
    if p.suffix.lower() not in {'.dart','.js','.mjs','.json','.yaml','.yml','.md','.txt','.ps1','.iss','.cpp','.h','.xml','.kts','.lock'}: continue
    for host in re.findall(r'https?://([a-zA-Z0-9.-]+)',p.read_text(encoding='utf-8',errors='ignore')):
        host=host.lower().rstrip('.')
        assert host in allowed or host.endswith(('.example.com','.example.test','.invalid')),'Unexpected fixed URL in '+str(p.relative_to(root))
for rel in ['lib/agent_network.dart','runtime/desktop-policy.mjs']:
    assert not re.search(r'https://[a-zA-Z0-9.-]+',(root/rel).read_text()),'Fixed origin in '+rel
print('Public source URL/state audit passed.')
