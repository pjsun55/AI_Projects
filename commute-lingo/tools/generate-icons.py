"""Generate the three original vector app icons and matching iOS PNG assets.
Only the standard library is used; all output stays within this project.
"""
from pathlib import Path
import math
import struct
import zlib
import json

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = (ROOT / 'public').resolve()
PUBLIC.relative_to(ROOT)

def arc(cx, cy, radius, start, end, steps=60):
    return [(cx + radius * math.cos(start + (end-start)*i/steps), cy + radius * math.sin(start + (end-start)*i/steps)) for i in range(steps+1)]

# Shapes are shared by SVG and PNG rendering to keep their geometry consistent.
ICONS = {
    'journey': ('#ac5af0', '#6329ae', [
        ('path', arc(50, 46, 26, math.pi, 2*math.pi), 6),
        ('rect', (21, 43, 12, 27, 6), None), ('rect', (67, 43, 12, 27, 6), None),
        ('path', [(42, 48), (42, 61)], 4), ('path', [(50, 42), (50, 66)], 4), ('path', [(58, 48), (58, 61)], 4),
        ('path', [(38, 78), (62, 78)], 4), ('circle', (34, 78, 2), None), ('circle', (66, 78, 2), None)
    ]),
    'dialogue': ('#38b7bd', '#17577d', [
        ('path', [(27, 29), (70, 29), (77, 36), (77, 60), (70, 67), (48, 67), (33, 79), (33, 67), (24, 60), (24, 36), (27, 29)], 4.5),
        ('path', [(35, 47), (35, 52)], 4), ('path', [(45, 40), (45, 58)], 4),
        ('path', [(55, 37), (55, 61)], 4), ('path', [(65, 44), (65, 54)], 4)
    ]),
    'sunrise': ('#ffb469', '#dc5779', [
        ('path', arc(50, 55, 19, math.pi, 2*math.pi), 5),
        ('path', [(24, 58), (39, 58), (50, 65), (61, 58), (76, 58), (76, 76), (61, 76), (50, 82), (39, 76), (24, 76), (24, 58)], 4.5),
        ('path', [(50, 65), (50, 80)], 3), ('path', [(50, 17), (50, 23)], 3.5),
        ('path', [(25, 26), (30, 31)], 3.5), ('path', [(75, 26), (70, 31)], 3.5),
        ('path', [(16, 47), (22, 47)], 3.5), ('path', [(78, 47), (84, 47)], 3.5)
    ])
}

def rgb(value): return tuple(int(value[i:i+2], 16) for i in (1, 3, 5))
def distance(x, y, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    t = max(0, min(1, ((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy or 1)))
    return math.hypot(x-a[0]-t*dx, y-a[1]-t*dy)
def inside(x, y, shape):
    kind, data, stroke = shape
    if kind == 'path': return any(distance(x, y, a, b) <= stroke/2 for a, b in zip(data, data[1:]))
    if kind == 'circle': return math.hypot(x-data[0], y-data[1]) <= data[2]
    left, top, w, h, radius = data
    qx, qy = max(left+radius, min(x, left+w-radius)), max(top+radius, min(y, top+h-radius))
    return math.hypot(x-qx, y-qy) <= radius

def svg(start, end, shapes):
    elements = []
    for kind, data, stroke in shapes:
        if kind == 'path':
            points = ' '.join(f'{x:.3f},{y:.3f}' for x, y in data)
            elements.append(f'<polyline points="{points}" fill="none" stroke="white" stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round"/>')
        elif kind == 'rect':
            x, y, w, h, radius = data
            elements.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="white"/>')
        else:
            x, y, radius = data
            elements.append(f'<circle cx="{x}" cy="{y}" r="{radius}" fill="white"/>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x2=".8" y2="1"><stop stop-color="{start}"/><stop offset="1" stop-color="{end}"/></linearGradient></defs><rect width="100" height="100" rx="23" fill="url(#g)"/><circle cx="86" cy="13" r="41" fill="white" opacity=".055"/><circle cx="4" cy="96" r="39" fill="white" opacity=".04"/>{"".join(elements)}</svg>\n'

def png(size, start, end, shapes):
    # Supersample glyph edges with 2x2 samples; the PNG is opaque as iOS expects.
    first, last = rgb(start), rgb(end)
    raw = bytearray()
    # Paths are rasterized to a coverage mask once, bounding each segment.
    scale = size*2/100
    mask = bytearray(size*size*4)
    for shape in shapes:
        if shape[0] == 'path':
            primitives = [('path', [a,b], shape[2]) for a,b in zip(shape[1], shape[1][1:])]
        else: primitives = [shape]
        for primitive in primitives:
            kind,data,stroke=primitive
            if kind=='path':
                xs,ys=zip(*data);pad=stroke/2+1;bounds=(min(xs)-pad,min(ys)-pad,max(xs)+pad,max(ys)+pad)
            elif kind=='circle':
                x,y,r=data;bounds=(x-r-1,y-r-1,x+r+1,y+r+1)
            else:
                x,y,w,h,r=data;bounds=(x-1,y-1,x+w+1,y+h+1)
            x0,y0,x1,y1=[int(v*scale) for v in bounds]
            for sy in range(max(0,y0),min(size*2,y1+1)):
                for sx in range(max(0,x0),min(size*2,x1+1)):
                    if inside((sx+.5)/scale,(sy+.5)/scale,primitive): mask[sy*size*2+sx]=1
    for py in range(size):
        raw.append(0)
        for px in range(size):
            x,y=(px+.5)*100/size,(py+.5)*100/size
            t=min(1,max(0,(x*.4+y*.6)/100))
            base=[first[i]*(1-t)+last[i]*t for i in range(3)]
            overlay=.055 if math.hypot(x-86,y-13)<41 else (.04 if math.hypot(x-4,y-96)<39 else 0)
            alpha=(mask[py*4*size+px*2]+mask[py*4*size+px*2+1]+mask[(py*2+1)*size*2+px*2]+mask[(py*2+1)*size*2+px*2+1])/4
            raw.extend(round((v*(1-overlay)+255*overlay)*(1-alpha)+255*alpha) for v in base)
    def chunk(tag,data): return struct.pack('!I',len(data))+tag+data+struct.pack('!I',zlib.crc32(tag+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',size,size,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw,9))+chunk(b'IEND',b'')

for name,(start,end,shapes) in ICONS.items():
    (PUBLIC/f'icon-{name}.svg').write_text(svg(start,end,shapes))
    for size in (192,512): (PUBLIC/f'icon-{name}-{size}.png').write_bytes(png(size,start,end,shapes))
    manifest={'id':'./','name':'通勤學語言 · CommuteLingo','short_name':'通勤學語言','lang':'zh-Hant','start_url':'./?v=0.2.9','scope':'./','display':'standalone','orientation':'portrait','background_color':'#fbf8f5','theme_color':'#fbf8f5','icons':[{'src':f'./icon-{name}-{size}.png','sizes':f'{size}x{size}','type':'image/png','purpose':'any'} for size in (192,512)]}
    (PUBLIC/f'manifest-{name}.webmanifest').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    if name=='sunrise':
        (PUBLIC/'manifest.webmanifest').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
        (PUBLIC/'icon.svg').write_text(svg(start,end,shapes))
print('Generated 3 SVG icons, 6 PNG icons, and portrait manifests inside public/.')
