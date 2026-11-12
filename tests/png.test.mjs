import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {decodePng,cropRgb,encodeRgbPng,pngInfo} from '../scripts/png.mjs';
function chunk(name,data){const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(name,4);data.copy(b,8);return b;}
function fixture(channels){
  const width=4,height=5,stride=width*channels,pixels=Buffer.from(Array.from({length:stride*height},(_,i)=>(i*37)%256)),raw=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y++){raw[y*(stride+1)]=y;
    for(let x=0;x<stride;x++){const i=y*stride+x,a=x>=channels?pixels[i-channels]:0,b=y?pixels[i-stride]:0,c=y&&x>=channels?pixels[i-stride-channels]:0,p=a+b-c,d=[Math.abs(p-a),Math.abs(p-b),Math.abs(p-c)],pa=d[0]<=d[1]&&d[0]<=d[2]?a:d[1]<=d[2]?b:c;
      raw[y*(stride+1)+x+1]=(pixels[i]-[0,a,b,Math.floor((a+b)/2),pa][y])&255;
    }
  }
  const h=Buffer.alloc(13);h.writeUInt32BE(width);h.writeUInt32BE(height,4);h[8]=8;h[9]=channels===3?2:6;
  return {bytes:Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]),pixels};
}
for(const channels of [3,4])test(`PNG ${channels} channels: all five filters and RGB crop`,()=>{
  const {bytes,pixels}=fixture(channels),img=decodePng(bytes);assert.deepEqual(img.pixels,pixels);
  const got=cropRgb(img,{x:1,y:2,width:2,height:1});assert.deepEqual(got,Buffer.from([...pixels.subarray(9*channels,9*channels+3),...pixels.subarray(10*channels,10*channels+3)]));
  assert.throws(()=>cropRgb(img,{x:-1,y:0,width:1,height:1}));
});
test('unsupported and truncated screenshot formats fail closed',()=>{
  const {bytes}=fixture(3);const wrong=Buffer.from(bytes);wrong[28]=1;assert.throws(()=>decodePng(wrong));assert.throws(()=>decodePng(bytes.subarray(0,-12)));
});

test('RGB encoder round-trips through the fail-closed decoder',()=>{
  const width=7,height=3,pixels=Buffer.from(Array.from({length:width*height*3},(_,i)=>(i*29)%256));
  const bytes=encodeRgbPng(width,height,pixels);
  assert.deepEqual(pngInfo(bytes),{width,height});
  const img=decodePng(bytes);
  assert.equal(img.channels,3);
  assert.deepEqual(img.pixels,pixels);
  assert.throws(()=>encodeRgbPng(2,2,Buffer.alloc(5)));
});
