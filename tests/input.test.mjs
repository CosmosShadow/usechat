import test from 'node:test';
import assert from 'node:assert/strict';
import {actionArgs,absoluteCoordinate,guardRects,validateReceipt} from '../scripts/input.mjs';
const s={version:2,width:3456,height:2234,bounds:{x:-1728,y:0,width:1728,height:1117}};
test('absolute negative cliclick coordinates use equals prefix, not relative motion',()=>{
  assert.equal(absoluteCoordinate(-1200),'=-1200');
  assert.deepEqual(actionArgs('click',{x:'1060',y:'1595'},s),['-r','c:=-1198,798']);
});
test('click requires calibrated bounds and a valid point',()=>{
  assert.throws(()=>actionArgs('click',{x:'1060',y:'1595'},{...s,bounds:null}));
  assert.throws(()=>actionArgs('click',{x:'9999',y:'1'},s));
  assert.throws(()=>actionArgs('click',{x:'1',y:'1',button:'invalid'},s));
});
test('text and submit are separate events, text is one argv element not shell code',()=>{
  assert.deepEqual(actionArgs('type',{text:'测试 $(not-a-command)'},s),['t:测试 $(not-a-command)']);
  assert.throws(()=>actionArgs('type',{text:'hello\n'},s));
  assert.deepEqual(actionArgs('key',{key:'return'},s),['kp:return']);
  assert.throws(()=>actionArgs('key',{key:'cmd+q'},s));
});
test('title guards required; click adds target guard; out of frame guards rejected',()=>{
  assert.throws(()=>guardRects(s,'click',{x:'1',y:'1'}));
  const rs=guardRects(s,'click',{x:'1060',y:'1595',guards:'1390,215,700,70'});
  assert.equal(rs.length,2);assert.deepEqual(rs[1],{x:932,y:1547,width:256,height:96});
  assert.throws(()=>guardRects(s,'key',{guards:'3400,0,100,100'}));
});
test('expired or consumed references fail closed before touching filesystem',()=>{
  assert.throws(()=>validateReceipt({...s,createdAt:0,captureOptions:{}},1000000));
  assert.throws(()=>validateReceipt({...s,createdAt:10,consumed:true,captureOptions:{}},20));
});

test('Command Return is explicit and unsupported shortcuts fail closed',()=>{
  assert.deepEqual(actionArgs('key',{key:'commandreturn'},{}),['kp:return']);
  assert.throws(()=>actionArgs('key',{key:'command-q'},{}));
});

test('scroll uses raw numeric desktop coordinates and bounded pixel amounts',()=>{
  assert.deepEqual(actionArgs('scroll',{x:'100',y:'200',amount:'600'},s),['-1678','100','600']);
  assert.throws(()=>actionArgs('scroll',{x:'100',y:'200',amount:'0'},s));
  assert.throws(()=>actionArgs('scroll',{x:'100',y:'200',amount:'6000'},s));
  assert.throws(()=>actionArgs('scroll',{x:'100',y:'200',amount:'600'},{...s,bounds:null}));
});
