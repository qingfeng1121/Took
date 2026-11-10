
import { spawnSync } from 'child_process';
import fs from 'fs';
const ADB='D:/work/android-sdk/platform-tools/adb.exe';
const SER='5bf0cda4';
const OUT='D:/work/Project/Took/android/verify';
const adb=(a)=>spawnSync(ADB,['-s',SER,...a],{encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'}}).stdout||'';
const sh=(c)=>adb(['shell',c]);
const sleep=(ms)=>spawnSync(process.execPath,['-e','setTimeout(()=>{},'+ms+')']);
const focus=()=>{const s=sh('dumpsys window | grep mCurrentFocus');return s.trim();};
function nodes(){
  sh('rm -f /sdcard/n.xml'); sh('uiautomator dump /sdcard/n.xml');
  const local=OUT+'/.n-tmp.xml'; adb(['pull','/sdcard/n.xml',local]);
  let s=''; try{s=fs.readFileSync(local,'utf8');}catch(e){return [];}
  const out=[]; const re=/<node\b([^>]*)>/g; let m;
  while((m=re.exec(s))){
    const a=m[1];
    const get=(k)=>{const r=new RegExp(' '+k+'="([^"]*)"').exec(a);return r?r[1]:'';};
    const b=/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(a); if(!b)continue;
    const [x1,y1,x2,y2]=b.slice(1).map(Number);
    if(x2-x1<=0||y2-y1<=0) continue;
    out.push({label:get('text')||get('content-desc'),id:get('resource-id'),click:get('clickable')==='true',x1,y1,x2,y2});
  }
  return out;
}
const tapXY=(x,y)=>sh('input tap '+Math.round(x)+' '+Math.round(y));
const tap=(n)=>tapXY((n.x1+n.x2)/2,(n.y1+n.y2)/2);
const home=()=>{sh('input keyevent KEYCODE_HOME'); sleep(2200);};
const log=[];

// 确保在桌面：如果焦点不是 launcher，按 HOME；若还是别的，force-stop
home();
let f=focus();
if(!f.includes('com.miui.home')){
  sh('am force-stop app.took'); sleep(800); home(); f=focus();
}
log.push({focusAfterHome:f});

// 桌面编辑：长按空白
sh('input swipe 540 500 540 500 1000'); sleep(2600);
let ns=nodes();
if(!ns.some(n=>n.label==='添加小部件')){
  // 底部按钮可能文字为空，直接点坐标
  tapXY(648,2180); sleep(3000);
  ns=nodes();
}
log.push({pickerOpen: ns.some(n=>n.label==='添加小部件'), focus: focus()});

// 分类 tab
let cat=ns.filter(n=>n.label==='分类');
const cc=cat.find(t=>t.click)||cat[0];
if(cc){tap(cc); sleep(2500);}
ns=nodes();
log.push({afterCat: ns.filter(n=>n.id&&n.id.includes('tv_title')).map(n=>n.label).slice(0,6)});

// 滚动找倒数日预览
let hit=null;
for(let i=0;i<12;i++){
  ns=nodes();
  hit=ns.find(n=>n.label&&n.label.startsWith('倒数日 '));
  if(hit)break;
  sh('input swipe 540 1800 540 700 300'); sleep(1300);
}
log.push({hitPreview: hit? hit.label : null, focus: focus()});
if(!hit){console.log(JSON.stringify(log,null,1)); process.exit(0);}

// 点预览 → 详情页 → 添加到桌面
tap(hit); sleep(2600);
ns=nodes();
const addBtn=ns.find(n=>n.label==='添加到桌面');
log.push({detailPage: !!addBtn, focus: focus()});
if(addBtn){
  tap(addBtn); sleep(3500);
  log.push({afterAddFocus: focus()});
  sh('screencap -p /sdcard/cfg.png'); adb(['pull','/sdcard/cfg.png',OUT+'/ui-widget-countdown-config.png']);
  ns=nodes();
  log.push({configPage: ns.filter(n=>n.label).map(n=>n.label).slice(0,20)});
}
console.log(JSON.stringify(log,null,1));
