const fs = require('fs');
const path = process.argv[2];
const want = process.argv.slice(3).map(s => s.toLowerCase());
const xml = fs.readFileSync(path, 'utf8');
const re = /<node\b([^>]*)>/g;
let m, rows = [];
while ((m = re.exec(xml))) {
  const attrs = {};
  const ar = /([\w-]+)="([^"]*)"/g;
  let a;
  while ((a = ar.exec(m[1]))) attrs[a[1]] = a[2];
  const label = attrs['text'] || attrs['content-desc'] || '';
  if (!label) continue;
  if (want.length && !want.some(w => label.toLowerCase().includes(w))) continue;
  rows.push({ label, bounds: attrs.bounds, clickable: attrs.clickable, id: attrs['resource-id'] || '' });
}
for (const r of rows) console.log(JSON.stringify(r));
console.log('--- ' + rows.length + ' nodes ---');
