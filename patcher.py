"""
Python MP4 Patcher
Replicates exact logic of patcher.js:
1. FFmpeg faststart remux (-c copy)
2. Moov tree parsing & patching (stsz, stsc, stco/co64, mdhd, hdlr)
3. 20/3x sample expansion with fake sample appended to mdat
"""

import os
import struct
import tempfile
import subprocess

CONTAINERS = {"moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta", "ilst"}
FAKE_SAMPLE = bytes([0, 0, 0, 4, 0, 0, 0, 0])


class Box:
    def __init__(self, btype, start, end, size, header, children=None):
        self.type = btype
        self.start = start
        self.end = end
        self.size = size
        self.header = header
        self.children = children or []


def u32(buf, pos):
    return struct.unpack('>I', buf[pos:pos+4])[0]


def u64(buf, pos):
    return struct.unpack('>Q', buf[pos:pos+8])[0]


def w32(val):
    return struct.pack('>I', val & 0xFFFFFFFF)


def box(btype, payload):
    return w32(len(payload) + 8) + btype.encode('latin1') + payload


def size_at(buf, pos, max_len):
    if pos + 8 > max_len:
        return 0
    s = u32(buf, pos)
    if s == 1:
        if pos + 16 > max_len:
            return 0
        return u64(buf, pos + 8)
    if s == 0:
        return max_len - pos
    return s


def parse_boxes(buf, start, end):
    boxes = []
    curr = start
    while curr + 8 <= end:
        s = size_at(buf, curr, end)
        if not s or curr + s > end:
            break
        btype = buf[curr+4:curr+8].decode('latin1', errors='ignore')
        hdr = 16 if u32(buf, curr) == 1 else 8
        b = Box(btype, curr, curr + s, s, hdr)
        child_start = curr + hdr
        if btype == "meta":
            child_start += 4
        if btype in CONTAINERS and child_start < curr + s:
            b.children = parse_boxes(buf, child_start, curr + s)
        boxes.append(b)
        curr += s
    return boxes


def raw(buf, b):
    return buf[b.start:b.end]


def payload(buf, b):
    return buf[b.start + b.header:b.end]


def find_child(parent, btype):
    for c in parent.children:
        if c.type == btype:
            return c
    return None


def child_path(parent, path_list):
    curr = parent
    for t in path_list:
        curr = find_child(curr, t)
        if not curr:
            return None
    return curr


def is_video_trak(buf, trak):
    hdlr = child_path(trak, ["mdia", "hdlr"])
    if hdlr:
        p = payload(buf, hdlr)
        return len(p) >= 12 and p[8:12].decode('latin1', errors='ignore') == "vide"
    return False


def patch_mdhd_lang(buf, b):
    p = bytearray(payload(buf, b))
    off = 28 if p[0] == 1 else 16
    if off + 2 <= len(p):
        struct.pack_into('>H', p, off, 21956)
    return box("mdhd", bytes(p))


def patch_hdlr_name(buf, b):
    p = payload(buf, b)
    name = p[8:12].decode('latin1', errors='ignore') if len(p) >= 12 else ""
    h_name = None
    if name == "vide":
        h_name = b"VideoHandler\0"
    elif name == "soun":
        h_name = b"SoundHandler\0"
    if not h_name:
        return raw(buf, b)
    return box("hdlr", p[:24] + h_name)


def patch_stsz(buf, b, add_count):
    if add_count < 1:
        return raw(buf, b)
    p = payload(buf, b)
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
    struct.pack_into('>I', out, 4, 0)
    struct.pack_into('>I', out, 8, len(sizes))
    for idx, sz in enumerate(sizes):
        struct.pack_into('>I', out, 12 + idx * 4, sz)
    return box("stsz", bytes(out))


def patch_stsc(buf, b, last_chunk):
    if last_chunk < 1:
        return raw(buf, b)
    p = payload(buf, b)
    hdr = p[:4]
    count = u32(p, 4)
    entries = []
    off = 8
    for _ in range(count):
        if off + 12 <= len(p):
            entries.append([u32(p, off), u32(p, off + 4), u32(p, off + 8)])
            off += 12
    last_desc = entries[-1][2] if entries else 1
    entries.append([last_chunk + 1, 1, last_desc])
    out = bytearray(8 + len(entries) * 12)
    out[:4] = hdr
    struct.pack_into('>I', out, 4, len(entries))
    for idx, e in enumerate(entries):
        struct.pack_into('>I', out, 8 + idx * 12, e[0])
        struct.pack_into('>I', out, 12 + idx * 12, e[1])
        struct.pack_into('>I', out, 16 + idx * 12, e[2])
    return box("stsc", bytes(out))


def patch_stco(buf, b, shift, fake_off, add_count):
    p = payload(buf, b)
    hdr = p[:4]
    count = u32(p, 4)
    offsets = []
    off = 8
    for _ in range(count):
        if off + 4 <= len(p):
            offsets.append(u32(p, off) + shift)
            off += 4
    offsets.extend([fake_off] * add_count)
    out = bytearray(8 + len(offsets) * 4)
    out[:4] = hdr
    struct.pack_into('>I', out, 4, len(offsets))
    for idx, o in enumerate(offsets):
        struct.pack_into('>I', out, 8 + idx * 4, o & 0xFFFFFFFF)
    return box("stco", bytes(out))


def patch_co64(buf, b, shift, fake_off, add_count):
    p = payload(buf, b)
    hdr = p[:4]
    count = u32(p, 4)
    offsets = []
    off = 8
    for _ in range(count):
        if off + 8 <= len(p):
            offsets.append(u64(p, off) + shift)
            off += 8
    offsets.extend([fake_off] * add_count)
    out = bytearray(8 + len(offsets) * 8)
    out[:4] = hdr
    struct.pack_into('>I', out, 4, len(offsets))
    for idx, o in enumerate(offsets):
        struct.pack_into('>Q', out, 8 + idx * 8, int(o))
    return box("co64", bytes(out))


def patch_video_pipeline(raw_bytes: bytes):
    """
    Direct replacement for node patcher.js
    Returns: (output_bytes, original_sample_count, added_sample_count)
    """
    in_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)
    remux_tmp = tempfile.NamedTemporaryFile(suffix='.mp4', delete=False)

    try:
        in_tmp.write(raw_bytes)
        in_tmp.flush()
        in_tmp.close()
        remux_tmp.close()

        # Step 1: FFmpeg Faststart Remux (Same as patcher.js)
        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", in_tmp.name, "-map", "0", "-c", "copy",
            "-map_metadata", "-1", "-map_chapters", "-1",
            "-brand", "isom", "-movflags", "+faststart",
            "-video_track_timescale", "90000",
            "-metadata:s:v:0", "handler_name=VideoHandler",
            "-metadata:s:a:0", "handler_name=SoundHandler",
            remux_tmp.name
        ]
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if res.returncode != 0:
            raise RuntimeError(f"FFmpeg faststart remux failed: {res.stderr.strip()}")

        with open(remux_tmp.name, 'rb') as f:
            buf = f.read()

        # Step 2: Box Parsing & Patching
        boxes = parse_boxes(buf, 0, len(buf))
        moov = next((b for b in boxes if b.type == "moov"), None)
        mdat = next((b for b in boxes if b.type == "mdat"), None)
        if not moov or not mdat:
            raise ValueError("moov or mdat missing")

        traks = [b for b in moov.children if b.type == "trak"]
        v_trak = next((t for t in traks if is_video_trak(buf, t)), None)
        if not v_trak:
            raise ValueError("Video track missing")

        stbl = child_path(v_trak, ["mdia", "minf", "stbl"])
        stsz = find_child(stbl, "stsz") if stbl else None
        if not stsz:
            raise ValueError("stsz box missing")

        sample_count = u32(payload(buf, stsz), 8)
        total_samples = (sample_count * 20) // 3
        add_count = max(0, total_samples - sample_count)

        active_trak = None

        def walk_moov(b, shift, fake_off):
            nonlocal active_trak
            if b.type == "udta":
                return None
            if b.type == "mdhd":
                return patch_mdhd_lang(buf, b)
            if b.type == "hdlr":
                return patch_hdlr_name(buf, b)

            is_video = (active_trak == v_trak)
            if is_video and b.type == "stsz":
                return patch_stsz(buf, b, add_count)
            if is_video and b.type == "stts":
                return raw(buf, b)
            if is_video and b.type == "stsc" and add_count > 0:
                stco = find_child(stbl, "stco") or find_child(stbl, "co64")
                return patch_stsc(buf, b, u32(payload(buf, stco), 4))
            if b.type == "stco":
                return patch_stco(buf, b, shift, fake_off, add_count)
            if b.type == "co64":
                return patch_co64(buf, b, shift, fake_off, add_count)

            if b.children:
                parts = []
                if b.type == "meta":
                    parts.append(payload(buf, b)[:4])
                for child in b.children:
                    prev_trak = active_trak
                    if child.type == "trak":
                        active_trak = child
                    patched = walk_moov(child, shift, fake_off)
                    active_trak = prev_trak
                    if patched:
                        parts.append(patched)
                return box(b.type, b"".join(parts))
            return raw(buf, b)

        end_pos = mdat.end
        new_moov = walk_moov(moov, 0, end_pos)
        diff = len(new_moov) - len(raw(buf, moov))
        end_pos = mdat.end + diff
        new_moov = walk_moov(moov, diff, end_pos)

        mdat_payload = buf[mdat.start + 8:mdat.end]
        if add_count > 0:
            new_mdat = w32(8 + len(mdat_payload) + 8) + b"mdat" + mdat_payload + FAKE_SAMPLE
        else:
            new_mdat = raw(buf, mdat)

        out_boxes = []
        free_box = w32(8) + b"free"
        for b in boxes:
            if b.type == "ftyp":
                out_boxes.append(raw(buf, b))
                out_boxes.append(free_box)
            elif b.type == "moov":
                out_boxes.append(new_moov)
            elif b.type == "mdat":
                out_boxes.append(new_mdat)
            elif b.type in ("free", "wide"):
                continue
            else:
                out_boxes.append(raw(buf, b))

        return b"".join(out_boxes), sample_count, add_count

    finally:
        for p in (in_tmp.name, remux_tmp.name):
            if os.path.exists(p):
                try:
                    os.remove(p)
                except Exception:
                    pass
