import sys
import os
import tempfile
import subprocess

# --- MP4 Parsing & Patching Constants ---
CONTAINERS = {"moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta", "ilst"}
FAKE_SAMPLE = b'\x00\x00\x00\x04\x00\x00\x00\x00'

def u32(b, pos): 
    return int.from_bytes(b[pos:pos+4], 'big')

def u64(b, pos): 
    return int.from_bytes(b[pos:pos+8], 'big')

def w32(val): 
    return (val & 0xffffffff).to_bytes(4, 'big')

def box(b_type, payload): 
    return w32(len(payload) + 8) + b_type.encode('latin1') + payload

def box_type(b, pos): 
    return b[pos+4:pos+8].decode('latin1', errors='ignore')

def size_at(b, pos, max_len):
    if pos + 8 > max_len: 
        return 0
    s = u32(b, pos)
    if s == 1:
        if pos + 16 > max_len: 
            return 0
        return u64(b, pos + 8)
    if s == 0: 
        return max_len - pos
    return s

def parse_boxes(b, start, end):
    boxes = []
    curr = start
    while curr + 8 <= end:
        s = size_at(b, curr, end)
        if not s or curr + s > end: 
            break
        t = box_type(b, curr)
        hdr = 16 if u32(b, curr) == 1 else 8
        obj = {'type': t, 'start': curr, 'end': curr + s, 'size': s, 'header': hdr, 'children': None}
        child_start = curr + hdr
        if t == 'meta': 
            child_start += 4
        if t in CONTAINERS and child_start < curr + s:
            obj['children'] = parse_boxes(b, child_start, curr + s)
        boxes.append(obj)
        curr += s
    return boxes

def raw(b, box_obj): 
    return b[box_obj['start']:box_obj['end']]

def payload(b, box_obj): 
    return b[box_obj['start'] + box_obj['header']:box_obj['end']]

def find_child(parent, t): 
    return next((c for c in (parent.get('children') or []) if c['type'] == t), None)

def child_path(parent, path_list):
    curr = parent
    for t in path_list:
        curr = find_child(curr, t)
        if not curr: 
            return None
    return curr

def is_video_trak(b, trak):
    hdlr = child_path(trak, ["mdia", "hdlr"])
    if not hdlr: 
        return False
    return payload(b, hdlr)[8:12].decode('latin1', errors='ignore') == "vide"

def patch_mdhd_lang(b, box_obj):
    p = bytearray(payload(b, box_obj))
    off = 28 if p[0] == 1 else 16
    if off + 2 <= len(p):
        p[off:off+2] = (21956).to_bytes(2, 'big')
    return box("mdhd", bytes(p))

def patch_hdlr_name(b, box_obj):
    p = payload(b, box_obj)
    name = p[8:12].decode('latin1', errors='ignore') if len(p) >= 12 else ""
    h_name = "VideoHandler\0" if name == "vide" else ("SoundHandler\0" if name == "soun" else None)
    if not h_name:
        return raw(b, box_obj)
    return box("hdlr", p[:24] + h_name.encode('utf8'))

def patch_stsz(b, box_obj, add_count):
    if add_count < 1: 
        return raw(b, box_obj)
    p = payload(b, box_obj)
    hdr = p[:4]
    s_size = u32(p, 4)
    count = u32(p, 8)
    sizes = []
    if s_size != 0:
        sizes = [s_size] * count
    else:
        off = 12
        for _ in range(count):
            if off + 4 <= len(p):
                sizes.append(u32(p, off))
                off += 4
    sizes.extend([8] * add_count)
    out = bytearray(12 + len(sizes) * 4)
    out[:4] = hdr
    out[4:8] = w32(0)
    out[8:12] = w32(len(sizes))
    for idx, sz in enumerate(sizes):
        out[12 + idx * 4:16 + idx * 4] = w32(sz)
    return box("stsz", bytes(out))

def patch_stsc(b, box_obj, last_chunk):
    if last_chunk < 1: 
        return raw(b, box_obj)
    p = payload(b, box_obj)
    hdr = p[:4]
    count = u32(p, 4)
    entries = []
    off = 8
    for _ in range(count):
        if off + 12 <= len(p):
            entries.append((u32(p, off), u32(p, off + 4), u32(p, off + 8)))
            off += 12
    last_desc = entries[-1][2] if entries else 1
    entries.append((last_chunk + 1, 1, last_desc))
    out = bytearray(8 + len(entries) * 12)
    out[:4] = hdr
    out[4:8] = w32(len(entries))
    for idx, e in enumerate(entries):
        base = 8 + idx * 12
        out[base:base+4] = w32(e[0])
        out[base+4:base+8] = w32(e[1])
        out[base+8:base+12] = w32(e[2])
    return box("stsc", bytes(out))

def patch_stco(b, box_obj, shift, fake_offset, add_count):
    p = payload(b, box_obj)
    hdr = p[:4]
    count = u32(p, 4)
    offsets = []
    off = 8
    for _ in range(count):
        if off + 4 <= len(p):
            offsets.append(u32(p, off) + shift)
            off += 4
    offsets.extend([fake_offset] * add_count)
    out = bytearray(8 + len(offsets) * 4)
    out[:4] = hdr
    out[4:8] = w32(len(offsets))
    for idx, o in enumerate(offsets):
        out[8 + idx * 4:12 + idx * 4] = w32(o)
    return box("stco", bytes(out))

def patch_co64(b, box_obj, shift, fake_offset, add_count):
    p = payload(b, box_obj)
    hdr = p[:4]
    count = u32(p, 4)
    offsets = []
    off = 8
    for _ in range(count):
        if off + 8 <= len(p):
            offsets.append(u64(p, off) + shift)
            off += 8
    offsets.extend([fake_offset] * add_count)
    out = bytearray(8 + len(offsets) * 8)
    out[:4] = hdr
    out[4:8] = w32(len(offsets))
    for idx, o in enumerate(offsets):
        out[8 + idx * 8:16 + idx * 8] = o.to_bytes(8, 'big')
    return box("co64", bytes(out))

# --- Main Patch Process ---
def process_video(input_path, output_path):
    remux_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    remux_path = remux_tmp.name
    remux_tmp.close()

    try:
        # Step 1: Native FFmpeg Faststart Remux
        cmd = [
            'ffmpeg', '-y',
            '-i', input_path,
            '-map', '0',
            '-c', 'copy',
            '-map_metadata', '-1',
            '-map_chapters', '-1',
            '-brand', 'isom',
            '-movflags', '+faststart',
            '-video_track_timescale', '90000',
            remux_path
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if res.returncode != 0:
            raise RuntimeError(f"FFmpeg failed: {res.stderr[-200:]}")

        # Step 2: Custom Sample Table & Box Modification
        with open(remux_path, 'rb') as f:
            buf = f.read()

        boxes = parse_boxes(buf, 0, len(buf))
        moov = next((b for b in boxes if b['type'] == 'moov'), None)
        mdat = next((b for b in boxes if b['type'] == 'mdat'), None)
        if not moov or not mdat:
            raise RuntimeError("moov or mdat box missing")

        traks = [b for b in (moov.get('children') or []) if b['type'] == 'trak']
        v_trak = next((t for t in traks if is_video_trak(buf, t)), None)
        if not v_trak:
            raise RuntimeError("Video track missing")

        stbl = child_path(v_trak, ["mdia", "minf", "stbl"])
        stsz = find_child(stbl, "stsz")
        sample_count = u32(payload(buf, stsz), 8)

        total_samples = (sample_count * 20) // 3
        add_count = max(0, total_samples - sample_count)

        active_trak = [None]

        def walk_moov(b_obj, shift, fake_off):
            if b_obj['type'] == 'udta':
                return None
            if b_obj['type'] == 'mdhd':
                return patch_mdhd_lang(buf, b_obj)
            if b_obj['type'] == 'hdlr':
                return patch_hdlr_name(buf, b_obj)

            is_video = (active_trak[0] == v_trak)
            if is_video and b_obj['type'] == 'stsz':
                return patch_stsz(buf, b_obj, add_count)
            if is_video and b_obj['type'] == 'stts':
                return raw(buf, b_obj)
            if is_video and b_obj['type'] == 'stsc' and add_count > 0:
                stco_box = find_child(stbl, "stco") or find_child(stbl, "co64")
                return patch_stsc(buf, b_obj, u32(payload(buf, stco_box), 4))
            if b_obj['type'] == 'stco':
                return patch_stco(buf, b_obj, shift, fake_off, add_count)
            if b_obj['type'] == 'co64':
                return patch_co64(buf, b_obj, shift, fake_off, add_count)

            if b_obj.get('children'):
                parts = []
                if b_obj['type'] == 'meta':
                    parts.append(payload(buf, b_obj)[:4])
                for child in b_obj['children']:
                    prev_trak = active_trak[0]
                    if child['type'] == 'trak':
                        active_trak[0] = child
                    patched = walk_moov(child, shift, fake_off)
                    active_trak[0] = prev_trak
                    if patched:
                        parts.append(patched)
                return box(b_obj['type'], b''.join(parts))

            return raw(buf, b_obj)

        end_pos = mdat['end']
        new_moov = walk_moov(moov, 0, end_pos)
        diff = len(new_moov) - len(raw(buf, moov))
        end_pos = mdat['end'] + diff
        new_moov = walk_moov(moov, diff, end_pos)

        mdat_payload = buf[mdat['start'] + 8 : mdat['end']]
        if add_count > 0:
            new_mdat = w32(8 + len(mdat_payload) + 8) + b'mdat' + mdat_payload + FAKE_SAMPLE
        else:
            new_mdat = raw(buf, mdat)

        out_boxes = []
        free_box = w32(8) + b'free'
        for b in boxes:
            if b['type'] == 'ftyp':
                out_boxes.append(raw(buf, b))
                out_boxes.append(free_box)
            elif b['type'] == 'moov':
                out_boxes.append(new_moov)
            elif b['type'] == 'mdat':
                out_boxes.append(new_mdat)
            elif b['type'] in ('free', 'wide'):
                continue
            else:
                out_boxes.append(raw(buf, b))

        with open(output_path, 'wb') as f:
            f.write(b''.join(out_boxes))

    finally:
        if os.path.exists(remux_path):
            try: os.remove(remux_path)
            except Exception: pass

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python patcher.py <input.mp4> <output.mp4>")
        sys.exit(1)
    process_video(sys.argv[1], sys.argv[2])
