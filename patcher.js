const fs = require("fs");
const path = require("path");

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "udta", "meta", "ilst"]);
const FAKE_SAMPLE = Buffer.from([0, 0, 0, 4, 0, 0, 0, 0]);

function u32(buf, pos) { return buf.readUInt32BE(pos); }
function u64(buf, pos) { return Number(buf.readBigUInt64BE(pos)); }
function w32(val) { const b = Buffer.alloc(4); b.writeUInt32BE(val >>> 0, 0); return b; }
function box(type, payload) { return Buffer.concat([w32(payload.length + 8), Buffer.from(type, "latin1"), payload]); }
function boxType(buf, pos) { return buf.toString("latin1", pos + 4, pos + 8); }

function sizeAt(buf, pos, max) {
  if (pos + 8 > max) return 0;
  const s = u32(buf, pos);
  if (s === 1) {
    if (pos + 16 > max) return 0;
    return u64(buf, pos + 8);
  }
  if (s === 0) return max - pos;
  return s;
}

function parseBoxes(buf, start, end) {
  const boxes = [];
  let curr = start;
  while (curr + 8 <= end) {
    const s = sizeAt(buf, curr, end);
    if (!s || curr + s > end) break;
    const type = boxType(buf, curr);
    const hdr = u32(buf, curr) === 1 ? 16 : 8;
    const b = { type, start: curr, end: curr + s, size: s, header: hdr, children: null };
    let childStart = curr + hdr;
    if (type === "meta") childStart += 4;
    if (CONTAINERS.has(type) && childStart < curr + s) b.children = parseBoxes(buf, childStart, curr + s);
    boxes.push(b);
    curr += s;
  }
  return boxes;
}

function raw(buf, boxObj) { return buf.subarray(boxObj.start, boxObj.end); }
function payload(buf, boxObj) { return buf.subarray(boxObj.start + boxObj.header, boxObj.end); }
function findChild(parent, type) { return (parent.children || []).find(c => c.type === type); }
function childPath(parent, pathArr) {
  let curr = parent;
  for (const t of pathArr) {
    curr = findChild(curr, t);
    if (!curr) return null;
  }
  return curr;
}

// --- Step 1: Pure JS Remux (Faststart Offset Adjustment) ---
function updateChunkOffsets(buf, b, shift) {
  const p = payload(buf, b);
  const hdr = p.subarray(0, 4);
  const count = u32(p, 4);

  if (b.type === "stco") {
    const out = Buffer.alloc(8 + count * 4);
    hdr.copy(out, 0);
    out.writeUInt32BE(count, 4);
    for (let i = 0, off = 8; i < count; i++, off += 4) {
      out.writeUInt32BE((u32(p, off) + shift) >>> 0, 8 + i * 4);
    }
    return box("stco", out);
  } else if (b.type === "co64") {
    const out = Buffer.alloc(8 + count * 8);
    hdr.copy(out, 0);
    out.writeUInt32BE(count, 4);
    for (let i = 0, off = 8; i < count; i++, off += 8) {
      out.writeBigUInt64BE(BigInt(u64(p, off) + shift), 8 + i * 8);
    }
    return box("co64", out);
  }
  return raw(buf, b);
}

function remuxFaststart(inputBuf) {
  const boxes = parseBoxes(inputBuf, 0, inputBuf.length);
  const ftyp = boxes.find(b => b.type === "ftyp");
  const moov = boxes.find(b => b.type === "moov");
  const mdat = boxes.find(b => b.type === "mdat");

  if (!moov || !mdat) return inputBuf;

  function shiftMoovOffsets(b, shift) {
    if (b.type === "udta") return null;
    if (b.type === "stco" || b.type === "co64") return updateChunkOffsets(inputBuf, b, shift);
    if (b.children) {
      const parts = [];
      if (b.type === "meta") parts.push(payload(inputBuf, b).subarray(0, 4));
      for (const child of b.children) {
        const patched = shiftMoovOffsets(child, shift);
        if (patched) parts.push(patched);
      }
      return box(b.type, Buffer.concat(parts));
    }
    return raw(inputBuf, b);
  }

  let shiftedMoov = shiftMoovOffsets(moov, 0);
  if (moov.start > mdat.start) {
    shiftedMoov = shiftMoovOffsets(moov, shiftedMoov.length);
  }

  const outBoxes = [];
  if (ftyp) outBoxes.push(raw(inputBuf, ftyp));
  outBoxes.push(shiftedMoov);
  outBoxes.push(raw(inputBuf, mdat));

  return Buffer.concat(outBoxes);
}

// --- Step 2: Patch Sample Tables & Metadata ---
function isVideoTrak(buf, trak) {
  const hdlr = childPath(trak, ["mdia", "hdlr"]);
  return Boolean(hdlr && payload(buf, hdlr).toString("latin1", 8, 12) === "vide");
}

function patchMdhdLang(buf, b) {
  const p = Buffer.from(payload(buf, b));
  const off = p[0] === 1 ? 28 : 16;
  if (off + 2 <= p.length) p.writeUInt16BE(21956, off);
  return box("mdhd", p);
}

function patchHdlrName(buf, b) {
  const p = Buffer.from(payload(buf, b));
  const name = p.length >= 12 ? p.toString("latin1", 8, 12) : "";
  const hName = name === "vide" ? "VideoHandler\0" : name === "soun" ? "SoundHandler\0" : null;
  if (!hName) return raw(buf, b);
  return box("hdlr", Buffer.concat([p.subarray(0, 24), Buffer.from(hName, "utf8")]));
}

function patchStsz(buf, b, addCount) {
  if (addCount < 1) return raw(buf, b);
  const p = payload(buf, b);
  const hdr = p.subarray(0, 4);
  const sSize = u32(p, 4);
  const count = u32(p, 8);
  const sizes = [];
  if (sSize !== 0) {
    for (let i = 0; i < count; i++) sizes.push(sSize);
  } else {
    for (let i = 0, off = 12; i < count && off + 4 <= p.length; i++, off += 4) sizes.push(u32(p, off));
  }
  for (let i = 0; i < addCount; i++) sizes.push(8);
  const out = Buffer.alloc(12 + sizes.length * 4);
  hdr.copy(out, 0);
  out.writeUInt32BE(0, 4);
  out.writeUInt32BE(sizes.length, 8);
  sizes.forEach((sz, idx) => out.writeUInt32BE(sz >>> 0, 12 + idx * 4));
  return box("stsz", out);
}

function patchStsc(buf, b, lastChunk) {
  if (lastChunk < 1) return raw(buf, b);
  const p = payload(buf, b);
  const hdr = p.subarray(0, 4);
  const count = u32(p, 4);
  const entries = [];
  for (let i = 0, off = 8; i < count && off + 12 <= p.length; i++, off += 12) {
    entries.push([u32(p, off), u32(p, off + 4), u32(p, off + 8)]);
  }
  const lastDesc = entries.length ? entries[entries.length - 1][2] : 1;
  entries.push([lastChunk + 1, 1, lastDesc]);
  const out = Buffer.alloc(8 + entries.length * 12);
  hdr.copy(out, 0);
  out.writeUInt32BE(entries.length, 4);
  entries.forEach((e, idx) => {
    out.writeUInt32BE(e[0] >>> 0, 8 + idx * 12);
    out.writeUInt32BE(e[1] >>> 0, 12 + idx * 12);
    out.writeUInt32BE(e[2] >>> 0, 16 + idx * 12);
  });
  return box("stsc", out);
}

function patchStco(buf, b, shift, fakeOffset, addCount) {
  const p = payload(buf, b);
  const hdr = p.subarray(0, 4);
  const count = u32(p, 4);
  const offsets = [];
  for (let i = 0, off = 8; i < count && off + 4 <= p.length; i++, off += 4) offsets.push(u32(p, off) + shift);
  for (let i = 0; i < addCount; i++) offsets.push(fakeOffset);
  const out = Buffer.alloc(8 + offsets.length * 4);
  hdr.copy(out, 0);
  out.writeUInt32BE(offsets.length, 4);
  offsets.forEach((o, idx) => out.writeUInt32BE(o >>> 0, 8 + idx * 4));
  return box("stco", out);
}

function patchCo64(buf, b, shift, fakeOffset, addCount) {
  const p = payload(buf, b);
  const hdr = p.subarray(0, 4);
  const count = u32(p, 4);
  const offsets = [];
  for (let i = 0, off = 8; i < count && off + 8 <= p.length; i++, off += 8) offsets.push(BigInt(u64(p, off) + shift));
  for (let i = 0; i < addCount; i++) offsets.push(BigInt(fakeOffset));
  const out = Buffer.alloc(8 + offsets.length * 8);
  hdr.copy(out, 0);
  out.writeUInt32BE(offsets.length, 4);
  offsets.forEach((o, idx) => out.writeBigUInt64BE(o, 8 + idx * 8));
  return box("co64", out);
}

async function runPatcher(inputPath, outputPath) {
  // Read and perform in-memory faststart remux without FFmpeg
  const rawInput = fs.readFileSync(inputPath);
  const buf = remuxFaststart(rawInput);

  const boxes = parseBoxes(buf, 0, buf.length);
  const moov = boxes.find(b => b.type === "moov");
  const mdat = boxes.find(b => b.type === "mdat");
  if (!moov || !mdat) throw new Error("moov or mdat missing");

  const traks = (moov.children || []).filter(b => b.type === "trak");
  const vTrak = traks.find(t => isVideoTrak(buf, t));
  if (!vTrak) throw new Error("Video track missing");

  const stbl = childPath(vTrak, ["mdia", "minf", "stbl"]);
  const stsz = findChild(stbl, "stsz");
  const sampleCount = u32(payload(buf, stsz), 8);

  const totalSamples = Math.floor(sampleCount * 20 / 3);
  const addCount = Math.max(0, totalSamples - sampleCount);

  let activeTrak = null;
  function walkMoov(b, shift, fakeOff) {
    if (b.type === "udta") return null;
    if (b.type === "mdhd") return patchMdhdLang(buf, b);
    if (b.type === "hdlr") return patchHdlrName(buf, b);
    
    const isVideo = activeTrak === vTrak;
    if (isVideo && b.type === "stsz") return patchStsz(buf, b, addCount);
    if (isVideo && b.type === "stts") return raw(buf, b);
    if (isVideo && b.type === "stsc" && addCount > 0) {
      const stco = findChild(stbl, "stco") || findChild(stbl, "co64");
      return patchStsc(buf, b, u32(payload(buf, stco), 4));
    }
    if (b.type === "stco") return patchStco(buf, b, shift, fakeOff, addCount);
    if (b.type === "co64") return patchCo64(buf, b, shift, fakeOff, addCount);

    if (b.children) {
      const parts = [];
      if (b.type === "meta") parts.push(payload(buf, b).subarray(0, 4));
      for (const child of b.children) {
        const prevTrak = activeTrak;
        if (child.type === "trak") activeTrak = child;
        const patched = walkMoov(child, shift, fakeOff);
        activeTrak = prevTrak;
        if (patched) parts.push(patched);
      }
      return box(b.type, Buffer.concat(parts));
    }
    return raw(buf, b);
  }

  let endPos = mdat.end;
  let newMoov = walkMoov(moov, 0, endPos);
  let diff = newMoov.length - raw(buf, moov).length;
  endPos = mdat.end + diff;
  newMoov = walkMoov(moov, diff, endPos);

  const mdatPayload = buf.subarray(mdat.start + 8, mdat.end);
  const newMdat = addCount > 0 
    ? Buffer.concat([w32(8 + mdatPayload.length + 8), Buffer.from("mdat", "latin1"), mdatPayload, FAKE_SAMPLE])
    : raw(buf, mdat);

  const outBoxes = [];
  const freeBox = Buffer.concat([w32(8), Buffer.from("free", "latin1")]);
  for (const b of boxes) {
    if (b.type === "ftyp") { outBoxes.push(raw(buf, b)); outBoxes.push(freeBox); }
    else if (b.type === "moov") outBoxes.push(newMoov);
    else if (b.type === "mdat") outBoxes.push(newMdat);
    else if (b.type === "free" || b.type === "wide") continue;
    else outBoxes.push(raw(buf, b));
  }

  fs.writeFileSync(outputPath, Buffer.concat(outBoxes));
  console.log("Successfully patched without FFmpeg:", outputPath);
}

const args = process.argv.slice(2);
if (args.length < 2) {
  console.log("Usage: node patcher.js <input_mp4> <output_mp4>");
  process.exit(1);
}

runPatcher(args[0], args[1]).catch(console.error);
