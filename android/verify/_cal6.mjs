import { spawnSync } from 'child_process';
import fs from 'fs';
const ADB='D:/work/android-sdk/platform-tools/adb.exe';
const SER='5bf0cda4';
const OUT='D:/work/Project/Took/android/verify';
const adb=(a,enc)=>spawnSync(ADB,['-s',SER,...a],{encoding:enc||'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'},maxBuffer:64*1024*1024});
const sh=(c)=>adb(['shell',c]).stdout||'';
const sleep=(ms)=>spawnSync(process.execPath,['-e','setTimeout(()=>{},'+ms+')']);
function raw(){
  sh('rm -f /sdcard/n.xml'); sh('uiautomator dump /sdcard/n.xml');
  const local=OUT+'/.n-tmp.xml'; adb(['pull','/sdcard/n.xml',local]);
  try{return fs.readFileSync(local,'utf8');}catch(e){return '';}
}
function snap(){
  const s=raw(); const out=[]; const re=/<node\b([^>]*)>/g; let m;
  while((m=re.exec(s))){
    const a=m[1];
    const get=(k)=>{const r=new RegExp(' '+k+'="([^"]*)"').exec(a);return r?r[1]:'';};
    const b=/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(a); if(!b)continue;
    const [x1,y1,x2,y2]=b.slice(1).map(Number);
    if(x2-x1<=0||y2-y1<=0) continue;
    out.push({label:get('content-desc')||get('text'),cls:(get('class')||'').replace('android.widget.',''),x1,y1,x2,y2});
  }
  const title=(out.find(n=>/^\d{4} 年 \d{1,2} 月$/.test(n.label||''))||{}).label||'';
  const anchor=(out.find(n=>/^calendar-weeks/.test(n.label||''))||{}).label||'';
  return {title, anchor, start:(/起始周 (\S+)/.exec(anchor)||[])[1]||''};
}
function swipe(a,b,c,d,ms){ sh('input swipe '+[a,b,c,d,ms].join(' ')); }
const startOf=s=>s.start;
const label=s=>s.title+' @ '+s.start;

sh('am force-stop app.took'); sleep(900); sh('am start -n app.took/.MainActivity'); sleep(3200);
console.log('BASE      '+label(snap()));
for(const [px,ms] of [[150,600],[200,600],[250,600],[300,600],[300,400],[200,200],[120,150],[400,120]]){
  const a=snap();
  swipe(540,1300,540,1300-px,ms); sleep(1600);
  const b=snap();
  console.log('swipe '+String(px).padStart(3)+'px/'+String(ms).padStart(4)+'ms  from '+a.start+' -> '+b.start+'  ('+label(b)+')');
}
