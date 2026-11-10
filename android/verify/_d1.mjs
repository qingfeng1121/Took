
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
    out.push({label:get('text')||get('content-desc'),id:(get('resource-id')||'').replace('com.miui.personalassistant:id/',''),click:get('clickable')==='true',x1,y1,x2,y2});
  }
  return out;
}
const tapXY=(x,y)=>sh('input tap '+Math.round(x)+' '+Math.round(y));
const tap=(n)=>tapXY((n.x1+n.x2)/2,(n.y1+n.y2)/2);
const log=[];
sh('am force-stop app.took'); sleep(800);
sh('input keyevent KEYCODE_HOME'); sleep(2600);
// 用页面指示点跳到第 6 页（避开组件本体）
sh('input swipe 540 1880 540 1880 1000'); sleep(2600);
let ns=nodes();
log.push({editMode: ns.some(n=>n.label==='小部件'), focus:focus()});
const dots=ns.filter(n=>/^第\d+屏$/.test(n.label||''));
log.push({dots: dots.map(d=>({l:d.label,x:d.x1,w:d.x2-d.x1}))});
const d6=dots.find(d=>d.label==='第6屏');
if(d6){ tap(d6); sleep(1500); }
ns=nodes();
log.push({afterDot: (ns.find(n=>n.label&&n.label.includes('页共'))||{}).label, focus:focus()});
shot('_d1-page6.png');
console.log(JSON.stringify(log,null,1));
