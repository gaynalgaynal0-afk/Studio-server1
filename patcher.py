"""
Shark (NXT_Shark537) MP4 Patcher for TikTok
Reconstructs MP4 with fake samples inflated by factor of 9x
Based on: https://github.com/nxt-shark/shark-extension
"""

import struct
import io

# Constants from Shark extension
FAKE_SAMPLE_SIZE = 8
FAKE_SAMPLE_BYTES = bytes([0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00])
VIDEO_TIMESCALE = 90000
VIDEO_DURATION = 2269500
VIDEO_EDIT_MEDIA_TIME = 0
VIDEO_SAMPLE_DELTA = 1500

CONTAINER_BOXES = {'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta', 'ilst'}


class Box:
    """Represents an MP4 atom/box"""
    def __init__(self, box_type, offset, size, header_size, data, parent_path=''):
        self.type = box_type
        self.offset = offset
        self.size = size
        self.header_size = header_size
        self.content_start = offset + header_size
        self.end = offset + size
        self.path = f"{parent_path}/{box_type}" if parent_path else box_type
        self.data = data
        self.children = []
        self.prefix_start = offset + header_size
        self.prefix_end = offset + header_size


def get_box_type(data, offset):
    """Read 4-char box type"""
    return chr(data[offset]) + chr(data[offset+1]) + chr(data[offset+2]) + chr(data[offset+3])


def set_box_type(data, offset, box_type):
    """Write 4-char box type"""
    for i in range(4):
        data[offset + i] = ord(box_type[i])


def read_box(data, offset, end, parent_path=''):
    """Parse one MP4 box header"""
    if offset + 8 > end:
        raise ValueError("Invalid MP4: incomplete box header")
    
    small_size = struct.unpack('>I', data[offset:offset+4])[0]
    box_type = get_box_type(data, offset + 4)
    size = small_size
    header_size = 8
    
    if small_size == 1:  # 64-bit size
        if offset + 16 > end:
            raise ValueError(f"Invalid MP4: incomplete box {box_type}")
        high, low = struct.unpack('>II', data[offset+8:offset+16])
        size = high * 4294967296 + low
        header_size = 16
    elif small_size == 0:  # size to end
        size = end - offset
    
    if size < header_size or offset + size > end:
        raise ValueError(f"Invalid MP4: wrong size for box {box_type}")
    
    return Box(box_type, offset, size, header_size, data, parent_path)


def parse_boxes(data, start=0, end=None, parent_path=''):
    """Recursively parse MP4 box structure"""
    if end is None:
        end = len(data)
    
    boxes = []
    offset = start
    
    while offset + 8 <= end:
        box = read_box(data, offset, end, parent_path)
        
        if box.type in CONTAINER_BOXES:
            child_start = box.content_start
            if box.type == 'meta':
                child_start += 4
            
            if child_start > box.end:
                raise ValueError(f"Invalid MP4: container {box.type} too short")
            
            box.prefix_start = box.content_start
            box.prefix_end = child_start
            box.children = parse_boxes(data, child_start, box.end, box.path)
        
        boxes.append(box)
        offset = box.end
    
    return boxes


def find_child(box, box_type):
    """Find immediate child by type"""
    for child in box.children:
        if child.type == box_type:
            return child
    return None


def find_descendant(box, path):
    """Find nested descendant by path"""
    current = box
    for box_type in path:
        current = find_child(current, box_type)
        if not current:
            return None
    return current


def find_top_level(boxes, box_type):
    """Find top-level box by type"""
    for box in boxes:
        if box.type == box_type:
            return box
    return None


def parse_stsz(box):
    """Extract sample sizes from stsz box"""
    sample_size = struct.unpack('>I', box.data[box.content_start+4:box.content_start+8])[0]
    count = struct.unpack('>I', box.data[box.content_start+8:box.content_start+12])[0]
    
    if sample_size:
        return [sample_size] * count
    
    sizes = []
    table_start = box.content_start + 12
    for i in range(count):
        sizes.append(struct.unpack('>I', box.data[table_start+i*4:table_start+(i+1)*4])[0])
    
    return sizes


def parse_stsc(box):
    """Extract chunk-to-sample mappings from stsc box"""
    count = struct.unpack('>I', box.data[box.content_start+4:box.content_start+8])[0]
    rows = []
    table_start = box.content_start + 8
    
    for i in range(count):
        offset = table_start + i * 12
        row = struct.unpack('>III', box.data[offset:offset+12])
        rows.append(row)
    
    return rows


def parse_stco(box):
    """Extract chunk offsets from stco box"""
    count = struct.unpack('>I', box.data[box.content_start+4:box.content_start+8])[0]
    offsets = []
    table_start = box.content_start + 8
    
    for i in range(count):
        offsets.append(struct.unpack('>I', box.data[table_start+i*4:table_start+(i+1)*4])[0])
    
    return offsets


def make_box(box_type, payload):
    """Create an MP4 box from type and payload"""
    size = 8 + len(payload)
    if size > 0xffffffff:
        raise ValueError(f"{box_type} size exceeds uint32")
    
    box_data = bytearray(size)
    struct.pack_into('>I', box_data, 0, size)
    set_box_type(box_data, 4, box_type)
    box_data[8:] = payload
    
    return bytes(box_data)


def build_mdhd(box):
    """Rebuild mdhd with new timescale and duration"""
    payload = bytearray(box.data[box.content_start:box.end])
    version = payload[0]
    
    if version != 0:
        raise ValueError(f"Unsupported mdhd version: {version}")
    
    struct.pack_into('>I', payload, 12, VIDEO_TIMESCALE)
    struct.pack_into('>I', payload, 16, VIDEO_DURATION)
    
    return make_box('mdhd', bytes(payload))


def build_elst(box):
    """Rebuild elst with new media_time"""
    payload = bytearray(box.data[box.content_start:box.end])
    version = payload[0]
    entry_count = struct.unpack('>I', payload[4:8])[0]
    
    if version != 0 or entry_count < 1:
        raise ValueError("elst must be version 0 with at least 1 entry")
    
    struct.pack_into('>I', payload, 12, VIDEO_EDIT_MEDIA_TIME)
    
    return make_box('elst', bytes(payload))


def build_stts(real_sample_count, fake_sample_count):
    """Create new stts with 2 entries: real + fake samples"""
    payload = bytearray(24)  # version/flags + 2 entries (8+8 bytes each)
    struct.pack_into('>I', payload, 4, 2)  # 2 entries
    struct.pack_into('>I', payload, 8, real_sample_count)
    struct.pack_into('>I', payload, 12, VIDEO_SAMPLE_DELTA)
    struct.pack_into('>I', payload, 16, fake_sample_count)
    struct.pack_into('>I', payload, 20, VIDEO_SAMPLE_DELTA)
    
    return make_box('stts', bytes(payload))


def build_stsz(original_sizes, fake_sample_count):
    """Create new stsz with original + fake samples"""
    total_samples = len(original_sizes) + fake_sample_count
    payload = bytearray(12 + total_samples * 4)  # version/flags + size + entries
    struct.pack_into('>I', payload, 8, total_samples)
    
    offset = 12
    for size in original_sizes:
        struct.pack_into('>I', payload, offset, size)
        offset += 4
    
    for _ in range(fake_sample_count):
        struct.pack_into('>I', payload, offset, FAKE_SAMPLE_SIZE)
        offset += 4
    
    return make_box('stsz', bytes(payload))


def build_stsc(original_rows, original_chunk_count):
    """Create new stsc with additional entry for fake samples"""
    rows = [list(row) for row in original_rows]
    last_row = rows[-1] if rows else None
    
    if not last_row or last_row[1] != 1:
        rows.append([original_chunk_count + 1, 1, 1])
    
    payload = bytearray(8 + len(rows) * 12)
    struct.pack_into('>I', payload, 4, len(rows))
    
    offset = 8
    for first_chunk, samples_per_chunk, sample_desc_idx in rows:
        struct.pack_into('>III', payload, offset, first_chunk, samples_per_chunk, sample_desc_idx)
        offset += 12
    
    return make_box('stsc', bytes(payload))


def build_stco(original_offsets, delta, fake_offset=None, fake_sample_count=0):
    """Create new stco with offset adjustments"""
    count = len(original_offsets)
    if fake_offset is not None:
        count += fake_sample_count
    
    payload = bytearray(8 + count * 4)
    struct.pack_into('>I', payload, 4, count)
    
    offset = 8
    for orig_offset in original_offsets:
        shifted = orig_offset + delta
        if shifted < 0 or shifted > 0xffffffff:
            raise ValueError(f"stco offset out of range: {shifted}")
        struct.pack_into('>I', payload, offset, shifted)
        offset += 4
    
    if fake_offset is not None:
        if fake_offset < 0 or fake_offset > 0xffffffff:
            raise ValueError(f"stco fake_offset out of range: {fake_offset}")
        for _ in range(fake_sample_count):
            struct.pack_into('>I', payload, offset, fake_offset)
            offset += 4
    
    return make_box('stco', bytes(payload))


def box_bytes(box):
    """Get raw bytes of a box"""
    return bytes(box.data[box.offset:box.end])


def box_payload(box):
    """Get payload bytes of a box"""
    return bytes(box.data[box.content_start:box.end])


def concat_bytes(parts):
    """Concatenate byte arrays"""
    total = sum(len(p) for p in parts)
    if total > 0xffffffff:
        raise ValueError("Output size exceeds uint32")
    
    output = bytearray(total)
    offset = 0
    for part in parts:
        output[offset:offset+len(part)] = part
        offset += len(part)
    
    return bytes(output)


def rebuild_box(box, replacements):
    """Recursively rebuild a box with replacements"""
    if box in replacements:
        return replacements[box]
    
    if not box.children:
        return box_bytes(box)
    
    parts = [bytes(box.data[box.prefix_start:box.prefix_end])]
    for child in box.children:
        parts.append(rebuild_box(child, replacements))
    
    return make_box(box.type, concat_bytes(parts))


def handler_type_for_trak(trak):
    """Get handler type (vide/soun) for a track"""
    hdlr = find_descendant(trak, ['mdia', 'hdlr'])
    if not hdlr or hdlr.offset + 20 > hdlr.end:
        return None
    return get_box_type(hdlr.data, hdlr.offset + 16)


def patch_shark_sample_table(raw_bytes: bytes):
    """
    Shark upload method: reconstructs MP4 with inflated fake samples
    
    - fake_samples = real_samples * 9
    - Rebuilds: mdhd, elst, stts, stsz, stsc, stco
    - Recalculates offsets iteratively
    - Appends fake data to mdat
    
    Returns: (patched_bytes, real_samples, fake_samples)
    """
    try:
        data = bytearray(raw_bytes)
        
        # Parse MP4 structure
        top_level = parse_boxes(data)
        
        ftyp = find_top_level(top_level, 'ftyp')
        moov = find_top_level(top_level, 'moov')
        mdat = find_top_level(top_level, 'mdat')
        
        if not ftyp:
            raise ValueError("ftyp box not found")
        if not moov:
            raise ValueError("moov box not found")
        if not mdat:
            raise ValueError("mdat box not found")
        
        # Find video track
        video_trak = None
        for child in moov.children:
            if child.type == 'trak' and handler_type_for_trak(child) == 'vide':
                video_trak = child
                break
        
        if not video_trak:
            raise ValueError("Video track not found")
        
        # Find sample tables
        stbl = find_descendant(video_trak, ['mdia', 'minf', 'stbl'])
        mdhd = find_descendant(video_trak, ['mdia', 'mdhd'])
        elst = find_descendant(video_trak, ['edts', 'elst'])
        stts = find_child(stbl, 'stts') if stbl else None
        stsc = find_child(stbl, 'stsc') if stbl else None
        stsz = find_child(stbl, 'stsz') if stbl else None
        stco = find_child(stbl, 'stco') if stbl else None
        
        if not all([stbl, mdhd, elst, stts, stsc, stsz, stco]):
            raise ValueError("Missing required MP4 tables")
        
        # Extract sample data
        original_sizes = parse_stsz(stsz)
        real_sample_count = len(original_sizes)
        fake_sample_count = real_sample_count * 9  # KEY: 9x inflation
        
        original_stsc_rows = parse_stsc(stsc)
        original_stco_offsets = parse_stco(stco)
        
        # Collect all stco boxes
        stco_boxes = []
        for trak in moov.children:
            if trak.type == 'trak':
                trak_stbl = find_descendant(trak, ['mdia', 'minf', 'stbl'])
                if trak_stbl:
                    trak_stco = find_child(trak_stbl, 'stco')
                    if trak_stco:
                        stco_boxes.append(trak_stco)
        
        # Build replacements
        fixed_replacements = {
            mdhd: build_mdhd(mdhd),
            elst: build_elst(elst),
            stts: build_stts(real_sample_count, fake_sample_count),
            stsc: build_stsc(original_stsc_rows, len(original_stco_offsets)),
            stsz: build_stsz(original_sizes, fake_sample_count),
        }
        
        # First pass: build with placeholder offsets
        placeholder_replacements = dict(fixed_replacements)
        for stco_box in stco_boxes:
            placeholder_replacements[stco_box] = build_stco(
                parse_stco(stco_box), 0, 0 if stco_box == stco else None, fake_sample_count
            )
        
        moov_placeholder = rebuild_box(moov, placeholder_replacements)
        
        # Calculate offset delta
        old_mdat_payload_start = mdat.content_start
        old_mdat_payload = data[mdat.content_start:mdat.end]
        new_mdat_payload_start = ftyp.size + len(moov_placeholder) + 8
        delta = new_mdat_payload_start - old_mdat_payload_start
        fake_offset = new_mdat_payload_start + len(old_mdat_payload)
        
        # Second pass: build with real offsets
        final_replacements = dict(fixed_replacements)
        for stco_box in stco_boxes:
            final_replacements[stco_box] = build_stco(
                parse_stco(stco_box), delta, fake_offset if stco_box == stco else None, fake_sample_count
            )
        
        moov_new = rebuild_box(moov, final_replacements)
        
        # Final offset recalculation
        recalc_mdat_payload_start = ftyp.size + len(moov_new) + 8
        delta = recalc_mdat_payload_start - old_mdat_payload_start
        fake_offset = recalc_mdat_payload_start + len(old_mdat_payload)
        
        final_replacements = dict(fixed_replacements)
        for stco_box in stco_boxes:
            final_replacements[stco_box] = build_stco(
                parse_stco(stco_box), delta, fake_offset if stco_box == stco else None, fake_sample_count
            )
        
        moov_new = rebuild_box(moov, final_replacements)
        
        # Build final MP4
        mdat_payload_new = concat_bytes([old_mdat_payload, FAKE_SAMPLE_BYTES])
        mdat_new = make_box('mdat', mdat_payload_new)
        
        output = concat_bytes([
            box_bytes(ftyp),
            moov_new,
            mdat_new
        ])
        
        return bytes(output), real_sample_count, fake_sample_count
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise ValueError(f"Shark patching failed: {str(e)}")
