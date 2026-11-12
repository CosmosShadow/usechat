import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {screenPoint} from './geometry.mjs';
import {tool,frontmost,accessibilityTrusted} from './tools.mjs';
import {takeShot,parseRect} from './capture.mjs';
import {loadPng,cropRgb} from './png.mjs';
export function absoluteCoordinate(n){if(!Number.isFinite(n))throw new Error('Invalid coordinate');n=Math.round(n);return n<0?`=${n}`:String(n);}
export function actionArgs(command,opts,s){
  if(command==='click'){
    if(!s.bounds)throw new Error('No calibrated desktop bounds; screenshot is view-only');
    const p=screenPoint(s,Number(opts.x),Number(opts.y));
    const kind=opts.button==='right'?'rc':opts.count==='2'?'dc':'c';
    if(opts.button && !['left','right'].includes(opts.button))throw new Error('Invalid button');
    if(opts.count && !['1','2'].includes(opts.count))throw new Error('Invalid click count');
    return ['-r',`${kind}:${absoluteCoordinate(p.x)},${absoluteCoordinate(p.y)}`];
  }
  if(command==='scroll'){
    if(!s.bounds)throw new Error('No calibrated desktop bounds; screenshot is view-only');
    const amount=Number(opts.amount);
    if(!Number.isInteger(amount)||amount===0||Math.abs(amount)>5000)throw new Error('--amount must be a nonzero integer up to 5000 pixels');
    const p=screenPoint(s,Number(opts.x),Number(opts.y));
    return [String(p.x),String(p.y),String(amount)];
  }
  if(command==='type'){
    if(typeof opts.text!=='string' || !opts.text.length || opts.text.length>2000 || /[\r\n\t]/u.test(opts.text))throw new Error('Use a single-line text of 1..2000 UTF16 units; no implicit send');
    return [`t:${opts.text}`];
  }
  if(command==='key'){
    const keys={return:'return',commandreturn:'return',enter:'return',escape:'esc',down:'arrow-down',up:'arrow-up',left:'arrow-left',right:'arrow-right',pageup:'page-up',pagedown:'page-down',tab:'tab'};
    if(!keys[opts.key])throw new Error('Unsupported key');
    return [`kp:${keys[opts.key]}`];
  }
  throw new Error('Input action unsupported');
}
export function validateReceipt(s,now=Date.now()){
  if(s.version!==2 || !Number.isFinite(s.createdAt) || now<s.createdAt || now-s.createdAt>900000 || s.consumed || !s.captureOptions)throw new Error('Stale or consumed screenshot; capture and inspect again');
  const sha=createHash('sha256').update(readFileSync(s.path)).digest('hex');
  if(sha!==s.sha256)throw new Error('Screenshot changed');
}
export function guardRects(s,command,opts){
  if(!opts.guards)throw new Error('--guards screenshot-pixel rect(s) required: title plus relevant UI content');
  const rects=opts.guards.split(';').map(parseRect);
  if(command==='click'){
    const x=Number(opts.x),y=Number(opts.y);
    if(!Number.isFinite(x)||!Number.isFinite(y))throw new Error('Invalid point');
    rects.push({x:Math.max(0,Math.min(s.width-256,Math.round(x)-128)),y:Math.max(0,Math.min(s.height-96,Math.round(y)-48)),width:Math.min(s.width,256),height:Math.min(s.height,96)});
  }
  for(const r of rects)if(r.x<0||r.y<0||r.x+r.width>s.width||r.y+r.height>s.height||r.width*r.height>1000000)throw new Error('Guard outside screenshot or too large');
  return rects;
}
export function performInput(command,opts){
  if(opts['allow-shared-input']!=='yes')throw new Error('Shared desktop input disabled unless explicitly authorized');
  if(opts['focus-wechat']!==undefined && opts['focus-wechat']!=='yes')throw new Error('--focus-wechat only accepts yes');
  const file=opts.snapshot;if(!file)throw new Error('--snapshot required');
  const lock=`${file}.lock`;closeSync(openSync(lock,'wx',0o600));
  try{
    const s=JSON.parse(readFileSync(file,'utf8'));validateReceipt(s);
    const args=actionArgs(command,opts,s),rects=guardRects(s,command,opts);
    if(opts.method && !['unicode','clipboard'].includes(opts.method))throw new Error('Unsupported typing method');
    if(opts.method==='clipboard' && (command!=='type' || opts['allow-clipboard']!=='yes'))throw new Error('Clipboard method needs explicit --allow-clipboard yes');
    if(opts['focus-wechat']==='yes'){
      const focused=spawnSync('/usr/bin/open',['-b','com.tencent.xinWeChat'],{encoding:'utf8',timeout:3000});
      if(focused.status!==0)throw new Error('Cannot explicitly focus WeChat');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
    }
    if(frontmost().bundleId!=='com.tencent.xinWeChat')throw new Error('WeChat is not frontmost. Stop; user may be working. Focus explicitly then capture again.');
    const access=accessibilityTrusted();
    if(!access.trusted)throw new Error('Accessibility permission is not granted; input would be silently dropped. Enable DeepSeek Harness in System Settings > Privacy & Security > Accessibility, then retry.');
    const fresh=takeShot(s.captureOptions);
    if(fresh.width!==s.width || fresh.height!==s.height)throw new Error(`Display changed. Inspect ${fresh.path}`);
    const originalPixels=loadPng(s.path),freshPixels=loadPng(fresh.path);
    for(const r of rects)if(!cropRgb(originalPixels,r).equals(cropRgb(freshPixels,r)))throw new Error(`Guard pixels changed; no input posted. Inspect ${fresh.path}`);
    if(Date.now()-fresh.createdAt>5000 || frontmost().bundleId!=='com.tencent.xinWeChat')throw new Error('Preflight stale or focus changed; no input posted');
    writeFileSync(file,JSON.stringify({...s,consumed:true},null,2),{mode:0o600});
    const useClipboard=command==='type' && opts.method==='clipboard';
    const useJxaKey=command==='key';
    const useJxaScroll=command==='scroll';
    const r=useClipboard
      ? spawnSync('/usr/bin/osascript',['-l','JavaScript',fileURLToPath(new URL('./paste.jxa.js',import.meta.url)),opts.text],{encoding:'utf8',timeout:6000})
      : useJxaKey ? spawnSync('/usr/bin/osascript',['-l','JavaScript',fileURLToPath(new URL('./key.jxa.js',import.meta.url)),opts.key],{encoding:'utf8',timeout:6000})
      : useJxaScroll ? spawnSync('/usr/bin/osascript',['-l','JavaScript',fileURLToPath(new URL('./scroll.jxa.js',import.meta.url)),...args],{encoding:'utf8',timeout:6000})
      : spawnSync(tool('cliclick'),args,{encoding:'utf8',timeout:6000});
    if(r.error || r.status!==0)throw new Error(`Input uncertain or failed; inspect before retrying. ${r.stderr||''}`);
    const clipboard=useClipboard?JSON.parse(r.stdout):null;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);
    try{return {action:{posted:true,command,sharedInput:true,explicitFocus:opts['focus-wechat']==='yes',pointerRestore:command==='click',clipboardModifiedByWrapper:useClipboard,clipboard},after:takeShot(s.captureOptions)};}
    catch(e){return {action:{posted:true,command},verificationError:e.message,next:'Do not replay. Capture and inspect.'};}
  }finally{unlinkSync(lock);}
}

// Capture a short scrollback sequence without OCR: the caller reads the
// returned PNGs. Only the title guard is compared, because message content
// intentionally changes between pages.
export function performRead(opts){
  if(opts['allow-shared-input']!=='yes')throw new Error('Shared desktop input disabled unless explicitly authorized');
  if(opts['focus-wechat']!==undefined && opts['focus-wechat']!=='yes')throw new Error('--focus-wechat only accepts yes');
  const file=opts.snapshot;if(!file)throw new Error('--snapshot required');
  const pagesN=Number(opts.pages??3),amount=Number(opts.amount??600);
  if(!Number.isInteger(pagesN)||pagesN<1||pagesN>12)throw new Error('--pages must be 1..12');
  if(!Number.isInteger(amount)||amount<100||amount>2000)throw new Error('--amount must be 100..2000 pixels');
  const direction=opts.direction??'up';
  if(!['up','down'].includes(direction))throw new Error('--direction must be up or down');
  const signed=direction==='up'?amount:-amount;
  const lock=`${file}.lock`;closeSync(openSync(lock,'wx',0o600));
  try{
    const s=JSON.parse(readFileSync(file,'utf8'));validateReceipt(s);
    if(!s.bounds)throw new Error('No calibrated desktop bounds; screenshot is view-only');
    const p=screenPoint(s,Number(opts.x),Number(opts.y));
    const rects=guardRects(s,'read',opts);
    if(opts['focus-wechat']==='yes'){
      const focused=spawnSync('/usr/bin/open',['-b','com.tencent.xinWeChat'],{encoding:'utf8',timeout:3000});
      if(focused.status!==0)throw new Error('Cannot explicitly focus WeChat');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
    }
    if(frontmost().bundleId!=='com.tencent.xinWeChat')throw new Error('WeChat is not frontmost. Stop; user may be working.');
    const access=accessibilityTrusted();
    if(!access.trusted)throw new Error('Accessibility permission is not granted; scrolling would be silently dropped.');
    writeFileSync(file,JSON.stringify({...s,consumed:true},null,2),{mode:0o600});
    const reference=loadPng(s.path);
    const pages=[{index:0,path:s.path,snapshot:file,sha256:s.sha256,offset:0}];
    let stopped=null,lastSha=s.sha256;
    for(let i=1;i<pagesN;i++){
      if(frontmost().bundleId!=='com.tencent.xinWeChat')throw new Error('WeChat lost focus while reading; stopped');
      const r=spawnSync('/usr/bin/osascript',['-l','JavaScript',fileURLToPath(new URL('./scroll.jxa.js',import.meta.url)),String(p.x),String(p.y),String(signed)],{encoding:'utf8',timeout:6000});
      if(r.error||r.status!==0)throw new Error(`Scroll failed: ${r.stderr||r.status}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,650);
      const shot=takeShot(s.captureOptions),fresh=loadPng(shot.path);
      for(const rect of rects)if(!cropRgb(reference,rect).equals(cropRgb(fresh,rect)))throw new Error(`Title guard changed after scrolling; stopped at ${shot.path}`);
      if(shot.sha256===lastSha){stopped='content did not move (edge reached or scroll ignored)';break;}
      pages.push({index:i,path:shot.path,snapshot:shot.snapshot,sha256:shot.sha256,offset:signed*i});
      lastSha=shot.sha256;
    }
    return {action:{read:true,sharedInput:true,explicitFocus:opts['focus-wechat']==='yes',direction,pages:pages.length,amount},pages,stopped,next:'Inspect every page; page 0 is the starting view. Do not infer content from filenames alone.'};
  }finally{unlinkSync(lock);}
}
