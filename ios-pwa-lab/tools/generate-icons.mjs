// Code-generated geometric PWA icon; no external image assets or dependencies.
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const directory=fileURLToPath(new URL('../public/icons/',import.meta.url));
await mkdir(directory,{recursive:true});if((await lstat(directory)).isSymbolicLink())throw new Error('拒絕符號連結');
function crc(buffer){let value=0xffffffff;for(const byte of buffer){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([name,data])));return Buffer.concat([size,name,data,sum]);}
for(const size of [192,512]){
  const bytes=Buffer.alloc((size*4+1)*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const px=x/size,py=y/size;
    const frame=px>.24&&px<.76&&py>.24&&py<.76&&(px<.30||px>.70||py<.30||py>.70);
    const slash=px>.37&&px<.63&&Math.abs(py-(.85-.7*px))<.035;
    const color=frame||slash?[199,239,119,255]:[19,61,56,255];
    const offset=y*(size*4+1)+1+x*4;color.forEach((v,i)=>bytes[offset+i]=v);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  await writeFile(new URL(`../public/icons/icon-${size}.png`,import.meta.url),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(bytes)),chunk('IEND',Buffer.alloc(0))]),{flag:'wx'});
}
