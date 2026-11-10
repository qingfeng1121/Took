
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
// 明确到第 1 页（有今天组件，上方空白多）
sh('input swipe 100 1200 900 1200 200'); sleep(600);
sh('input swipe 100 1200 900 1200 200'); sleep(600);
sh('input swipe 100 1200 900 1200 200'); sleep(600);
sh('input swipe 100 1200 900 1200 200'); sleep(600);
sh('input swipe 100 1200 900 1200 200'); sleep(1200);
log.push({page: (nodes().find(n=>n.label&&n.label.includes('页共'))||{}).label, focus: focus()});

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
log.push({hit: hit?hit.label:null, focus: focus()});
if(!hit){console.log(JSON.stringify(log,null,1)); process.exit(0);}

// 直接长按并拖到上方空白处（不先点击）
const cx=Math.round((hit.x1+hit.x2)/2), cy=Math.round((hit.y1+hit.y2)/2);
log.push({dragFrom:[cx,cy]});
sh('input swipe '+cx+' '+cy+' 540 620 1800');
sleep(3500);
log.push({afterDragFocus: focus()});
sh('screencap -p /sdcard/dg2.png'); adb(['pull','/sdcard/dg2.png',OUT+'/_drag2.png']);
const w=sh('dumpsys appwidget | grep -c "id="');
const inst=sh('dumpsys appwidget | grep -A2 "countdownwidget" | grep -E "id=|provider="');
log.push({instances: inst.trim().split('\n').slice(0,8)});
const n2=nodes();
log.push({screenLabels: n2.filter(n=>n.label).map(n=>n.label).slice(0,15)});
console.log(JSON.stringify(log,null,1));
