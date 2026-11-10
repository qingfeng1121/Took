import re, sys
p = sys.argv[1]
xml = open(p, encoding='utf-8').read()
nodes = re.findall(r'<node [^>]*>', xml)
def attr(n, k):
    m = re.search(k + r'="([^"]*)"', n)
    return m.group(1) if m else ''
out = []
for n in nodes:
    t = attr(n, 'text'); cd = attr(n, 'content-desc'); b = attr(n, 'bounds'); cl = attr(n, 'clickable')
    if not (t or cd):
        continue
    m = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', b)
    x1,y1,x2,y2 = map(int, m.groups())
    out.append((x1,y1,x2,y2,t,cd,cl))
for x1,y1,x2,y2,t,cd,cl in out:
    label = (t or cd)
    print(f'{x1},{y1},{x2},{y2} clickable={cl} {"T" if t else "D"} {label}')
