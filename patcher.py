import struct

def read_u32(buf, offset):
    return struct.unpack(">I", buf[offset:offset+4])[0]

def write_u32(buf, offset, value):
    buf[offset:offset+4] = struct.pack(">I", value)

# Find box inside bounds
def find_box(buf, name, start, end):
    i = start
    while i < end:
        if i + 8 > len(buf):
            break

        size = read_u32(buf, i)
        typ = buf[i+4:i+8].decode("ascii", errors="ignore")

        if typ == name:
            return {"offset": i, "size": size}

        if size < 8:
            break

        i += size

    return None


def patch_fps(input_file, output_file, multiplier):
    with open(input_file, "rb") as f:
        buf = bytearray(f.read())

    # Find hierarchy
    moov = find_box(buf, "moov", 0, len(buf))
    if not moov:
        raise Exception("moov not found")

    trak = find_box(buf, "trak", moov["offset"], moov["offset"] + moov["size"])
    if not trak:
        raise Exception("trak not found")

    mdia = find_box(buf, "mdia", trak["offset"], trak["offset"] + trak["size"])
    if not mdia:
        raise Exception("mdia not found")

    mdhd = find_box(buf, "mdhd", mdia["offset"], mdia["offset"] + mdia["size"])
    if not mdhd:
        raise Exception("mdhd not found")

    minf = find_box(buf, "minf", mdia["offset"], mdia["offset"] + mdia["size"])
    stbl = find_box(buf, "stbl", minf["offset"], minf["offset"] + minf["size"])
    stts = find_box(buf, "stts", stbl["offset"], stbl["offset"] + stbl["size"])

    if not stts:
        raise Exception("stts not found")

    # Read sample_delta
    entry_count_offset = stts["offset"] + 12
    entry_count = read_u32(buf, entry_count_offset)

    if entry_count < 1:
        raise Exception("No stts entries")

    sample_delta_offset = entry_count_offset + 8
    sample_delta = read_u32(buf, sample_delta_offset)

    print("Original sample_delta:", sample_delta)

    # Patch
    new_delta = int(sample_delta * multiplier)
    write_u32(buf, sample_delta_offset, new_delta)

    print("New sample_delta:", new_delta)

    with open(output_file, "wb") as f:
        f.write(buf)

    print("Saved:", output_file)


# Run example
if __name__ == "__main__":
    patch_fps("input.mp4", "output.mp4", 2.0)
