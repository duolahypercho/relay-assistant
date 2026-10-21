// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.mjs';
import { PrivateComputer } from '../server/computer.mjs';
import { executeTool } from '../server/agent.mjs';
import { desktopInput } from '../server/computer-coordinates.mjs';

test('guest accessibility collector bounds geometry, traversal and text while excluding other apps, hidden and protected widgets', () => {
  const script = String.raw`
import importlib.util,json
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('relay_accessibility','docker/accessibility.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
api=SimpleNamespace(STATE_ACTIVE='active',STATE_SHOWING='showing',STATE_FOCUSED='focused',STATE_ENABLED='enabled',STATE_CHECKED='checked',DESKTOP_COORDS=0)
class Node:
 def __init__(self,role='panel',name='',children=None,states=('showing','enabled'),rect=(0,0,100,40),pid=42):
  self.role,self._name,self.children,self.states,self.rect,self.pid=role,name,children or [],states,rect,pid
 @property
 def childCount(self):return len(self.children)
 @property
 def name(self):
  assert self.role not in ('password text','password entry'),'Protected name was read'
  return self._name
 def get_process_id(self):return self.pid
 def getState(self):return SimpleNamespace(contains=lambda value:value in self.states)
 def getRoleName(self):return self.role
 def queryComponent(self):return SimpleNamespace(getExtents=lambda coords:self.rect)
 def __getitem__(self,index):return self.children[index]
def root(children):return Node(children=[Node(children=[Node('frame',children=children,states=('active','showing','enabled'))])])
assert m.point([100,80,200,80])=={'x':156,'y':150}
assert m.point([-20,-20,40,40])=={'x':8,'y':12}
for rect in ([1280,0,5,5],[0,800,5,5],[0,0,0,4],[0,0,-5,5],[0,0,float('inf'),5],[0,0,float('nan'),5],[0,0,5]):assert m.point(rect) is None
secret=Node('static','do not disclose')
input=Node('entry','Name',states=('showing','enabled','focused'))
hidden=Node(children=[Node('push button','hidden')],states=())
tree=root([input,Node('push button','disabled',states=('showing',)),hidden,
 Node('password text','private',children=[secret]),Node('password entry','private2',children=[secret],rect=(0,0,0,0)),
 Node('check box','Choose',states=('showing','enabled','checked')),Node('label','a\x00b'+'x'*300)])
tree.children.append(Node(children=[Node('frame',children=[Node('entry','other app')],states=('active','showing'))],pid=99))
r=m.collect(tree,42,api)
assert r['available'] and r['sourceData'] and r['coordinateSpace']=='normalized_1000'
assert [c['name'] for c in r['controls'][:4]]==['Name','disabled','Password field','Choose']
assert r['controls'][0]['focused'] and r['controls'][1]['enabled'] is False and r['controls'][2]['protected']
assert r['controls'][3]['checked'] and len(r['controls'][4]['name'])==180
assert 'private' not in json.dumps(r) and 'do not disclose' not in json.dumps(r) and 'other app' not in json.dumps(r)
assert not m.collect(tree,999,api)['available']
tree.children[0].children.append(Node('frame',states=('active','showing')))
assert not m.collect(tree,42,api)['available']
large=m.collect(root([Node('push button',str(i)) for i in range(10000)]),42,api)
assert len(large['controls'])==80 and large['truncated']
cycle=Node();cycle.children=[cycle]
assert m.collect(root([cycle]),42,api)['controls']==[]
times=iter([0,2]);assert not m.collect(root([input]),42,api,clock=lambda:next(times))['available']
print('PASS bounded guest accessibility and protected-field handling')
`;
  assert.match(
    execFileSync('python3', ['-c', script], { encoding: 'utf8', timeout: 5000 }),
    /PASS/,
  );
});

test('agent screen observations request controls, preserve normalized targets and keep owner polling lightweight', async () => {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  const calls = [];
  computer.status = async () => ({ state: 'running' });
  computer.rpc = async (request) => {
    calls.push(request);
    return {
      screenshot: 'aGVsbG8=',
      accessibility: request.controls
        ? {
            available: true,
            coordinateSpace: 'normalized_1000',
            sourceData: true,
            controls: [{ role: 'push button', name: 'Download', x: 500, y: 250 }],
          }
        : undefined,
    };
  };
  try {
    const observed = await executeTool(store, 'computer_look', {}, { computer });
    assert.equal(calls[0].controls, true);
    assert.equal(observed.image, 'data:image/jpeg;base64,aGVsbG8=');
    assert.equal(observed.result.screenshot, undefined);
    const { x, y } = observed.result.accessibility.controls[0];
    assert.deepEqual(
      desktopInput({
        action: 'click',
        x,
        y,
        coordinateSpace: observed.result.accessibility.coordinateSpace,
      }),
      { action: 'click', x: 640, y: 200 },
    );
    await computer.screenshot();
    assert.equal(calls.at(-1).controls, undefined);
    computer.perform = async (request, options) => {
      calls.push({ request, options });
      return {};
    };
    await executeTool(
      store,
      'computer_use',
      { operationId: 'observed', action: 'key', key: 'Tab' },
      { computer },
    );
    assert.equal(calls.at(-1).options.observeControls, true);
    assert.equal(calls.at(-1).request.controls, undefined);
  } finally {
    store.close();
  }
});

test('owner takeover discards control metadata as well as the screenshot', async () => {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  computer.screenshot = async () => {
    computer.epoch++;
    store.db.prepare("UPDATE computer_meta SET controller='owner'").run();
    return { screenshot: 'aGVsbG8=', accessibility: { controls: [{ name: 'private' }] } };
  };
  try {
    await assert.rejects(executeTool(store, 'computer_look', {}, { computer }), /control|owner/);
  } finally {
    store.close();
  }
});

test('control observations do not change receipt identity or persist stale targets for a replay', async () => {
  const store = new Store(':memory:', { sample: false });
  const computer = new PrivateComputer(store, { enabled: true });
  computer.requireRunning = async () => ({});
  let dispatched = 0;
  computer.rpc = async (request) => {
    dispatched++;
    assert.equal(request.controls, true);
    return {
      screenshot: 'aGVsbG8=',
      accessibility: {
        available: true,
        controls: [{ name: 'Private screen label', x: 30, y: 40 }],
      },
      accepted: true,
    };
  };
  const action = { kind: 'desktop', action: 'click', x: 30, y: 40, operationId: 'same-click' };
  try {
    const first = await computer.perform(action, { observeControls: true });
    assert.equal(first.accessibility.controls[0].name, 'Private screen label');
    const again = await computer.perform(action);
    assert.equal(again.repeated, true);
    assert.equal(again.accepted, true);
    assert.equal(again.accessibility, undefined);
    assert.equal(again.screenshot, undefined);
    assert.equal(dispatched, 1);
    assert(
      !store.db
        .prepare('SELECT result FROM computer_operations')
        .get()
        .result.includes('Private screen label'),
    );
    await assert.rejects(
      computer.perform({ ...action, x: 31 }, { observeControls: true }),
      /different action/,
    );
  } finally {
    store.close();
  }
});
