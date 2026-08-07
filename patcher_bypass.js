const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

// --- MP4 Parsing & Patching Constants ---
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta", "ilst"]);
const FAKE_SAMPLE = Buffer.from([0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]);

function u32(buf, pos) {
  return buf.readUInt32BE(pos);
}

function u64(buf, pos) {
  return Number(buf.readBigUInt64BE(pos));
}

function w32(val) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(val >>> 0, 0);
  return b;
}

function box(bType, payload) {
  const len = payload.length + 8;
  return Buffer.concat([w32(len), Buffer.from(bType, 'latin1'), payload]);
}

function boxType(buf, pos) {
  return buf.toString('latin1', pos + 4, pos + 8);
}

function sizeAt(buf, pos, maxLen) {
  if (pos + 8 > maxLen) return 0;
  const s = u32(buf, pos);
  if (s === 1) {
    if (pos + 16 > maxLen) return 0;
    return u64(buf, pos + 8);
  }
  if (s === 0) return maxLen - pos;
  return s;
}

function parseBoxes(buf, start, end) {
  const boxes = [];
  let curr = start;
  while (curr + 8 <= end) {
    const s = sizeAt(buf, curr, end);
    if (!s || curr + s > end) break;
    const t = boxType(buf, curr);
    const hdr = u32(buf, curr) === 1 ? 16 : 8;
    const obj = { type: t, start: curr, end: curr + s, size: s, header: hdr, children: null };
    let childStart = curr + hdr;
    if (t === 'meta') childStart += 4;
    if (CONTAINERS.has(t) && childStart < curr + s) {
      obj.children = parseBoxes(buf, childStart, curr + s);
    }
    boxes.push(obj);
    curr += s;
  }
  return boxes;
}

function raw(buf, boxObj) {
  return buf.subarray(boxObj.start, boxObj.end);
}

function payload(buf, boxObj) {
  return buf.subarray(boxObj.start + boxObj.header, boxObj.end);
}

function findChild(parent, t) {
  if (!parent || !parent.children) return null;
  return parent.children.find(c => c.type === t) || null;
}

function childPath(parent, pathList) {
  let curr = parent;
  for (const t of pathList) {
    curr = findChild(curr, t);
    if (!curr) return null;
  }
  return curr;
}

function isVideoTrak(buf, trak) {
  const hdlr = childPath(trak, ["mdia", "hdlr"]);
  if (!hdlr) return false;
  const p = payload(buf, hdlr);
  return p.toString('latin1', 8, 12) === "vide";
}

function patchMdhdLang(buf, boxObj) {
  const p = Buffer.from(payload(buf, boxObj));
  const off = p[0] === 1 ? 28 : 16;
  if (off + 2 <= p.length) {
    p.writeUInt16BE(21956, off);
  }
  return box("mdhd", p);
}

function patchHdlrName(buf, boxObj) {
  const p = payload(buf, boxObj);
  const name = p.length >= 12 ? p.toString('latin1', 8, 12) : "";
  let hName = null;
  if (name === "vide") hName = "VideoHandler\0";
  else if (name === "soun") hName = "SoundHandler\0";
  if (!hName) return raw(buf, boxObj);
  return box("hdlr", Buffer.concat([p.subarray(0, 24), Buffer.from(hName, 'utf8')]));
}

function patchStsz(buf, boxObj, addCount) {
  if (addCount < 1) return raw(buf, boxObj);
  const p = payload(buf, boxObj);
  const hdr = p.subarray(0, 4);
  const sSize = u32(p, 4);
  const count = u32(p, 8);
  const sizes = [];
  if (sSize !== 0) {
    for (let i = 0; i < count; i++) sizes.push(sSize);
  } else {
    let off = 12;
    for (let i = 0; i < count; i++) {
      if (off + 4 <= p.length) {
        sizes.push(u32(p, off));
        off += 4;
      }
    }
  }
  for (let i = 0; i < addCount; i++) sizes.push(8);

  const out = Buffer.alloc(12 + sizes.length * 4);
  hdr.copy(out, 0);
  out.writeUInt32BE(0, 4);
  out.writeUInt32BE(sizes.length, 8);
  for (let idx = 0; idx < sizes.length; idx++) {
    out.writeUInt32BE(sizes[idx], 12 + idx * 4);
  }
  return box("stsz", out);
}

function patchStsc(buf, boxObj, lastChunk) {
  if (lastChunk < 1) return raw(buf, boxObj);
  const p = payload(buf, boxObj);
  const hdr = p.subarray(0, 4);
  const count = u32(p, 4);
  const entries = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    if (off + 12 <= p.length) {
      entries.push([u32(p, off), u32(p, off + 4), u32(p, off + 8)]);
      off += 12;
    }
  }
  const lastDesc = entries.length > 0 ? entries[entries.length - 1][2] : 1;
  entries.push([lastChunk + 1, 1, lastDesc]);

  const out = Buffer.alloc(8 + entries.length * 12);
  hdr.copy(out, 0);
  out.writeUInt32BE(entries.length, 4);
  for (let idx = 0; idx < entries.length; idx++) {
    const base = 8 + idx * 12;
    out.writeUInt32BE(entries[idx][0], base);
    out.writeUInt32BE(entries[idx][1], base + 4);
    out.writeUInt32BE(entries[idx][2], base + 8);
  }
  return box("stsc", out);
}

function patchStco(buf, boxObj, shift, fakeOffset, addCount) {
  const p = payload(buf, boxObj);
  const hdr = p.subarray(0, 4);
  const count = u32(p, 4);
  const offsets = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    if (off + 4 <= p.length) {
      offsets.push(u32(p, off) + shift);
      off += 4;
    }
  }
  for (let i = 0; i < addCount; i++) offsets.push(fakeOffset);

  const out = Buffer.alloc(8 + offsets.length * 4);
  hdr.copy(out, 0);
  out.writeUInt32BE(offsets.length, 4);
  for (let idx = 0; idx < offsets.length; idx++) {
    out.writeUInt32BE(offsets[idx] >>> 0, 8 + idx * 4);
  }
  return box("stco", out);
}

function patchCo64(buf, boxObj, shift, fakeOffset, addCount) {
  const p = payload(buf, boxObj);
  const hdr = p.subarray(0, 4);
  const count = u32(p, 4);
  const offsets = [];
  let off = 8;
  for (let i = 0; i < count; i++) {
    if (off + 8 <= p.length) {
      offsets.push(u64(p, off) + shift);
      off += 8;
    }
  }
  for (let i = 0; i < addCount; i++) offsets.push(fakeOffset);

  const out = Buffer.alloc(8 + offsets.length * 8);
  hdr.copy(out, 0);
  out.writeUInt32BE(offsets.length, 4);
  for (let idx = 0; idx < offsets.length; idx++) {
    out.writeBigUInt64BE(BigInt(offsets[idx]), 8 + idx * 8);
  }
  return box("co64", out);
}

// --- Main Patch Process ---
function processVideo(inputPath, outputPath) {
  const remuxPath = path.join(os.tmpdir(), `remux_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);

  try {
    // Step 1: Native FFmpeg Faststart Remux
    const ffmpegArgs = [
      '-y',
      '-i', inputPath,
      '-map', '0',
      '-c', 'copy',
      '-map_metadata', '-1',
      '-map_chapters', '-1',
      '-brand', 'isom',
      '-movflags', '+faststart',
      '-video_track_timescale', '90000',
      remuxPath
    ];

    try {
      execFileSync('ffmpeg', ffmpegArgs, { stdio: 'pipe', timeout: 300000 });
    } catch (err) {
      const stderr = err.stderr ? err.stderr.toString('utf8') : err.message;
      throw new Error(`FFmpeg failed: ${stderr.slice(-200)}`);
    }

    // Step 2: Custom Sample Table & Box Modification
    const buf = fs.readFileSync(remuxPath);
    const boxes = parseBoxes(buf, 0, buf.length);
    const moov = boxes.find(b => b.type === 'moov');
    const mdat = boxes.find(b => b.type === 'mdat');

    if (!moov || !mdat) {
      throw new Error("moov or mdat box missing");
    }

    const traks = (moov.children || []).filter(b => b.type === 'trak');
    const vTrak = traks.find(t => isVideoTrak(buf, t));
    if (!vTrak) {
      throw new Error("Video track missing");
    }

    const stbl = childPath(vTrak, ["mdia", "minf", "stbl"]);
    const stsz = findChild(stbl, "stsz");
    const sampleCount = u32(payload(buf, stsz), 8);

    const totalSamples = Math.floor((sampleCount * 20) / 3);
    const addCount = Math.max(0, totalSamples - sampleCount);

    let activeTrak = null;

    function walkMoov(bObj, shift, fakeOff) {
      if (bObj.type === 'udta') return null;
      if (bObj.type === 'mdhd') return patchMdhdLang(buf, bObj);
      if (bObj.type === 'hdlr') return patchHdlrName(buf, bObj);

      const isVideo = (activeTrak === vTrak);
      if (isVideo && bObj.type === 'stsz') {
        return patchStsz(buf, bObj, addCount);
      }
      if (isVideo && bObj.type === 'stts') {
        return raw(buf, bObj);
      }
      if (isVideo && bObj.type === 'stsc' && addCount > 0) {
        const stcoBox = findChild(stbl, "stco") || findChild(stbl, "co64");
        return patchStsc(buf, bObj, u32(payload(buf, stcoBox), 4));
      }
      if (bObj.type === 'stco') {
        return patchStco(buf, bObj, shift, fakeOff, addCount);
      }
      if (bObj.type === 'co64') {
        return patchCo64(buf, bObj, shift, fakeOff, addCount);
      }

      if (bObj.children && bObj.children.length > 0) {
        const parts = [];
        if (bObj.type === 'meta') {
          parts.push(payload(buf, bObj).subarray(0, 4));
        }
        for (const child of bObj.children) {
          const prevTrak = activeTrak;
          if (child.type === 'trak') activeTrak = child;
          const patched = walkMoov(child, shift, fakeOff);
          activeTrak = prevTrak;
          if (patched) parts.push(patched);
        }
        return box(bObj.type, Buffer.concat(parts));
      }

      return raw(buf, bObj);
    }

    let endPos = mdat.end;
    let newMoov = walkMoov(moov, 0, endPos);
    const diff = newMoov.length - raw(buf, moov).length;
    endPos = mdat.end + diff;
    newMoov = walkMoov(moov, diff, endPos);

    const mdatPayload = buf.subarray(mdat.start + 8, mdat.end);
    let newMdat;
    if (addCount > 0) {
      newMdat = Buffer.concat([
        w32(8 + mdatPayload.length + 8),
        Buffer.from('mdat', 'latin1'),
        mdatPayload,
        FAKE_SAMPLE
      ]);
    } else {
      newMdat = raw(buf, mdat);
    }

    const outBoxes = [];
    const freeBox = Buffer.concat([w32(8), Buffer.from('free', 'latin1')]);

    for (const b of boxes) {
      if (b.type === 'ftyp') {
        outBoxes.push(raw(buf, b));
        outBoxes.push(freeBox);
      } else if (b.type === 'moov') {
        outBoxes.push(newMoov);
      } else if (b.type === 'mdat') {
        outBoxes.push(newMdat);
      } else if (b.type === 'free' || b.type === 'wide') {
        continue;
      } else {
        outBoxes.push(raw(buf, b));
      }
    }

    fs.writeFileSync(outputPath, Buffer.concat(outBoxes));
    console.log(`Bypass patch applied successfully -> ${outputPath}`);
  } finally {
    if (fs.existsSync(remuxPath)) {
      try { fs.unlinkSync(remuxPath); } catch (e) {}
    }
  }
}

// Command Line Execution Support
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node "( bypass ) patcher.js" <input.mp4> <output.mp4>');
  process.exit(1);
}

processVideo(args[0], args[1]);
