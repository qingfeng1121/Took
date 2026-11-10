
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
const tapXY=(x,y)=>sh('input tap '+Math.round(x)+' '+Math.round(y));
const log=[];

sh('input keyevent KEYCODE_BACK'); sleep(800);
sh('am force-stop app.took'); sleep(700);
sh('input keyevent KEYCODE_HOME'); sleep(2500);
// 翻到最后一页（月历组件，上方空白）
for(let i=0;i<6;i++){sh('input swipe 900 1200 100 1200 200'); sleep(500);}
sleep(800);
let ns=nodes();
log.push({page:(ns.find(n=>n.label&&n.label.includes('页共'))||{}).label});
// 上方空白处长按
sh('input swipe 540 400 540 400 1000'); sleep(2600);
ns=nodes();
const widgetBtn=ns.find(n=>n.label==='小部件'||(n.id&&n.id.includes('widget')));
log.push({editMode: !!widgetBtn, widgetBtn: widgetBtn?{l:widgetBtn.label,x:widgetBtn.x1,y:widgetBtn.y1,w:widgetBtn.x2-widgetBtn.x1}:null, focus: focus()});
shot('_e1-edit.png');
console.log(JSON.stringify(log,null,1));
