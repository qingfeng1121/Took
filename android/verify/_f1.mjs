
import { spawnSync } from 'child_process';
import fs from 'fs';
const ADB='D:/work/android-sdk/platform-tools/adb.exe';
const SER='5bf0cda4';
const OUT='D:/work/Project/Took/android/verify';
const adb=(a)=>spawnSync(ADB,['-s',SER,...a],{encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'}}).stdout||'';
const sh=(c)=>adb(['shell',c]);
const sleep=(ms)=>spawnSync(process.execPath,['-e','setTimeout(()=>{},'+ms+')']);
const shot=(n)=>{sh('screencap -p /sdcard/s.png'); adb(['pull','/sdcard/s.png',OUT+'/'+n]);};
const focus=()=>sh('dumpsys window | grep mCurrentFocus').trim().split('\n')[0];
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
const log=[];
sh('am force-stop app.took'); sleep(900);
sh('input keyevent KEYCODE_HOME'); sleep(2600);
log.push({f1:focus()});
// 长按第 1 页底部空白（页面指示条区域 y≈1880，dock 从 1996 开始）
sh('input swipe 540 1880 540 1880 1100'); sleep(2800);
let ns=nodes();
log.push({f2:focus(), editMode: ns.some(n=>n.label==='小部件'||n.label==='壁纸')});
shot('_f1-edit.png');
const btn=ns.find(n=>n.label==='小部件');
log.push({widgetBtn: btn?{x:btn.x1,y:btn.y1,w:btn.x2-btn.x1,h:btn.y2-btn.y1}:null});
if(btn){
  const cx=Math.round((btn.x1+btn.x2)/2), cy=Math.round((btn.y1+btn.y2)/2);
  sh('input tap '+cx+' '+cy); sleep(3200);
  ns=nodes();
  log.push({f3:focus(), pickerOpen: ns.some(n=>n.label==='添加小部件')});
  shot('_f2-picker.png');
}
console.log(JSON.stringify(log,null,1));
