import { spawnSync } from 'node:child_process';
export function tool(name){
  if(!['ffmpeg','cliclick'].includes(name))throw new Error('Unknown tool');
  const r=spawnSync('/usr/bin/which',[name],{encoding:'utf8',timeout:3000});
  if(r.status!==0 || !r.stdout.trim())throw new Error(`${name} missing: use an existing trusted installation; no auto-install or compile`);
  return r.stdout.trim();
}
export function screenDevices(run=spawnSync){
  const r=run(tool('ffmpeg'),['-hide_banner','-f','avfoundation','-list_devices','true','-i',''],{encoding:'utf8',timeout:8000});
  if(r.error)throw r.error;
  return [...(r.stderr||'').matchAll(/\[(\d+)\] Capture screen (\d+)/g)].map(m=>({device:Number(m[1]),screen:Number(m[2])}));
}
export function frontmost(){
  const code='ObjC.import("AppKit"); var a=$.NSWorkspace.sharedWorkspace.frontmostApplication; JSON.stringify({bundleId:ObjC.unwrap(a.bundleIdentifier),pid:Number(a.processIdentifier)})';
  const r=spawnSync('/usr/bin/osascript',['-l','JavaScript','-e',code],{encoding:'utf8',timeout:4000});
  if(r.status!==0)throw new Error('Cannot confirm frontmost application');
  return JSON.parse(r.stdout);
}
export function accessibilityTrusted(run=spawnSync){
  const code='ObjC.import("ApplicationServices"); $.AXIsProcessTrusted()';
  const r=run('/usr/bin/osascript',['-l','JavaScript','-e',code],{encoding:'utf8',timeout:4000});
  if(!r.error && r.status===0 && /^(true|false)$/.test(r.stdout.trim()))return {trusted:r.stdout.trim()==='true',source:'AXIsProcessTrusted'};
  try{
    const probe=run(tool('cliclick'),['p'],{encoding:'utf8',timeout:3000});
    return {trusted:!(probe.stderr||'').includes('Accessibility privileges not enabled'),source:'cliclick-probe'};
  }catch(e){return {trusted:false,source:'unavailable',detail:e.message};}
}
