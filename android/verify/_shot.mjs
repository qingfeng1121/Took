
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
sh('am force-stop app.took'); sleep(700);
sh('input keyevent KEYCODE_HOME'); sleep(2500);
shot('_s1-home.png');
sh('input swipe 540 400 540 400 1000'); sleep(2600);
shot('_s2-edit.png');
console.log('focus', focus());
