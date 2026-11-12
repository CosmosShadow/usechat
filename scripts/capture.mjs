import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { tool,screenDevices } from './tools.mjs';
import {decodePng,encodeRgbPng,cropRgb,pngInfo} from './png.mjs';
import {locateWeChatWindow,windowQuery,screenRect,cropForWindow} from './window.mjs';
export {pngInfo};
export function parseRect(raw) {
  if (typeof raw !== 'string' || !/^-?\d+,-?\d+,\d+,\d+$/.test(raw)) throw new Error('rect must be x,y,width,height in desktop logical points');
  const [x,y,width,height] = raw.split(',').map(Number);
  if (![x,y,width,height].every(Number.isSafeInteger) || Math.abs(x)>50000 || Math.abs(y)>50000 || width<1 || height<1 || width>16000 || height>16000) throw new Error('rect out of range');
  return {x,y,width,height};
}
export function captureSpec(options) {
  if ((options.rect === undefined) === (options.display === undefined)) throw new Error('Choose exactly one of --rect or --display');
  if (options.rect !== undefined) {
    const bounds=parseRect(options.rect);
    return {args:[`-R${bounds.x},${bounds.y},${bounds.width},${bounds.height}`],bounds,display:null};
  }
  const display=Number(options.display);
  if (!Number.isInteger(display) || display<1 || display>16) throw new Error('display must be 1..16 (screencapture ordinal, not CGDisplayID)');
  // Whole-display screenshots are view-only until screen geometry is established.
  return {args:[`-D${display}`],bounds:null,display};
}
function sameBounds(a,b){
  return a&&b&&['x','y','width','height'].every(k=>Math.abs(a[k]-b[k])<=0.5);
}
function ffmpegArgs(device){
  return ['-hide_banner','-loglevel','error','-nostdin','-n','-f','avfoundation','-capture_cursor','0','-pixel_format','0rgb','-framerate','2','-i',`${device}:none`,'-ss','0.3','-frames:v','1','-update','1'];
}
function receiptBase({path,size,bounds,display,captureMode,backend,options,extra={}}){
  return {version:2,createdAt:Date.now(),path,...size,bounds,display,
    captureMode,backend,inputPosted:false,targetVerified:false,
    captureOptions:options,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),...extra};
}
function takeWeChatShot(options,{run,cache}={}){
  if(options.bounds!==undefined)throw new Error('--wechat derives bounds automatically; remove --bounds');
  const located=locateWeChatWindow();
  let screen=located.screen;
  if(options.screen!==undefined){
    const index=Number(options.screen);
    if(!Number.isInteger(index)||index<0||index>15)throw new Error('ffmpeg --screen requires a zero-based screen number');
    const selected=located.screens.find(s=>s.index===index);
    if(!selected)throw new Error('Requested screen is not an active display');
    screen=selected;
  }
  const sr=screenRect(screen),scale=screen.scale||1;
  const device=screenDevices().find(d=>d.screen===screen.index)?.device;
  if(device===undefined)throw new Error('Screen not found; run screens first');
  mkdirSync(cache,{recursive:true,mode:0o700});
  const stem=join(cache,`${Date.now()}-${randomUUID()}`),full=`${stem}.full.png`,path=`${stem}.png`;
  const args=[...ffmpegArgs(device),full];
  const r=run(tool('ffmpeg'),args,{encoding:'utf8',timeout:15000});
  try{
    if(r.error||r.status!==0)throw new Error(`Screen capture failed: ${r.error?.message||r.stderr||r.status}`);
    const fullBytes=readFileSync(full),fullSize=pngInfo(fullBytes);
    const c=cropForWindow(located.window,screen,fullSize.width/sr.width,fullSize.height/sr.height);
    const image=decodePng(fullBytes);
    const rgb=cropRgb(image,{x:c.x,y:c.y,width:c.width,height:c.height});
    const bytes=encodeRgbPng(c.width,c.height,rgb),size=pngInfo(bytes);
    writeFileSync(path,bytes,{flag:'wx',mode:0o600});
    chmodSync(path,0o600);
    const fresh=windowQuery(),now=fresh.windows.find(w=>w.id===located.window.id);
    if(!now||!sameBounds(now.bounds,located.window.bounds))throw new Error('WeChat window moved during capture; retry');
    const resolved={...options,backend:'ffmpeg',screen:String(screen.index)};
    delete resolved.bounds;
    const receipt=receiptBase({path,size,bounds:located.window.bounds,display:null,captureMode:'wechat-window-pixels',
      backend:'ffmpeg-avfoundation',options:resolved,extra:{
        window:{id:located.window.id,owner:located.window.owner,title:located.window.name},
        screen:{index:screen.index,name:screen.name,scale,bounds:sr},
        source:{width:fullSize.width,height:fullSize.height,crop:c},
      }});
    const snapshot=`${stem}.snapshot.json`;
    writeFileSync(snapshot,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
    return {...receipt,snapshot,next:'Open PNG and visually verify WeChat. A saved image is NOT target verification.'};
  }finally{
    try{unlinkSync(full);}catch{}
  }
}
export function takeShot(options,{run=spawnSync,cache=join(homedir(),'Library','Caches','wechat-visual')}={}) {
  if(options.wechat==='yes')return takeWeChatShot(options,{run,cache});
  let spec, executable='/usr/sbin/screencapture';
  if(options.backend==='ffmpeg'){
    const screen=Number(options.screen);
    if(!Number.isInteger(screen) || screen<0 || screen>15)throw new Error('ffmpeg --screen requires a zero-based screen number');
    const device=screenDevices().find(d=>d.screen===screen)?.device;
    if(device===undefined)throw new Error('Screen not found; run screens first');
    executable=tool('ffmpeg');
    spec={args:ffmpegArgs(device),bounds:options.bounds?parseRect(options.bounds):null,display:null,screen};
  }else{
    if(options.backend && options.backend!=='system')throw new Error('Unsupported screenshot backend');
    spec=captureSpec(options);
    spec.args=['-x','-t','png',...spec.args];
  }
  mkdirSync(cache,{recursive:true,mode:0o700});
  const stem=join(cache,`${Date.now()}-${randomUUID()}`), path=`${stem}.png`;
  const r=run(executable,[...spec.args,path],{encoding:'utf8',timeout:15000});
  if (r.error || r.status!==0) throw new Error(`Screen capture failed: ${r.error?.message || r.stderr || r.status}`);
  const bytes=readFileSync(path), size=pngInfo(bytes);
  chmodSync(path,0o600);
  const receipt=receiptBase({path,size,bounds:spec.bounds,display:spec.display,captureMode:'desktop-pixels',
    backend:options.backend==='ffmpeg'?'ffmpeg-avfoundation':'nodejs-system-screencapture',options});
  const snapshot=`${stem}.snapshot.json`;
  writeFileSync(snapshot,JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
  return {...receipt,snapshot,next:'Open PNG and visually verify WeChat. A saved image is NOT target verification.'};
}
export function verifyFile(file) {
  const s=statSync(file);
  if (!s.isFile() || s.size===0) throw new Error('Expected a nonempty regular file');
  return {file,bytes:s.size,sha256:createHash('sha256').update(readFileSync(file)).digest('hex'),
    originVerified:false,note:'Filesystem check only; match the visible chat file card to establish origin.'};
}
