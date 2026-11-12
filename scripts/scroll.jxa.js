// JavaScript for Automation bridge to documented CoreGraphics scroll events.
// Does not traverse the AX tree; posts one wheel event at the requested point.
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(argv){
  var x=Number(argv[0]),y=Number(argv[1]),amount=Number(argv[2]);
  if(![x,y,amount].every(Number.isFinite)||Math.abs(x)>50000||Math.abs(y)>50000||amount===0||Math.abs(amount)>5000)throw new Error('Invalid scroll request');
  if(ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)!=='com.tencent.xinWeChat')throw new Error('WeChat lost focus');
  var current=$.CGEventGetLocation($.CGEventCreate(null));
  $.CGWarpMouseCursorPosition($.CGPointMake(x,y));
  $.NSThread.sleepForTimeInterval(0.05);
  var event=$.CGEventCreateScrollWheelEvent(null,$.kCGScrollEventUnitPixel,1,amount);
  if(!event)throw new Error('Cannot create scroll event');
  $.CGEventSetLocation(event,$.CGPointMake(x,y));
  $.CGEventPost($.kCGHIDEventTap,event);
  $.NSThread.sleepForTimeInterval(0.05);
  $.CGWarpMouseCursorPosition($.CGPointMake(Number(current.x),Number(current.y)));
  return JSON.stringify({posted:true,amount:amount,x:x,y:y,unit:'pixel'});
}
