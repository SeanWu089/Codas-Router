#!/usr/bin/env python3
"""Conservative Windows x64 runtime reduction; retained upstream files unchanged."""
import hashlib,json,pathlib,shutil,sys,collections
root=pathlib.Path(sys.argv[1]).resolve(); out=pathlib.Path(sys.argv[2]).resolve()
assert root.name=='devspace' and json.loads((root/'node_modules/@waishnav/devspace/package.json').read_text())['version']=='1.1.0-beta.4'
assert not out.exists(), 'output must be new'
required=['node_modules/@waishnav/devspace/dist/'+p for p in ['cli.js','server.js','pi-tools.js','workspaces.js','workspace-store.js','apply-patch.js','process-sessions.js','process-platform.js','review-checkpoints.js','git-worktrees.js','artifact-tools.js','artifact-destination-windows.js','oauth-provider.js','oauth-store.js','skills.js','local-agent-manager.js','local-agent-codex.js','local-agent-acp.js','local-agent-claude.js','tool-surfaces/codex.js','ui/workspace-app.html']]
required+=['node_modules/@earendil-works/pi-coding-agent/package.json','node_modules/better-sqlite3/build/Release/better_sqlite3.node','node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/x64/srt-win.exe','node_modules/@anthropic-ai/claude-agent-sdk/package.json','node_modules/@modelcontextprotocol/sdk/package.json']
required+=['node_modules/node-pty/prebuilds/win32-x64/'+p for p in ['pty.node','conpty.node','conpty_console_list.node','winpty.dll','winpty-agent.exe']]
for f in required: assert (root/f).is_file(),f
def reason(s):
    a=s.lower(); n=pathlib.PurePosixPath(a).name
    if any(x in n for x in ('license','licence','copying','notice','copyright')): return None
    if a=='node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe': return 'optional_embedded_claude_cli_disabled_in_windows_agent'
    if a.endswith(('.js.map','.mjs.map','.cjs.map','.ts.map','.mts.map','.cts.map','.css.map')): return 'source_map'
    if a.endswith('.pdb'): return 'native_debug_symbols'
    if a.startswith('node_modules/node-pty/prebuilds/') and a.split('/')[3] in ('win32-arm64','darwin-x64','darwin-arm64'): return 'non_target_native_prebuild'
    if a.startswith('node_modules/node-pty/third_party/conpty/') and '/win10-arm64/' in a: return 'non_target_native_prebuild'
    if a.startswith('node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win/arm64/') or (a.startswith('node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/') and n=='apply-seccomp'): return 'non_target_native_prebuild'
    return None
stats=collections.defaultdict(lambda:{'files':0,'bytes':0}); removed=[]; before=0; kept=0; count=0
out.mkdir(parents=True)
for p in sorted(root.rglob('*')):
    if p.is_symlink(): raise ValueError('unexpected symlink '+str(p))
    if not p.is_file(): continue
    rel=p.relative_to(root).as_posix(); size=p.stat().st_size; before+=size; count+=1
    why=reason(rel)
    if why:
        stats[why]['files']+=1;stats[why]['bytes']+=size
        with p.open('rb') as stream: digest=hashlib.file_digest(stream,'sha256').hexdigest()
        removed.append({'path':rel,'reason':why,'bytes':size,'sha256':digest})
    else:
        q=out/rel;q.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,q)
        with p.open('rb') as a,q.open('rb') as b: assert hashlib.file_digest(a,'sha256').digest()==hashlib.file_digest(b,'sha256').digest(),rel
        kept+=size
for f in required: assert (out/f).is_file(),f
assert not (out/'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe').exists()
report={'name':'Codas Workspace Lite','upstream':'@waishnav/devspace@1.1.0-beta.4','target':'win32-x64','before_files':count,'after_files':count-len(removed),'before_bytes':before,'after_bytes':kept,'removed_bytes':before-kept,'groups':dict(stats),'removed':removed,'notes':['Retained upstream files are byte-identical. No change to authentication, authorization, process or file handling implementation.','Bundled Claude executable omitted; Windows foreground candidate has subagents disabled. External provider use is separate and is not validated.','Inventory check is not a Windows runtime test.']}
(out/'codas-prune-manifest.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='removed'},indent=2))
