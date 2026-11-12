import test from 'node:test';
import assert from 'node:assert/strict';
import {topLeftScreens,screenRect,largestWeChatWindow,locateWeChatWindow,cropForWindow} from '../scripts/window.mjs';

const screens=[
  {index:0,x:0,y:0,width:2560,height:1440,scale:2,name:'Main'},
  {index:1,x:-1728,y:323,width:1728,height:1117,scale:2,name:'Built-in'},
];
const window={id:'42',owner:'WeChat',name:'微信',bounds:{x:-1374,y:78,width:1010,height:995}};

test('AppKit bottom-left screen frames convert to top-left desktop coordinates',()=>{
  const converted=topLeftScreens(screens);
  assert.deepEqual(screenRect(converted[0]),{x:0,y:0,width:2560,height:1440});
  assert.deepEqual(screenRect(converted[1]),{x:-1728,y:0,width:1728,height:1117});
});
test('largest on-screen WeChat window wins over helper windows',()=>{
  const small={...window,id:'7',bounds:{x:-500,y:100,width:320,height:320}};
  assert.equal(largestWeChatWindow([small,window]).id,'42');
  assert.throws(()=>largestWeChatWindow([]));
});
test('window is mapped to the display that contains its center',()=>{
  const located=locateWeChatWindow({windows:[window],screens});
  assert.equal(located.screen.index,1);
  assert.equal(located.window.id,'42');
});
test('pixel crop is derived from window and display geometry',()=>{
  const located=locateWeChatWindow({windows:[window],screens});
  assert.deepEqual(cropForWindow(located.window,located.screen),{x:708,y:156,width:2020,height:1990,scaleX:2,scaleY:2,frameWidth:3456,frameHeight:2234});
});
test('offscreen or foreign-display windows fail closed',()=>{
  const located=locateWeChatWindow({windows:[window],screens});
  const off={...window,bounds:{x:-1800,y:78,width:1010,height:995}};
  assert.throws(()=>cropForWindow(off,located.screen));
  assert.throws(()=>cropForWindow(window,{...screens[0],top:0}));
});
