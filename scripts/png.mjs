// Narrow, fail-closed decoder and RGB encoder for our own screenshots.
// No OCR or external image process. Guard comparison ignores alpha, like rgb24.
import {inflateSync,deflateSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
export function pngInfo(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || buffer.toString('ascii',12,16)!=='IHDR') throw new Error('Capture did not produce a PNG');
  const width=buffer.readUInt32BE(16), height=buffer.readUInt32BE(20);
  if (!width || !height || width>32000 || height>32000) throw new Error('Invalid PNG dimensions');
  return {width,height};
}
function paeth(a,b,c){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;}
export function decodePng(bytes){
  const {width,height}=pngInfo(bytes),type=bytes[25],channels=type===2?3:type===6?4:0;
  if(bytes[24]!==8||!channels||bytes[26]||bytes[27]||bytes[28]||width*height>40000000)throw new Error('Unsupported PNG screenshot encoding');
  const parts=[];let end=false;
  for(let pos=8;pos+12<=bytes.length;){
    const n=bytes.readUInt32BE(pos),name=bytes.toString('ascii',pos+4,pos+8);
    if(n>bytes.length-pos-12)throw new Error('Truncated PNG chunk');
    if(name==='IDAT')parts.push(bytes.subarray(pos+8,pos+8+n));
    pos+=n+12;if(name==='IEND'){end=true;break;}
  }
  if(!end||!parts.length)throw new Error('Incomplete PNG');
  const stride=width*channels,expected=(stride+1)*height;
  const raw=inflateSync(Buffer.concat(parts),{maxOutputLength:expected});
  if(raw.length!==expected)throw new Error('Invalid PNG pixel length');
  const pixels=Buffer.alloc(stride*height);
  for(let y=0;y<height;y++){
    const filter=raw[y*(stride+1)];if(filter>4)throw new Error('Unsupported PNG row filter');
    for(let x=0;x<stride;x++){
      const i=y*stride+x,a=x>=channels?pixels[i-channels]:0,b=y?pixels[i-stride]:0,c=y&&x>=channels?pixels[i-stride-channels]:0;
      const predictor=filter===0?0:filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):paeth(a,b,c);
      pixels[i]=(raw[y*(stride+1)+1+x]+predictor)&255;
    }
  }
  return {width,height,channels,pixels};
}
export function loadPng(path){return decodePng(readFileSync(path));}
export function cropRgb(img,r){
  if(![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>img.width||r.y+r.height>img.height)throw new Error('Invalid pixel crop');
  const out=Buffer.alloc(r.width*r.height*3);let j=0;
  for(let y=r.y;y<r.y+r.height;y++)for(let x=r.x;x<r.x+r.width;x++){
    const i=(y*img.width+x)*img.channels;
    out[j++]=img.pixels[i];out[j++]=img.pixels[i+1];out[j++]=img.pixels[i+2];
  }
  return out;
}
const CRC_TABLE=(()=>{const t=new Int32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c;}return t;})();
function crc32(bytes){let c=0xffffffff;for(let i=0;i<bytes.length;i++)c=CRC_TABLE[(c^bytes[i])&0xff]^(c>>>8);return (c^0xffffffff)>>>0;}
function chunk(type,data){
  const out=Buffer.alloc(data.length+12);
  out.writeUInt32BE(data.length,0);out.write(type,4,'ascii');data.copy(out,8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type,'ascii'),data])),8+data.length);
  return out;
}
export function encodeRgbPng(width,height,pixels){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>40000000)throw new Error('Invalid PNG dimensions');
  if(!Buffer.isBuffer(pixels)||pixels.length!==width*height*3)throw new Error('RGB pixel buffer length mismatch');
  const stride=width*3,raw=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y++){raw[y*(stride+1)]=0;pixels.copy(raw,y*(stride+1)+1,y*stride,(y+1)*stride);}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw,{level:3})),chunk('IEND',Buffer.alloc(0))]);
}
