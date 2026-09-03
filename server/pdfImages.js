/**
 * Достаём встроенные JPEG/PNG из PDF (сканы чеков).
 * Без native-библиотек — ищем потоки DCTDecode / PNG signature.
 */

function extractJpegFromPdf(buf) {
  const images = [];
  const len = buf.length;
  // JPEG SOI ... EOI
  for (let i = 0; i < len - 2; i++) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8) {
      // look for EOI
      for (let j = i + 2; j < len - 1; j++) {
        if (buf[j] === 0xff && buf[j + 1] === 0xd9) {
          const slice = buf.subarray(i, j + 2);
          if (slice.length > 5000 && slice.length < 8_000_000) {
            images.push(Buffer.from(slice));
          }
          i = j;
          break;
        }
      }
    }
  }
  return images;
}

function extractPngFromPdf(buf) {
  const images = [];
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let start = 0;
  while (true) {
    const idx = buf.indexOf(sig, start);
    if (idx < 0) break;
    // find IEND
    const iend = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    const end = buf.indexOf(iend, idx);
    if (end > idx) {
      const slice = buf.subarray(idx, end + 8);
      if (slice.length > 5000) images.push(Buffer.from(slice));
      start = end + 8;
    } else {
      start = idx + 8;
    }
  }
  return images;
}

/** @returns {string[]} data URLs image/* */
export function pdfToImageDataUrls(pdfBase64OrBuf) {
  let buf;
  if (Buffer.isBuffer(pdfBase64OrBuf)) buf = pdfBase64OrBuf;
  else {
    const b64 = String(pdfBase64OrBuf).replace(/^data:[^;]+;base64,/, '');
    buf = Buffer.from(b64, 'base64');
  }

  const jpgs = extractJpegFromPdf(buf);
  const pngs = extractPngFromPdf(buf);
  const out = [];
  for (const j of jpgs) out.push(`data:image/jpeg;base64,${j.toString('base64')}`);
  for (const p of pngs) out.push(`data:image/png;base64,${p.toString('base64')}`);
  // largest first (usually full page scan)
  out.sort((a, b) => b.length - a.length);
  return out.slice(0, 3);
}

export function extractPdfText(buf) {
  const asLatin = buf.toString('latin1');
  const texts = [];
  let m;
  const re1 = /\(([^\\()]{2,120})\)\s*Tj/g;
  while ((m = re1.exec(asLatin)) && texts.length < 150) texts.push(m[1]);
  const re3 = /[А-Яа-яA-Z0-9][А-Яа-яA-Za-z0-9\s.,₽\-]{4,60}/g;
  while ((m = re3.exec(asLatin)) && texts.length < 250) texts.push(m[0]);
  return [...new Set(texts)].join(' ').replace(/\s+/g, ' ').trim();
}
