
import { spawnSync } from 'child_process';
import fs from 'fs';
const ADB='D:/work/android-sdk/platform-tools/adb.exe';
const SER='5bf0cda4';
const OUT='D:/work/Project/Took/android/verify';
const adb=(a,env)=>spawnSync(ADB,['-s',SER,...a],{encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1',...env}}).stdout||'';
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
    out.push({label:get('text')||get('content-desc'),id:get('resource-id'),click:get('clickable'),x1,y1,x2,y2});
  }
  return out;
}
const find=(ns,p)=>ns.find(n=>n.label&&n.label.includes(p));
const tap=(n)=>sh('input tap '+Math.round((n.x1+n.x2)/2)+' '+Math.round((n.y1+n.y2)/2));
const log=[];

// 打开桌面编辑 → 小部件
sh('input keyevent KEYCODE_HOME'); sleep(2000);
for(let i=0;i<5;i++){sh('input swipe 900 1200 100 1200 200'); sleep(400);}
sh('input swipe 540 500 540 500 1000'); sleep(2500);
sh('input tap 648 2180'); sleep(3000);
let ns=nodes();
log.push({step:'picker open', hasTitle: !!find(ns,'添加小部件')});

// 分类 tab
const cat=find(ns,'分类'); if(cat){tap(cat); sleep(2000);} 
ns=nodes();
// 滚动找 Took 分组里的「倒数日」
let found=false;
for(let i=0;i<10;i++){
  ns=nodes();
  if(ns.some(n=>n.label&&n.label.startsWith('倒数日 '))){found=true;break;}
  sh('input swipe 540 1800 540 700 300'); sleep(1200);
}
log.push({step:'scroll to countdown', found});
if(found){
  ns=nodes();
  const cd=ns.filter(n=>n.label&&n.label.startsWith('倒数日 '));
  log.push({countdownPreviews: cd.map(c=>c.label)});
  fs.writeFileSync(OUT+'/_pk-countdown.xml', JSON.stringify(cd,null,1));
}
console.log(JSON.stringify(log,null,1));
