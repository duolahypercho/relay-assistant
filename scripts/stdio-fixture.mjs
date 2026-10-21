// SPDX-License-Identifier: MIT
// Independent MCP server using Python's standard library, installed only in
// disposable acceptance workspaces. Production never imports this fixture.
export const stdioFixture = `import os,sys,json,time,socket,signal
from pathlib import Path
def tool(name,title,properties={},required=[],read=False):
 return {'name':name,'title':title,'description':'Fictional local notebook acceptance.','inputSchema':{'type':'object','properties':properties,'required':required,'additionalProperties':False},'annotations':{'readOnlyHint':read}}
tools=[tool('read_note','Read local note',read=True),tool('save_note','Save local note',{'text':{'type':'string'}},['text']),tool('inspect_runtime','Inspect tool computer',read=True),tool('slow_write','Slow local write'),tool('crash_write','Interrupted local write')]
def call(name,args):
 if name=='read_note': return Path('/workspace/local-note.txt').read_text() if Path('/workspace/local-note.txt').exists() else 'A quiet Sunday by the water.'
 if name=='save_note': Path('/workspace/local-note.txt').write_text(args['text']); return 'Saved your local note.'
 if name=='inspect_runtime':
  try:
   s=socket.socket(); s.settimeout(.3); s.connect(('1.1.1.1',443)); network=True
  except OSError: network=False
  finally: s.close()
  return json.dumps({'uid':os.getuid(),'cwd':os.getcwd(),'hasExpectedSecret':os.environ.get('LOCAL_KEY')=='fictional-local-secret','hostSecretPresent':'RELAY_ACCEPTANCE_HOST_SECRET' in os.environ,'directNetwork':network,'secretEcho':os.environ.get('LOCAL_KEY','')})
 if name in ('slow_write','crash_write'):
  Path('/workspace/local-started.txt').write_text('started')
  if name=='crash_write': os._exit(1)
  if os.fork()==0:
   os.setsid()
   if os.fork(): os._exit(0)
   signal.signal(signal.SIGTERM,signal.SIG_IGN)
   while True:
    with open('/workspace/local-ticks.txt','ab',buffering=0) as f:f.write(b'tick\\n')
    time.sleep(.04)
  time.sleep(60); return 'Finished.'
 raise RuntimeError('Unknown tool')
for line in sys.stdin:
 try:
  p=json.loads(line)
  if 'id' not in p:continue
  method=p['method']
  if method=='initialize':
   if '--slow-init' in sys.argv: Path('/workspace/local-initializing.txt').write_text('started'); time.sleep(60)
   result={'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'Local acceptance','version':'1'}}
  elif method=='tools/list': result={'tools':tools}
  elif method=='tools/call':result={'content':[{'type':'text','text':call(p['params']['name'],p['params'].get('arguments',{}))}]}
  elif method=='ping':result={}
  else: raise RuntimeError('Unsupported method')
  print(json.dumps({'jsonrpc':'2.0','id':p['id'],'result':result}),flush=True)
 except Exception: print(json.dumps({'jsonrpc':'2.0','id':p.get('id'),'error':{'code':-32603,'message':'Fixture operation failed'}}),flush=True)
`;
