
import { spawnSync } from 'child_process';
import fs from 'fs';
const ADB='D:/work/android-sdk/platform-tools/adb.exe';
const SER='5bf0cda4';
const OUT='D:/work/Project/Took/android/verify';
const adb=(a)=>spawnSync(ADB,['-s',SER,...a],{encoding:'utf8',env:{...process.env,MSYS_NO_PATHCONV:'1'}}).stdout||'';
const sh=(c)=>adb(['shell',c]);
const sleep=(ms)=>spawnSync(process.execPath,['-e','setTimeout(()=>{},'+ms+')']);
const shot=(n)=>{sh('screencap -p /sdcard/s.png'); adb(['pull','/sdcard/s.png',OUT+'/'+n]);};
const pkg=()=>{const s=sh('dumpsys activity activities | grep topResumedActivity');const m=/u0 ([^\/]+)\//.exec(s);return m?m[1]:'?';};
const log=[];
sh('am force-stop app.took'); sleep(700);
sh('input keyevent KEYCODE_HOME'); sleep(2500);
// 从顶部空白区横滑翻页（y=200 在状态栏下方、组件上方）
for(let i=0;i<5;i++){ sh('input swipe 900 200 100 200 220'); sleep(600); }
sleep(600); shot('_v1-page6.png');
log.push({step:'page6', pkg:pkg()});
// 第 6 页 y≈400 是空白
sh('input swipe 540 400 540 400 1000'); sleep(2600);
shot('_v2-edit.png');
log.push({step:'longpress', pkg:pkg()});
console.log(JSON.stringify(log,null,1));
