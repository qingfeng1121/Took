
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
    out.push({label:get('text')||get('content-desc'),click:get('clickable')==='true',x1,y1,x2,y2});
  }
  return out;
}
const log=[];
sh('am force-stop app.took'); sleep(800);
sh('am start -n app.took/.MainActivity'); sleep(3500);
// 向下滚动到倒数日区
for(let i=0;i<3;i++){ sh('input swipe 540 1600 540 700 400'); sleep(900); }
sleep(800);
shot('_app-scroll.png');
let ns=nodes();
const cd=ns.filter(n=>n.label&&n.label.startsWith('倒数日 '));
log.push({countdownCards: cd.map(c=>({label:c.label,bounds:[c.x1,c.y1,c.x2,c.y2],w:c.x2-c.x1,h:c.y2-c.y1}))});
console.log(JSON.stringify(log,null,1));
