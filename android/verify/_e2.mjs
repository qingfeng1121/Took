
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
const tap=(n)=>tapXY((n.x1+n.x2)/2,(n.y1+n.y2)/2);
const log=[];

sh('am force-stop app.took'); sleep(700);
sh('input keyevent KEYCODE_HOME'); sleep(2500);
// 用第 6 页上方空白进入编辑模式（月历组件从 y=840 开始，y=400 是空白）
for(let i=0;i<6;i++){sh('input swipe 900 1200 100 1200 200'); sleep(450);}
sleep(700);
let ns=nodes();
log.push({page:(ns.find(n=>n.label&&n.label.includes('页共'))||{}).label, focus:focus()});
sh('input swipe 540 380 540 380 1000'); sleep(2600);
ns=nodes();
log.push({editFocus:focus(), hasWidgetBtn: ns.some(n=>n.label==='小部件')});
shot('_e2-edit.png');
// 底部四按钮：壁纸 / 壁纸? / 小部件 / 桌面 —— 用坐标点第 3 个
tapXY(648,2180); sleep(3200);
ns=nodes();
log.push({pickerOpen: ns.some(n=>n.label==='添加小部件'), focus:focus()});
if(!ns.some(n=>n.label==='添加小部件')){ shot('_e3-fail.png'); console.log(JSON.stringify(log,null,1)); process.exit(0); }

// 分类
const cats=ns.filter(n=>n.label==='分类'); const cc=cats.find(t=>t.click)||cats[0];
if(cc){tap(cc); sleep(2500);}
ns=nodes();
let hit=null;
for(let i=0;i<12;i++){
  ns=nodes();
  hit=ns.find(n=>n.label&&n.label.startsWith('倒数日 ')&&n.label.includes('目标日'));
  if(hit)break;
  sh('input swipe 540 1800 540 700 300'); sleep(1300);
}
log.push({hit: hit?hit.label:null, focus:focus()});
if(!hit){ shot('_e4-nohit.png'); console.log(JSON.stringify(log,null,1)); process.exit(0); }
// 单击预览
tap(hit); sleep(2500);
ns=nodes();
const addBtn=ns.find(n=>n.label==='添加到桌面');
log.push({afterTapFocus:focus(), hasAddBtn:!!addBtn});
shot('_e5-detail.png');
if(addBtn){
  tap(addBtn); sleep(4000);
  log.push({afterAddFocus: focus()});
  shot('_e6-afteradd.png');
  ns=nodes();
  log.push({labels: ns.filter(n=>n.label).map(n=>n.label).slice(0,25)});
}
console.log(JSON.stringify(log,null,1));
