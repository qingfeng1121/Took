
import { spawnSync } from 'child_process';
import fs from 'fs';
const ADB='D:/work/android-sdk/platform-tools/adb.exe';
const SER='5bf0cda4';
const OUT='D:/work/Project/Took/android/verify';
const adb=(a)=>spawnSync(ADB,['-s',SER,...a],{encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'}}).stdout||'';
const sh=(c)=>adb(['shell',c]);
const sleep=(ms)=>spawnSync(process.execPath,['-e','setTimeout(()=>{},'+ms+')']);
function nodes(){
  sh('rm -f /sdcard/n.xml'); sh('uiautomator dump /sdcard/n.xml');
  const local=OUT+'/.n-tmp.xml';
  adb(['pull','/sdcard/n.xml',local]);
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
const tap=(n)=>sh('input tap '+Math.round((n.x1+n.x2)/2)+' '+Math.round((n.y1+n.y2)/2));
const log=[];

sh('input keyevent KEYCODE_HOME'); sleep(2000);
for(let i=0;i<5;i++){sh('input swipe 900 1200 100 1200 200'); sleep(400);}
sh('input swipe 540 500 540 500 1000'); sleep(2500);
sh('input tap 648 2180'); sleep(3000);
let ns=nodes();
log.push({pickerTitle: !!ns.find(n=>n.label==='添加小部件'), n: ns.length});
const tabs=ns.filter(n=>n.label==='分类');
log.push({categoryNodes: tabs.map(t=>({click:t.click,x:t.x1}))});
const catClick=tabs.find(t=>t.click)||tabs[0];
if(catClick){tap(catClick); sleep(2200);}
ns=nodes();
log.push({afterCategory: ns.filter(n=>n.id&&n.id.includes('tv_title')).map(n=>n.label).slice(0,10)});

let found=false;
for(let i=0;i<12;i++){
  ns=nodes();
  if(ns.some(n=>n.label&&n.label.startsWith('倒数日 '))){found=true;break;}
  sh('input swipe 540 1800 540 700 300'); sleep(1200);
}
log.push({foundCountdown: found});
if(found){
  ns=nodes();
  const cd=ns.filter(n=>n.label&&n.label.startsWith('倒数日 '));
  log.push({countdownPreviews: cd.map(c=>({label:c.label,x:c.x1,y:c.y1,click:c.click}))});
  fs.writeFileSync(OUT+'/_pk-countdown.json', JSON.stringify(cd,null,1));
}
console.log(JSON.stringify(log,null,1));
