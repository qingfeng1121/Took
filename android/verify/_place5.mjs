
import { spawnSync } from 'child_process';
import fs from 'fs';
const ADB='D:/work/android-sdk/platform-tools/adb.exe';
const SER='5bf0cda4';
const OUT='D:/work/Project/Took/android/verify';
const adb=(a)=>spawnSync(ADB,['-s',SER,...a],{encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'}}).stdout||'';
const sh=(c)=>adb(['shell',c]);
const sleep=(ms)=>spawnSync(process.execPath,['-e','setTimeout(()=>{},'+ms+')']);
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
const tapXY=(x,y)=>sh('input tap '+Math.round(x)+' '+Math.round(y));
const tap=(n)=>tapXY((n.x1+n.x2)/2,(n.y1+n.y2)/2);
const log=[];
sh('am force-stop app.took'); sleep(600);
sh('input keyevent KEYCODE_HOME'); sleep(2200);
sh('input swipe 540 500 540 500 1000'); sleep(2600);
let ns=nodes();
if(!ns.some(n=>n.label==='添加小部件')){ tapXY(648,2180); sleep(3000); ns=nodes(); }
let cat=ns.filter(n=>n.label==='分类'); const cc=cat.find(t=>t.click)||cat[0];
if(cc){tap(cc); sleep(2500);}
ns=nodes();
let hit=null;
for(let i=0;i<12;i++){
  ns=nodes();
  hit=ns.find(n=>n.label&&n.label.startsWith('倒数日 ')&&n.label.includes('目标日'));
  if(hit)break;
  sh('input swipe 540 1800 540 700 300'); sleep(1300);
}
if(!hit){console.log('no hit'); process.exit(0);}
const cx=Math.round((hit.x1+hit.x2)/2), cy=Math.round((hit.y1+hit.y2)/2);
// 长按（不移动）
sh('input swipe '+cx+' '+cy+' '+cx+' '+cy+' 1200');
sleep(2500);
log.push({afterLongPress: focus()});
ns=nodes();
log.push({labels: ns.filter(n=>n.label).map(n=>n.label).slice(0,15)});
console.log(JSON.stringify(log,null,1));
