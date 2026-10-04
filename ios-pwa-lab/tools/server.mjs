import http from 'node:http';
import { realpath, readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'};
export async function createServer() {
  const root=await realpath(fileURLToPath(new URL('../public',import.meta.url)));
  return http.createServer(async(request,response)=>{
    try{
      if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
      const url=new URL(request.url,'http://localhost');
      const pathname=decodeURIComponent(url.pathname);
      // Preview both a repository subpath and a root deployment without directory listing.
      const relative=pathname.startsWith('/ios-pwa-lab/')?pathname.slice('/ios-pwa-lab/'.length):pathname.slice(1);
      const candidate=path.resolve(root,relative||'index.html');
      if(!candidate.startsWith(root+path.sep)){response.writeHead(403);response.end();return;}
      const actual=await realpath(candidate);
      if(!actual.startsWith(root+path.sep)){response.writeHead(403);response.end();return;}
      if(!(await stat(actual)).isFile()){response.writeHead(404);response.end();return;}
      response.writeHead(200,{'Content-Type':TYPES[path.extname(actual)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      response.end(request.method==='HEAD'?undefined:await readFile(actual));
    }catch{response.writeHead(404);response.end('Not found');}
  });
}
if(import.meta.url===pathToFileURL(process.argv[1]).href){const server=await createServer();server.listen(Number(process.env.PORT||4173),'127.0.0.1',()=>console.log(`iOS PWA Lab preview: http://127.0.0.1:${server.address().port}/ios-pwa-lab/`));}
