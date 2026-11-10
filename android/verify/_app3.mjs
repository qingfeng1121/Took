
import { spawnSync } from 'child_process';
import fs from 'fs';
const ADB='D:/work/android-sdk/platform-tools/adb.exe';
const SER='5bf0cda4';
const OUT='D:/work/Project/Took/android/verify';
const adb=(a)=>spawnSync(ADB,['-s',SER,...a],{encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'}}).stdout||'';
const sh=(c)=>adb(['shell',c]);
const sleep=(ms)=>spawnSync(process.execPath,['-e','setTimeout(()=>{},'+ms+')']);
const shot=(n)=>{sh('screencap -p /sdcard/s.png'); adb(['pull','/sdcard/s.png',OUT+'/'+n]);};
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
    out.push({label:get('text')||get('content-desc'),cls:get('class'),scroll:get('scrollable')==='true',click:get('clickable')==='true',x1,y1,x2,y2});
  }
  return out;
}
const log=[];
sh('am force-stop app.took'); sleep(800);
sh('am start -n app.took/.MainActivity'); sleep(3500);
let ns=nodes();
log.push({scrollables: ns.filter(n=>n.scroll).map(n=>({b:[n.x1,n.y1,n.x2,n.y2],c:n.cls}))});
// 用滚动容器的中心点滑
const sc=ns.find(n=>n.scroll);
if(sc){
  const cx=Math.round((sc.x1+sc.x2)/2);
  for(let i=0;i<3;i++){ sh('input swipe '+cx+' 1600 '+cx+' 700 400'); sleep(1000); }
  sleep(700);
  shot('_app-scroll3.png');
  ns=nodes();
  log.push({countdown: ns.filter(n=>n.label&&n.label.startsWith('倒数日 ')).map(n=>n.label)});
  log.push({tail: ns.filter(n=>n.label).slice(-12).map(n=>n.label)});
}
console.log(JSON.stringify(log,null,1));
