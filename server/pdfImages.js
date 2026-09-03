import zlib from 'node:zlib';

const MAX_IMAGES = 3;
const MIN_IMAGE_BYTES = 20_000;
const MAX_IMAGE_BYTES = 6_000_000;

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function extractByMarkers(buf, sig, end, endLen) {
  const out = [];
  let start = 0;
  let guard = 0;
  while (out.length < MAX_IMAGES && guard++ < 200) {
    const i = buf.indexOf(sig, start);
    if (i < 0) break;
    const j = buf.indexOf(end, i + sig.length);
    if (j < 0) break;
    const slice = buf.subarray(i, j + endLen);
    start = j + endLen;
    if (slice.length >= MIN_IMAGE_BYTES && slice.length <= MAX_IMAGE_BYTES) out.push(Buffer.from(slice));
  }
  return out;
}

/** @returns {string[]} data URL картинок, найденных внутри PDF (крупные — первыми) */
export function pdfToImageDataUrls(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(String(input).replace(/^data:[^;]+;base64,/, ''), 'base64');

  const jpgs = extractByMarkers(buf, JPEG_SOI, JPEG_EOI, 2).map(
    (b) => `data:image/jpeg;base64,${b.toString('base64')}`
  );
  const pngs = extractByMarkers(buf, PNG_SIG, PNG_IEND, 8).map(
    (b) => `data:image/png;base64,${b.toString('base64')}`
  );

  return [...jpgs, ...pngs].sort((a, b) => b.length - a.length).slice(0, MAX_IMAGES);
}

function decodeTextOperators(chunk) {
  const parts = [];
  const re = /\((?:\\.|[^\\()])*\)/g;
  let m;
  while ((m = re.exec(chunk)) && parts.length < 400) {
    const s = m[0]
      .slice(1, -1)
      .replace(/\\([nrtbf()\\])/g, ' ')
      .replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(Number.parseInt(o, 8)));
    if (s.trim().length >= 2) parts.push(s);
  }
  return parts;
}

/** Текстовый слой PDF: распаковываем FlateDecode-потоки и достаём строки */
export function extractPdfText(input) {
  const buf = Buffer.isBuffer(input)
    ? input
    : Buffer.from(String(input).replace(/^data:[^;]+;base64,/, ''), 'base64');

  const texts = [];
  const marker = Buffer.from('stream');
  const endMarker = Buffer.from('endstream');
  let pos = 0;
  let guard = 0;

  while (guard++ < 500 && texts.length < 400) {
    const s = buf.indexOf(marker, pos);
    if (s < 0) break;
    const e = buf.indexOf(endMarker, s);
    if (e < 0) break;
    let dataStart = s + marker.length;
    if (buf[dataStart] === 0x0d) dataStart++;
    if (buf[dataStart] === 0x0a) dataStart++;
    const raw = buf.subarray(dataStart, e);
    pos = e + endMarker.length;

    let chunk = null;
    try {
      chunk = zlib.inflateSync(raw).toString('utf8');
    } catch {
      try {
        chunk = zlib.inflateRawSync(raw).toString('utf8');
      } catch {
        chunk = raw.length < 200_000 ? raw.toString('latin1') : null;
      }
    }
    if (chunk) texts.push(...decodeTextOperators(chunk));
  }

  return [...new Set(texts)].join(' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
}
