
import { spawnSync } from 'child_process';
import fs from 'fs';
const ADB='D:/work/android-sdk/platform-tools/adb.exe';
const SER='5bf0cda4';
const OUT='D:/work/Project/Took/android/verify';
const adb=(a)=>spawnSync(ADB,['-s',SER,...a],{encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'}}).stdout||'';
const sh=(c)=>adb(['shell',c]);
const sleep=(ms)=>spawnSync(process.execPath,['-e','setTimeout(()=>{},'+ms+')']);
const focus=()=>sh('dumpsys window | grep mCurrentFocus').trim().split('\n')[0];
function raw(){
  sh('rm -f /sdcard/n.xml'); sh('uiautomator dump /sdcard/n.xml');
  const local=OUT+'/.n-tmp.xml'; adb(['pull','/sdcard/n.xml',local]);
  try{return fs.readFileSync(local,'utf8');}catch(e){return '';}
}
function nodes(){
  const s=raw(); const out=[]; const re=/<node\b([^>]*)>/g; let m;
  while((m=re.exec(s))){
    const a=m[1];
    const get=(k)=>{const r=new RegExp(' '+k+'="([^"]*)"').exec(a);return r?r[1]:'';};
    const b=/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(a); if(!b)continue;
    const [x1,y1,x2,y2]=b.slice(1).map(Number);
    if(x2-x1<=0||y2-y1<=0) continue;
    out.push({label:get('text')||get('content-desc'),cls:(get('class')||'').replace('android.widget.',''),id:(get('resource-id')||'').replace('com.miui.personalassistant:id/',''),click:get('clickable')==='true',x1,y1,x2,y2});
  }
  return out;
}
const tapXY=(x,y)=>sh('input tap '+Math.round(x)+' '+Math.round(y));
const tap=(n)=>tapXY((n.x1+n.x2)/2,(n.y1+n.y2)/2);
const log=[];
sh('am force-stop app.took'); sleep(800);
sh('input keyevent KEYCODE_HOME'); sleep(2600);
for(let i=0;i<6;i++){ sh('input swipe 900 1200 100 1200 200'); sleep(500); }
sleep(700);
log.push({afterSwipe:focus()});
sh('input swipe 540 500 540 500 1000'); sleep(2600);
log.push({afterLongPress:focus()});
tapXY(648,2180); sleep(3200);
let ns=nodes();
log.push({pickerOpen: ns.some(n=>n.label==='添加小部件'), focus:focus()});
if(!ns.some(n=>n.label==='添加小部件')){console.log(JSON.stringify(log,null,1));process.exit(0);}
const cats=ns.filter(n=>n.label==='分类'); const cc=cats.find(t=>t.click)||cats[0];
if(cc){tap(cc); sleep(2500);}
let hit=null;
for(let i=0;i<12;i++){
  ns=nodes();
  hit=ns.find(n=>n.label&&n.label.startsWith('倒数日 ')&&n.label.includes('目标日'));
  if(hit)break;
  sh('input swipe 540 1800 540 700 300'); sleep(1300);
}
log.push({hit:!!hit});
ns=nodes();
// 打印 Took 分组区域（y 1200..2250）的全部节点
log.push({groupArea: ns.filter(n=>n.y1>1150&&n.y1<2260).map(n=>({l:(n.label||'').slice(0,40),c:n.cls,id:n.id,cl:n.click,y:n.y1,x:n.x1,w:n.x2-n.x1}))});
fs.writeFileSync(OUT+'/_group.json', JSON.stringify(log,null,1));
console.log(JSON.stringify(log,null,1).slice(0,6000));
