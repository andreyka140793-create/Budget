/**
 * Conservative PDF helpers. They intentionally cap scanning work to avoid CPU/memory DoS.
 * Vision extraction is best-effort; text extraction is only a fallback.
 */
export function pdfToImageDataUrls(buf,{maxImages=3,maxBytes=7_000_000}={}){
  if(!Buffer.isBuffer(buf)||buf.length>maxBytes)return [];
  const out=[];let i=0;
  while(i<buf.length-1&&out.length<maxImages){
    if(buf[i]===0xff&&buf[i+1]===0xd8){
      const start=i;let end=-1;
      for(let j=i+2;j<buf.length-1;j++){if(buf[j]===0xff&&buf[j+1]===0xd9){end=j+2;break;}}
      if(end>start&&end-start<=5_000_000){out.push(`data:image/jpeg;base64,${buf.subarray(start,end).toString('base64')}`);i=end;continue;}
    }
    i++;
  }
  return out;
}
export function extractPdfText(buf,{maxChars=12000}={}){
  if(!Buffer.isBuffer(buf)||buf.length>7_500_000)return '';
  const raw=buf.toString('latin1');
  const strings=[];const re=/\(([^()\\]{1,500})\)/g;let m;
  while((m=re.exec(raw))!==null&&strings.join(' ').length<maxChars)strings.push(m[1]);
  return strings.join(' ').replace(/\\[nrt]/g,' ').replace(/\s+/g,' ').slice(0,maxChars);
}
