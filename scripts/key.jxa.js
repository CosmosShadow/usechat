// JavaScript for Automation bridge to documented CoreGraphics keyboard events.
ObjC.import('AppKit');ObjC.import('CoreGraphics');
function run(argv){
  var codes={return:36,commandreturn:36,enter:36,escape:53,down:125,up:126,left:123,right:124,pageup:116,pagedown:121,tab:48};
  var code=codes[argv[0]];if(code===undefined)throw new Error('Unsupported key');
  if(ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)!=='com.tencent.xinWeChat')throw new Error('WeChat lost focus');
  var down=$.CGEventCreateKeyboardEvent(null,code,true),up=$.CGEventCreateKeyboardEvent(null,code,false);
  if(!down || !up)throw new Error('Cannot create keyboard event');
  var flags=argv[0]==='commandreturn'?1048576:0;
  $.CGEventSetFlags(down,flags);$.CGEventSetFlags(up,flags);
  $.CGEventPost(0,down);$.NSThread.sleepForTimeInterval(0.03);$.CGEventPost(0,up);
  return JSON.stringify({posted:true,key:argv[0]});
}
