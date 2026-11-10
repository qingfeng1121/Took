
import { spawnSync } from 'child_process';
import fs from 'fs';
const ADB='D:/work/android-sdk/platform-tools/adb.exe';
const SER='5bf0cda4';
const OUT='D:/work/Project/Took/android/verify';
const adb=(a)=>spawnSync(ADB,['-s',SER,...a],{encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'}}).stdout||'';
const sh=(c)=>adb(['shell',c]);
const sleep=(ms)=>spawnSync(process.execPath,['-e','setTimeout(()=>{},'+ms+')']);
const shot=(n)=>{sh('screencap -p /sdcard/s.png'); adb(['pull','/sdcard/s.png',OUT+'/'+n]);};
const focus=()=>sh('dumpsys window | grep mCurrentFocus').trim().split('\n')[0].replace('mCurrentFocus=Window{','').split(' ').slice(-1)[0];
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

sh('am force-stop com.miui.personalassistant'); sleep(800);
sh('am start -n com.miui.personalassistant/com.miui.personalassistant.picker.business.home.pages.PickerHomeActivity'); sleep(3500);
log.push({f:focus()});
let ns=nodes();
log.push({picker: ns.some(n=>n.label==='添加小部件'), n: ns.length});
const cats=ns.filter(n=>n.label==='分类'); const cc=cats.find(t=>t.click)||cats[0];
if(cc){tap(cc); sleep(2500);}
let hit=null;
for(let i=0;i<14;i++){
  ns=nodes();
  hit=ns.find(n=>n.label&&n.label.startsWith('倒数日 ')&&n.label.includes('目标日'));
  if(hit)break;
  sh('input swipe 540 1800 540 700 300'); sleep(1300);
}
log.push({hit: hit?hit.label:null, f:focus()});
if(!hit){console.log(JSON.stringify(log,null,1));process.exit(0);}
tap(hit); sleep(2600);
log.push({afterPreviewTap: focus()});
ns=nodes();
log.push({hasAdd: ns.some(n=>n.label==='添加到桌面'), labels: ns.filter(n=>n.label).map(n=>n.label).slice(0,8)});
shot('_q-detail.png');
console.log(JSON.stringify(log,null,1));
