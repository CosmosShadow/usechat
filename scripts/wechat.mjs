#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { takeShot,verifyFile } from './capture.mjs';
import {screenDevices,tool,accessibilityTrusted} from './tools.mjs';
import {windowQuery,topLeftScreens} from './window.mjs';
import {performInput,performRead} from './input.mjs';
import {spawnSync} from 'node:child_process';
const help=`WeChat visual skill — Node.js, no Swift, OCR, UI tree, database or listener.
  node scripts/wechat.mjs doctor
  node scripts/wechat.mjs shot --rect '348,232,1010,995'
  node scripts/wechat.mjs screens
  node scripts/wechat.mjs shot --wechat yes
  node scripts/wechat.mjs shot --backend ffmpeg --screen 1 --bounds '-1728,0,1728,1117'
  node scripts/wechat.mjs shot --display 2
  node scripts/wechat.mjs focus --allow-shared-input yes
  node scripts/wechat.mjs click --snapshot FILE --x PIXEL --y PIXEL --guards 'x,y,w,h' --allow-shared-input yes
  node scripts/wechat.mjs type --snapshot FILE --text '测试文字' --method clipboard --allow-clipboard yes --guards 'x,y,w,h' --allow-shared-input yes
  node scripts/wechat.mjs key --snapshot FILE --key return --guards 'title-rect;draft-rect' --allow-shared-input yes
  node scripts/wechat.mjs scroll --snapshot FILE --x PIXEL --y PIXEL --amount 600 --guards 'title-rect' --allow-shared-input yes
  node scripts/wechat.mjs read --snapshot FILE --x PIXEL --y PIXEL --pages 3 --amount 600 --guards 'title-rect' --allow-shared-input yes
  node scripts/wechat.mjs verify-download --file '/absolute/path/to/download.pdf'
Capture rect/bounds use desktop logical points; input x/y/guards use original PNG pixels. Negative monitor origins are supported.
Display is screencapture's ordinal: 1 main, 2 secondary; not a CGDisplayID.
Capture does NOT activate apps, move the pointer, request permissions or simulate input.
Always inspect the PNG; receipt targetVerified:false is intentional.
Input is disabled by default. Focus/click/type/key need --allow-shared-input yes and use shared desktop focus. Optional --focus-wechat yes on input explicitly reactivates WeChat before guards; requires user authorization. Read SKILL.md first. No watcher or timer service.
No guarantee of account safety or app stability. On blank/missing WeChat, stop rather than blind-click.`;
function main(){
  const [command,...args]=process.argv.slice(2);
  if (!command || command==='--help'){console.log(help);return;}
  if (['focus','click','type','key','scroll','read'].includes(command) && !args.includes('--allow-shared-input')) throw new Error('Shared desktop input disabled unless explicitly authorized');
  if (!['doctor','screens','shot','verify-download','focus','click','type','key','scroll','read'].includes(command)) throw new Error('Unknown command');
  const opts={},allowed={doctor:[],screens:[],shot:['rect','display','backend','screen','bounds','wechat'],'verify-download':['file'],focus:['allow-shared-input'],click:['snapshot','x','y','button','count','guards','allow-shared-input','focus-wechat'],scroll:['snapshot','x','y','amount','guards','allow-shared-input','focus-wechat'],read:['snapshot','x','y','pages','amount','direction','guards','allow-shared-input','focus-wechat'],type:['snapshot','text','method','allow-clipboard','guards','allow-shared-input','focus-wechat'],key:['snapshot','key','guards','allow-shared-input','focus-wechat']}[command];
  for(let i=0;i<args.length;i+=2){
    const key=args[i].slice(2);
    if(!args[i].startsWith('--') || args[i+1]===undefined || !allowed.includes(key) || Object.hasOwn(opts,key)) throw new Error('Use valid unique --name value options');
    opts[key]=args[i+1];
  }
  let result;
  if(command==='screens'){
    const devices=screenDevices();
    let geometry=[];
    try{geometry=topLeftScreens(windowQuery().screens);}catch{}
    console.log(JSON.stringify(devices.map(d=>{const g=geometry.find(x=>x.index===d.screen);return g?{...d,bounds:{x:g.x,y:g.top,width:g.width,height:g.height},scale:g.scale,name:g.name}:d;}),null,2));return;
  }
  if(command==='focus'){
    if(opts['allow-shared-input']!=='yes')throw new Error('Shared desktop input disabled unless explicitly authorized');
    const r=spawnSync('/usr/bin/open',['-b','com.tencent.xinWeChat'],{encoding:'utf8',timeout:3000});
    if(r.status!==0)throw new Error('Cannot activate WeChat');
    console.log(JSON.stringify({activated:true,sharedFocus:true,next:'Take and inspect a fresh screenshot before input'}));return;
  }
  if(command==='read'){console.log(JSON.stringify(performRead(opts),null,2));return;}
  if(['click','type','key','scroll'].includes(command)){console.log(JSON.stringify(performInput(command,opts),null,2));return;}
  function available(name){try{tool(name);return true;}catch{return false;}}
  if(command==='doctor') result={dependencies:{ffmpeg:available('ffmpeg'),cliclick:available('cliclick'),jxa:existsSync('/usr/bin/osascript')},accessibility:accessibilityTrusted(),platform:process.platform,node:process.versions.node,
    screencapture:existsSync('/usr/sbin/screencapture'),swiftRequired:false,npmDependencies:0,guardBackend:'nodejs-zlib',ffmpegRequiredForSystemCapture:false,
    capabilities:{screenCapture:process.platform==='darwin',scroll:'opt-in CoreGraphics wheel events',read:'batched overlapping window screenshots',appScopedInput:false,clipboardPaste:'explicit opt-in; in-memory snapshot with conditional restoration',globalInput:'opt-in only; cliclick and foreground focus required',ocr:false,treeAccess:false,listener:false},
    screenRecordingPermission:'not probed; capture result determines availability'};
  else if(command==='shot'){
    if(process.platform!=='darwin') throw new Error('System screenshot backend currently supports macOS only');
    result=takeShot(opts);
  }else{
    if(!opts.file) throw new Error('--file required');
    result=verifyFile(resolve(opts.file));
  }
  console.log(JSON.stringify(result,null,2));
}
try{main();}catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}
