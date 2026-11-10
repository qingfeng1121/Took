import glob,re
t=f=e=s=0
files=0
for p in glob.glob('D:/work/Project/Took/android/app/build/test-results/testDebugUnitTest/*.xml'):
    h=open(p,encoding='utf-8').read(2000)
    m=re.search(r'tests="([0-9]+)"',h)
    if not m: continue
    files+=1
    t+=int(m.group(1))
    for k in ('failures','errors','skipped'):
        mm=re.search(k+r'="([0-9]+)"',h)
        if mm:
            if k=='failures': f+=int(mm.group(1))
            elif k=='errors': e+=int(mm.group(1))
            else: s+=int(mm.group(1))
print('files',files,'tests',t,'failures',f,'errors',e,'skipped',s)
