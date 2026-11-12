// Window geometry via read-only CoreGraphics/AppKit metadata.
// No accessibility tree traversal, no app scripting, no injection.
import {spawnSync} from 'node:child_process';

const WINDOW_QUERY=`
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function unwrap(v){try{return ObjC.unwrap(v);}catch(e){return null;}}
var arr=ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly|$.kCGWindowListExcludeDesktopElements,$.kCGNullWindowID));
var windows=[];
for(var i=0;i<arr.count;i++){
  var d=ObjC.unwrap(arr.objectAtIndex(i));
  var owner=unwrap(d.kCGWindowOwnerName)||"";
  if(owner!=="WeChat"&&owner!=="微信")continue;
  if(unwrap(d.kCGWindowLayer)!==0)continue;
  var alpha=unwrap(d.kCGWindowAlpha);
  if(!(alpha>0.5))continue;
  var b=d.kCGWindowBounds,o={};
  ["X","Y","Width","Height"].forEach(function(k){o[k]=unwrap(b.objectForKey(k));});
  if(!(o.Width>=300&&o.Height>=300))continue;
  windows.push({id:String(unwrap(d.kCGWindowNumber)),owner:owner,name:unwrap(d.kCGWindowName)||"",
    bounds:{x:o.X,y:o.Y,width:o.Width,height:o.Height}});
}
var screens=[];
var list=ObjC.unwrap($.NSScreen.screens)||[];
for(var j=0;j<list.length;j++){
  var f=ObjC.unwrap(list[j].frame);
  screens.push({index:j,x:f.origin.x,y:f.origin.y,width:f.size.width,height:f.size.height,
    scale:Number(unwrap(list[j].backingScaleFactor))||1,name:unwrap(list[j].localizedName)||""});
}
JSON.stringify({windows:windows,screens:screens});
`;

export function windowQuery(code=WINDOW_QUERY,run=spawnSync){
  const r=run('/usr/bin/osascript',['-l','JavaScript','-e',code],{encoding:'utf8',timeout:5000});
  if(r.error||r.status!==0)throw new Error(`Cannot read window geometry: ${r.error?.message||r.stderr||r.status}`);
  return JSON.parse(r.stdout);
}

// AppKit screen frames use a bottom-left origin; convert to the top-left
// desktop coordinates used by screenshots and CGWindowBounds.
export function topLeftScreens(screens){
  if(!Array.isArray(screens)||!screens.length)throw new Error('No active displays reported');
  const maxBottom=Math.max(...screens.map(s=>s.y+s.height));
  return screens.map(s=>({...s,top:s.top??(maxBottom-(s.y+s.height))}));
}

export function screenRect(screen){
  return {x:screen.x,y:screen.top,width:screen.width,height:screen.height};
}

export function largestWeChatWindow(windows){
  if(!Array.isArray(windows)||!windows.length)throw new Error('WeChat window not found on screen; open the main WeChat window and retry');
  return [...windows].sort((a,b)=>(b.bounds.width*b.bounds.height)-(a.bounds.width*a.bounds.height))[0];
}

export function locateWeChatWindow(query=windowQuery()){
  const screens=topLeftScreens(query.screens),window=largestWeChatWindow(query.windows);
  const b=window.bounds,cx=b.x+b.width/2,cy=b.y+b.height/2;
  let screen=screens.find(s=>cx>=s.x&&cx<=s.x+s.width&&cy>=s.top&&cy<=s.top+s.height);
  if(!screen){
    const overlap=s=>Math.max(0,Math.min(b.x+b.width,s.x+s.width)-Math.max(b.x,s.x))*Math.max(0,Math.min(b.y+b.height,s.top+s.height)-Math.max(b.y,s.top));
    screen=[...screens].sort((a,c)=>overlap(c)-overlap(a))[0];
  }
  if(!screen)throw new Error('Cannot map WeChat window to a display');
  const sr=screenRect(screen);
  if(b.x<sr.x||b.y<sr.y||b.x+b.width>sr.x+sr.width||b.y+b.height>sr.y+sr.height)throw new Error('WeChat window is partially offscreen; move it fully onto one display');
  return {window,screen,screens,windowId:window.id};
}

// Pixel crop inside the full-display capture, derived from window and screen
// geometry. Refuses fractional or out-of-frame regions instead of guessing.
export function cropForWindow(window,screen,scaleX=screen.scale||1,scaleY=scaleX){
  const sr=screenRect(screen);
  const x=Math.round((window.bounds.x-sr.x)*scaleX),y=Math.round((window.bounds.y-sr.y)*scaleY);
  const width=Math.round(window.bounds.width*scaleX),height=Math.round(window.bounds.height*scaleY);
  const frameWidth=Math.round(sr.width*scaleX),frameHeight=Math.round(sr.height*scaleY);
  if(width<1||height<1||x<0||y<0||x+width>frameWidth||y+height>frameHeight)throw new Error('WeChat window crop is outside the captured display');
  const moveX=Math.abs((x+width/2)/scaleX+sr.x-(window.bounds.x+window.bounds.width/2));
  const moveY=Math.abs((y+height/2)/scaleY+sr.y-(window.bounds.y+window.bounds.height/2));
  if(moveX>1||moveY>1)throw new Error('WeChat window crop does not match its reported bounds');
  return {x,y,width,height,scaleX,scaleY,frameWidth,frameHeight};
}
