const fs=require('fs');
const xml=fs.readFileSync(process.argv[2],'utf8');
const i=xml.indexOf('picker_list_app_footer_text');
console.log('--- context around footer ---');
console.log(xml.slice(Math.max(0,i-700), i+200));
