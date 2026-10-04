import { mkdir, cp, readdir, realpath, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const project=await realpath(fileURLToPath(new URL('..',import.meta.url)));
const source=path.join(project,'public'),destination=path.join(project,'site-dist');
async function validate(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const candidate=path.join(directory,entry.name);if((await lstat(candidate)).isSymbolicLink())throw new Error('拒絕封裝符號連結');const actual=await realpath(candidate);if(!actual.startsWith(project+path.sep))throw new Error('路徑超出專案');if(entry.isDirectory())await validate(candidate);}}
await validate(source);
// An existing output could contain stale or private files; refuse to reuse it.
await mkdir(destination);
await cp(source,path.join(destination,'ios-pwa-lab'),{recursive:true});
console.log('Packaged public assets only: site-dist/ios-pwa-lab/');
