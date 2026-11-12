import test from 'node:test';
import assert from 'node:assert/strict';
import { screenPoint } from '../scripts/geometry.mjs';
const snapshot = { version:1, createdAt:100000, consumed:false, windowId:12, pid:34, bundleId:'com.tencent.xinWeChat', width:2000,height:1600,bounds:{x:-1000,y:40,width:1000,height:800} };
test('Retina pixels map to desktop points including negative origins', () => {
  assert.deepEqual(screenPoint(snapshot,1000,800),{x:-500,y:440});
});
test('1x mapping supports secondary display origins', () => {
  assert.deepEqual(screenPoint({...snapshot,width:1000,height:800},100,200),{x:-900,y:240});
});
test('invalid and out-of-bounds points rejected', () => {
  for (const [x,y] of [[-1,0],[0,-1],[2000,0],[0,1600],[NaN,0],[Infinity,0]]) assert.throws(()=>screenPoint(snapshot,x,y));
  assert.throws(()=>screenPoint({...snapshot,width:0},0,0));
});
