import sys, re, xml.etree.ElementTree as ET

def dump(path, want=None, limit=200):
    t = ET.parse(path)
    out = []
    for n in t.iter('node'):
        txt = n.get('text') or ''
        cd = n.get('content-desc') or ''
        label = txt or cd
        if not label:
            continue
        if want and not any(w.lower() in label.lower() for w in want):
            continue
        out.append((label, n.get('bounds'), n.get('clickable'), n.get('resource-id') or ''))
    for label, b, c, rid in out[:limit]:
        print(f"{label!r:55} {b} click={c} {rid}")
    print(f"--- {len(out)} nodes ---")

if __name__ == '__main__':
    dump(sys.argv[1], sys.argv[2:] or None)
