/**
 * Извлечение картинок и текста из PDF для распознавания чеков.
 * 1) JPEG/PNG по сигнатурам
 * 2) потоки /Filter /DCTDecode (сканы в PDF)
 * 3) текстовый слой (если есть)
 */
import zlib from 'node:zlib';

const MAX_IMAGES = 4;
const MIN_IMAGE_BYTES = 2500;
const MAX_IMAGE_BYTES = 5_000_000;

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IEND = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  return Buffer.from(String(input).replace(/^data:[^;]+;base64,/, ''), 'base64');
}

function isLikelyJpeg(buf) {
  return buf.length > 100 && buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
}

function extractJpegByMarkers(buf) {
  const out = [];
  let pos = 0;
  let guard = 0;
  while (guard++ < 300 && out.length < 12) {
    const i = buf.indexOf(JPEG_SOI, pos);
    if (i < 0) break;
    // ищем EOI после SOI
    let j = i + 3;
    let found = -1;
    while (j < buf.length - 1) {
      if (buf[j] === 0xff && buf[j + 1] === 0xd9) {
        found = j + 2;
        break;
      }
      j++;
      // защита от гигантских кусков
      if (j - i > MAX_IMAGE_BYTES) break;
    }
    if (found < 0) {
      pos = i + 2;
      continue;
    }
    const slice = buf.subarray(i, found);
    pos = found;
    if (slice.length >= MIN_IMAGE_BYTES && slice.length <= MAX_IMAGE_BYTES && isLikelyJpeg(slice)) {
      out.push(Buffer.from(slice));
    }
  }
  return out;
}

function extractPngByMarkers(buf) {
  const out = [];
  let pos = 0;
  let guard = 0;
  while (guard++ < 100 && out.length < 8) {
    const i = buf.indexOf(PNG_SIG, pos);
    if (i < 0) break;
    const j = buf.indexOf(PNG_IEND, i + 8);
    if (j < 0) {
      pos = i + 8;
      continue;
    }
    const end = j + PNG_IEND.length;
    const slice = buf.subarray(i, end);
    pos = end;
    if (slice.length >= MIN_IMAGE_BYTES && slice.length <= MAX_IMAGE_BYTES) {
      out.push(Buffer.from(slice));
    }
  }
  return out;
}

/**
 * Потоки PDF с /DCTDecode — внутри обычно сырой JPEG.
 */
function extractDctDecodeStreams(buf) {
  const out = [];
  const latin = buf.toString('latin1');
  // ищем словарь объекта с DCTDecode рядом со stream
  const re = /\/Filter\s*\/DCTDecode|\/Filter\s*\[\s*\/DCTDecode/gi;
  let m;
  let guard = 0;
  while ((m = re.exec(latin)) && guard++ < 40) {
    const after = latin.indexOf('stream', m.index);
    if (after < 0 || after - m.index > 800) continue;
    let dataStart = after + 6;
    // после "stream" может быть \r\n или \n
    if (latin[dataStart] === '\r') dataStart++;
    if (latin[dataStart] === '\n') dataStart++;
    const end = latin.indexOf('endstream', dataStart);
    if (end < 0) continue;
    const raw = buf.subarray(dataStart, end);
    // иногда после stream ещё байт перевода строки уже учтён
    // ищем JPEG внутри потока
    const soi = raw.indexOf(Buffer.from([0xff, 0xd8]));
    if (soi >= 0) {
      const eoi = raw.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (eoi > soi) {
        const jpeg = raw.subarray(soi, eoi + 2);
        if (jpeg.length >= MIN_IMAGE_BYTES && jpeg.length <= MAX_IMAGE_BYTES) {
          out.push(Buffer.from(jpeg));
          continue;
        }
      }
    }
    // весь поток как JPEG
    if (raw.length >= MIN_IMAGE_BYTES && raw.length <= MAX_IMAGE_BYTES && raw[0] === 0xff && raw[1] === 0xd8) {
      out.push(Buffer.from(raw));
    }
  }
  return out;
}

function uniqueBySize(buffers) {
  const seen = new Set();
  const out = [];
  for (const b of buffers) {
    const key = `${b.length}:${b[10]}:${b[20]}:${b[b.length >> 1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

/**
 * @returns {string[]} data URL картинок (крупные первыми)
 */
export function pdfToImageDataUrls(input) {
  try {
    const buf = toBuffer(input);
    if (!buf.length || buf.length > 15_000_000) return [];

    const images = uniqueBySize([
      ...extractDctDecodeStreams(buf),
      ...extractJpegByMarkers(buf),
      ...extractPngByMarkers(buf),
    ]);

    // самые крупные (обычно страница чека) — первые
    images.sort((a, b) => b.length - a.length);
    const top = images.slice(0, MAX_IMAGES);

    return top.map((b) => {
      const isPng = b[0] === 0x89 && b[1] === 0x50;
      const mime = isPng ? 'image/png' : 'image/jpeg';
      return `data:${mime};base64,${b.toString('base64')}`;
    });
  } catch (e) {
    console.warn('pdfToImageDataUrls', e.message);
    return [];
  }
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

export function extractPdfText(input) {
  try {
    const buf = toBuffer(input);
    const texts = [];
    const marker = Buffer.from('stream');
    const endMarker = Buffer.from('endstream');
    let pos = 0;
    let guard = 0;

    while (guard++ < 300 && texts.length < 400) {
      const s = buf.indexOf(marker, pos);
      if (s < 0) break;
      const e = buf.indexOf(endMarker, s);
      if (e < 0) break;
      let dataStart = s + marker.length;
      if (buf[dataStart] === 0x0d) dataStart++;
      if (buf[dataStart] === 0x0a) dataStart++;
      const raw = buf.subarray(dataStart, e);
      pos = e + endMarker.length;
      if (raw.length > 2_000_000) continue;

      let chunk = null;
      try {
        chunk = zlib.inflateSync(raw).toString('utf8');
      } catch {
        try {
          chunk = zlib.inflateRawSync(raw).toString('utf8');
        } catch {
          if (raw.length < 100_000) chunk = raw.toString('latin1');
        }
      }
      if (chunk) texts.push(...decodeTextOperators(chunk));
    }

    if (texts.length < 3) {
      const latin = buf.toString('latin1');
      const re = /[А-Яа-яA-Z0-9][А-Яа-яA-Za-z0-9\s.,₽\-]{5,80}/g;
      let m;
      while ((m = re.exec(latin)) && texts.length < 200) texts.push(m[0]);
    }

    return [...new Set(texts)].join(' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
  } catch (e) {
    console.warn('extractPdfText', e.message);
    return '';
  }
}
