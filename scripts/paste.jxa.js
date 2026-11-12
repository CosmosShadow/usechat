// Executed by macOS JavaScript for Automation, not compiled; no AX tree access.
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
function run(argv) {
  var text=argv[0];
  if(!text || /[\r\n\t]/.test(text) || text.length>2000)throw new Error('Invalid single-line paste text');
  function checkFocus(){
    if(ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier)!=='com.tencent.xinWeChat')throw new Error('WeChat lost focus');
  }
  checkFocus();
  var pb=$.NSPasteboard.generalPasteboard;
  var start=Number(pb.changeCount),saved=$.NSMutableArray.alloc.init;
  var items=pb.pasteboardItems;
  for(var i=0;i<Number(items.count);i++){
    var item=items.objectAtIndex(i),clone=$.NSPasteboardItem.alloc.init,types=item.types;
    for(var j=0;j<Number(types.count);j++){
      var type=types.objectAtIndex(j),data=item.dataForType(type);
      if(!data || !clone.setDataForType(data,type))throw new Error('Cannot snapshot clipboard; no modification made');
    }
    saved.addObject(clone);
  }
  if(Number(pb.changeCount)!==start)throw new Error('Clipboard changed while snapshotting; stopped');
  var owned=null,restored=false,concurrent=false,posted=false;
  try{
    checkFocus();pb.clearContents;owned=Number(pb.changeCount);
    var wrote=pb.setStringForType($(text),$.NSPasteboardTypeString);owned=Number(pb.changeCount);
    if(!wrote)throw new Error('Clipboard write failed');
    checkFocus();if(Number(pb.changeCount)!==owned)throw new Error('Clipboard changed before paste');
    var down=$.CGEventCreateKeyboardEvent(null,9,true),up=$.CGEventCreateKeyboardEvent(null,9,false);
    if(!down || !up)throw new Error('Cannot create paste keys');
    $.CGEventSetFlags(down,1048576);$.CGEventSetFlags(up,1048576);
    $.CGEventPost(0,down);$.NSThread.sleepForTimeInterval(0.03);$.CGEventPost(0,up);posted=true;
    $.NSThread.sleepForTimeInterval(0.35);
  }finally{
    if(owned!==null && Number(pb.changeCount)===owned){
      pb.clearContents;
      restored=Number(saved.count)===0 ? true : Boolean(pb.writeObjects(saved));
    }else if(owned!==null){concurrent=true;}
  }
  return JSON.stringify({posted:posted,clipboardRestored:restored,clipboardChangedByAnotherApp:concurrent});
}
