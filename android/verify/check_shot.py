from PIL import Image
import collections, sys
im = Image.open(r'D:/work/Project/Took/android/shot-home.png').convert('RGB')
print('size', im.size)
def near(px, hexv, tol=10):
    r,g,b = int(hexv[0:2],16), int(hexv[2:4],16), int(hexv[4:6],16)
    return abs(px[0]-r)<=tol and abs(px[1]-g)<=tol and abs(px[2]-b)<=tol
accent=0; today=0; bg=0; surface=0
w,h = im.size
cnt = collections.Counter()
for y in range(0,h,3):
    for x in range(0,w,3):
        px = im.getpixel((x,y))
        cnt[px]+=1
        if near(px,'F97316',12): accent+=1
        if near(px,'E53935',12): today+=1
        if near(px,'EEF0F4',4): bg+=1
        if near(px,'FFFFFF',2): surface+=1
print('accent #F97316 samples:', accent)
print('today  #E53935 samples:', today)
print('bg     #EEF0F4 samples:', bg)
print('surface#FFFFFF samples:', surface)
print('top5 colors:', cnt.most_common(5))
