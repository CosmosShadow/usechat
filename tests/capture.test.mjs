import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,statSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRect,pngInfo,captureSpec,takeShot,verifyFile } from '../scripts/capture.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=','base64');
test('negative desktop origin accepted',()=>assert.deepEqual(parseRect('-1728,0,1010,995'),{x:-1728,y:0,width:1010,height:995}));
test('reject invalid bounds and shell-looking text',()=>{
  for(const s of ['a,0,1,1','0,0,0,1','0,0,-1,1','0,0,1.5,1','0,0,1,1;ls','0,0,20000,1'])assert.throws(()=>parseRect(s));
});
test('capture scope is explicit and display IDs are not interchangeable',()=>{
  assert.throws(()=>captureSpec({}));assert.throws(()=>captureSpec({rect:'0,0,1,1',display:'2'}));
  for(const display of ['0','-1','NaN','17','1.2'])assert.throws(()=>captureSpec({display}));
  assert.deepEqual(captureSpec({display:'2'}),{args:['-D2'],bounds:null,display:2});
});
test('PNG dimensions are original pixels; reject invalid image',()=>{
  assert.deepEqual(pngInfo(png),{width:1,height:1});assert.throws(()=>pngInfo(Buffer.alloc(100)));
});
test('capture invokes only screenshot executable with private output; never verifies target automatically',()=>{
  const cache=mkdtempSync(join(tmpdir(),'wechat-capture-test-'));
  try{
    const result=takeShot({rect:'-1728,0,1010,995'},{cache,run:(exe,args,opts)=>{
      assert.equal(exe,'/usr/sbin/screencapture');assert.deepEqual(args.slice(0,-1),['-x','-t','png','-R-1728,0,1010,995']);
      assert.equal(opts.shell,undefined);writeFileSync(args.at(-1),png);return{status:0};
    }});
    assert.equal(result.targetVerified,false);assert.equal(result.inputPosted,false);
    assert.equal(statSync(result.path).mode&0o777,0o600);
    assert.equal(JSON.parse(readFileSync(result.snapshot)).version,2);
  }finally{rmSync(cache,{recursive:true,force:true});}
});
test('failed capture does not emit a success receipt',()=>{
  const cache=mkdtempSync(join(tmpdir(),'wechat-failed-test-'));
  try{assert.throws(()=>takeShot({display:'2'},{cache,run:()=>({status:1,stderr:'denied'})}),/denied/);}
  finally{rmSync(cache,{recursive:true,force:true});}
});
test('file verification checks bytes, not chat origin',()=>{
  const dir=mkdtempSync(join(tmpdir(),'wechat-file-test-'));const p=join(dir,'fixture.txt');
  try{writeFileSync(p,'abc');assert.equal(verifyFile(p).bytes,3);assert.equal(verifyFile(p).originVerified,false);writeFileSync(p,'');assert.throws(()=>verifyFile(p));}
  finally{rmSync(dir,{recursive:true,force:true});}
});
