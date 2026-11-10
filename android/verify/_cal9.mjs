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
    out.push({label:get('content-desc')||get('text'),cls:(get('class')||'').replace('android.widget.',''),click:get('clickable')==='true',x1,y1,x2,y2});
  }
  const title=(out.find(n=>/^\d{4} 年 \d{1,2} 月$/.test(n.label||''))||{}).label||'';
  const anchorNode=out.find(n=>/^calendar-weeks/.test(n.label||''))||{};
  const start=(/起始周 (\S+)/.exec(anchorNode.label||'')||[])[1]||'';
  const cells=out.map(n=>{const m=/^(\d{4}-\d{2}-\d{2}) 当天安排/.exec(n.label||'');return m?{d:m[1],y:n.y1,x:n.x1}:null;}).filter(Boolean).sort((a,b)=>a.y-b.y||a.x-b.x);
  const rows=[]; for(let i=0;i<cells.length;i+=7) rows.push(cells.slice(i,i+7).map(c=>c.d));
  return {title, start, rows, prev:(out.find(n=>n.label==='上个月')||{}), next:(out.find(n=>n.label==='下个月')||{})};
}
function png(n){ const r=adb(['exec-out','screencap','-p'],'buffer'); fs.writeFileSync(OUT+'/'+n+'.png', r.stdout); return n+'.png'; }
function swipe(a,b,c,d,ms){ sh('input swipe '+[a,b,c,d,ms].join(' ')); }
function tap(x,y){ sh('input tap '+Math.round(x)+' '+Math.round(y)); }
const rowsMoved=(from,to)=>{const i=from.rows.findIndex(r=>r[0]===to.start);return i;};
function line(t,s){ console.log(t+' | 标题='+s.title+' | 视口首行='+s.start+' | 可见 '+(s.rows[0]||[])[0]+' … '+((s.rows[s.rows.length-1]||[]).slice(-1)[0])); }

const mode=process.argv[2];
if(mode==='scroll'){
  sh('am force-stop app.took'); sleep(900); sh('am start -n app.took/.MainActivity'); sleep(3500);
  const a=snap(); line('① 起始      ',a); console.log('   PNG '+png('ui-cal-scroll-before'));
  swipe(540,1250,540,950,450); sleep(2200);
  const b=snap(); line('② 轻滑一次  ',b); console.log('   PNG '+png('ui-cal-scroll-1'));
  console.log('   轻滑结果：走了 '+rowsMoved(a,b)+' 行（0=没动 1=一行 6=整月）');
  swipe(540,1500,540,700,60); sleep(3500);
  const c=snap(); line('③ 大力滑    ',c); console.log('   PNG '+png('ui-cal-scroll-fling'));
  const m=rowsMoved(b,c);
  console.log('   大力滑结果：'+(m<0?'滚出可见范围（连续滚多行）':m+' 行'));
  fs.writeFileSync(OUT+'/ui-cal-scroll-steps.json', JSON.stringify({a,b,c},null,1));
}
if(mode==='cross'){
  sh('am force-stop app.took'); sleep(900); sh('am start -n app.took/.MainActivity'); sleep(3500);
  const a=snap(); line('跨月-前    ',a); console.log('   PNG '+png('ui-cal-scroll-crossmonth'));
  console.log('   rows='+JSON.stringify(a.rows));
  swipe(540,1250,540,950,450); sleep(2200);
  const b=snap(); line('跨月-后    ',b); console.log('   PNG '+png('ui-cal-scroll-crossmonth-after'));
  console.log('   rows='+JSON.stringify(b.rows));
  console.log('   标题变化: '+a.title+'  ->  '+b.title);
  fs.writeFileSync(OUT+'/ui-cal-crossmonth-steps.json', JSON.stringify({a,b},null,1));
}
if(mode==='buttons'){
  sh('am force-stop app.took'); sleep(900); sh('am start -n app.took/.MainActivity'); sleep(3500);
  const a=snap(); line('按 › 前    ',a);
  tap((a.next.x1+a.next.x2)/2,(a.next.y1+a.next.y2)/2); sleep(2200);
  const b=snap(); line('按 › 后    ',b);
  tap((b.prev.x1+b.prev.x2)/2,(b.prev.y1+b.prev.y2)/2); sleep(2200);
  const c=snap(); line('按 ‹ 后    ',c);
  console.log('按钮结果: '+a.title+'/'+a.start+'  ›  '+b.title+'/'+b.start+'  ‹  '+c.title+'/'+c.start);
}
if(mode==='snap'){ line('SNAP',snap()); }
