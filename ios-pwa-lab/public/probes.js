import { Outcome, CACHE_PREFIX } from './core.js';
const ok = summary => ({ status: 'success', summary });
const pending = summary => ({ status: 'untested', summary: `${summary}；請人工確認可見／可聽效果` });
const condition = message => { throw new Outcome('condition', message); };
const delay = (fn, ms, resources) => { const id = setTimeout(fn, ms); resources.add(() => clearTimeout(id)); return id; };
export function download(text, name, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
export function createProbes(ctx) {
  const { resources: r, show, element, text, finish, store } = ctx;
  let stream, recorder, cameraVideo;
  const release = value => value.getTracks().forEach(track => track.stop());
  async function media(video) {
    r.stop();
    stream = await r.acquire(navigator.mediaDevices.getUserMedia(video ? { video: { facingMode: { ideal: video } }, audio: false } : { audio: true }), release);
    r.add(() => { stream = null; cameraVideo = null; });
    if (video) {
      cameraVideo = element('video'); cameraVideo.autoplay = true; cameraVideo.muted = true; cameraVideo.playsInline = true;
      cameraVideo.srcObject = stream;
      r.add(() => { cameraVideo?.pause(); if(cameraVideo) cameraVideo.srcObject = null; });
      await cameraVideo.play();
      const track = stream.getVideoTracks()[0]; const caps = track.getCapabilities?.() || {};
      show({ settings: track.getSettings(), capabilities: caps });
      if (caps.zoom) {
        const input = element('input'); input.type='range'; input.min=caps.zoom.min; input.max=caps.zoom.max; input.step=caps.zoom.step||.1; input.value=track.getSettings().zoom||caps.zoom.min; input.setAttribute('aria-label','鏡頭縮放');
        input.onchange = async () => { try { await track.applyConstraints({ advanced:[{zoom:Number(input.value)}] }); show('縮放已套用'); } catch(e) { show(e.message); } };
      }
      if (caps.torch) {
        const b=element('button','切換補光'); let torch=false;
        b.onclick=async()=>{ try { await track.applyConstraints({advanced:[{torch:!torch}]}); torch=!torch; show('補光設定已套用，請確認效果'); } catch(e){show(e.message);} };
      }
      return ok('相機串流與預覽已啟動；解析度與能力見即時畫面');
    }
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (Audio) {
      const audio = new Audio(); r.add(() => audio.close());
      await audio.resume(); const analyser=audio.createAnalyser(); audio.createMediaStreamSource(stream).connect(analyser);
      const meter=element('meter'); meter.min=0; meter.max=1; meter.setAttribute('aria-label','麥克風音量');
      const samples=new Uint8Array(analyser.fftSize);
      const timer=setInterval(()=>{analyser.getByteTimeDomainData(samples);meter.value=Math.sqrt(samples.reduce((sum,v)=>sum+((v-128)/128)**2,0)/samples.length);},100);
      r.add(()=>clearInterval(timer));
    }
    return ok('麥克風串流已取得；請觀察音量與錄音回放');
  }
  function recording(id) {
    if (!stream || (id==='video' && !stream.getVideoTracks().length) || (id==='record' && !stream.getAudioTracks().length)) condition(id==='video'?'請先啟動相機':'請先啟動麥克風');
    if (recorder?.state==='recording') condition('已有錄製進行中');
    const generation=r.generation;
    recorder=new MediaRecorder(stream); const chunks=[]; let timed;
    recorder.ondataavailable=e=>{if(e.data.size) chunks.push(e.data);};
    recorder.onerror=e=>{void finish(id,{status:'failed',summary:e.error?.message||'錄製失敗'});};
    recorder.onstop=()=>{
      clearTimeout(timed);
      if (r.generation!==generation) return;
      const blob=new Blob(chunks,{type:recorder.mimeType});
      const url=URL.createObjectURL(blob);r.add(()=>URL.revokeObjectURL(url));
      const player=element(id==='video'?'video':'audio');player.controls=true;player.src=url;player.playsInline=true;
      void finish(id, pending(`錄製完成，${blob.size} bytes，回放待確認`));
    };
    recorder.start();
    const stop=()=>{if(recorder?.state==='recording') recorder.stop();};
    element('button','停止錄製並回放').onclick=stop;
    r.add(()=>{recorder.onstop=null;stop();});timed=delay(stop,10000,r);
    return {status:'untested',summary:'錄製中；最長 10 秒，尚未確認結果'};
  }
  function position(id, watch) {
    const generation=r.generation;
    const success=p=>{
      if(generation!==r.generation) return;
      show({latitude:p.coords.latitude,longitude:p.coords.longitude,accuracy:p.coords.accuracy,time:new Date(p.timestamp).toISOString()});
      void finish(id,ok(`定位成功；精度 ${p.coords.accuracy} 公尺，時間 ${new Date(p.timestamp).toISOString()}；座標不保存`));
    };
    const error=e=>{if(generation===r.generation) void finish(id,{status:'condition',summary:`定位 ${['','拒絕授權','無法取得位置','逾時'][e.code]||'失敗'}（${e.code}）`});};
    const options={enableHighAccuracy:true,timeout:10000,maximumAge:0};
    if(watch) { const key=navigator.geolocation.watchPosition(success,error,options);r.add(()=>navigator.geolocation.clearWatch(key)); }
    else navigator.geolocation.getCurrentPosition(success,error,options);
    return {status:'untested',summary:watch?'等待前景定位；請停止追蹤或切換分類以釋放':'等待單次定位，最長 10 秒'};
  }
  async function sensor(id) {
    r.stop();const EventType=id==='motion'?DeviceMotionEvent:DeviceOrientationEvent;
    const generation=r.generation;
    if(EventType.requestPermission && await EventType.requestPermission()!=='granted') condition('感測器授權未允許');
    if(generation!==r.generation)throw new Outcome('cancelled','感測器操作已停止');
    let recorded=false;
    const listener=e=>{
      if(generation!==r.generation) return;
      const data=id==='motion'?{acceleration:e.acceleration,gravity:e.accelerationIncludingGravity,rotation:e.rotationRate}:{alpha:e.alpha,beta:e.beta,gamma:e.gamma,heading:e.webkitCompassHeading};
      const valid=id==='motion'?[e.acceleration?.x,e.accelerationIncludingGravity?.x,e.rotationRate?.alpha].some(v=>v!=null):[e.alpha,e.beta,e.gamma].some(v=>v!=null);
      if(!valid) return;
      show(data,true);if(!recorded){recorded=true;void finish(id,ok('已收到有效感測資料；持續觀察至停止'));}
    };
    const name=id==='motion'?'devicemotion':'deviceorientation';addEventListener(name,listener);r.add(()=>removeEventListener(name,listener));
    delay(()=>{if(!recorded) void finish(id,{status:'condition',summary:'10 秒內沒有有效感測資料，請檢查硬體／授權／模式'});},10000,r);
    return {status:'untested',summary:'等待有效感測資料'};
  }
  async function rtc() {
    const a=new RTCPeerConnection({iceServers:[]}),b=new RTCPeerConnection({iceServers:[]});r.add(()=>{a.close();b.close();});
    const queues=[[],[]]; let iceError;
    async function candidate(target,index,e){if(!e.candidate)return;if(!target.remoteDescription){queues[index].push(e.candidate);return;}try{await target.addIceCandidate(e.candidate);}catch(error){iceError=error;}}
    a.onicecandidate=e=>{void candidate(b,1,e);};b.onicecandidate=e=>{void candidate(a,0,e);};
    const channel=a.createDataChannel('lab');
    let cancel;
    const receive=new Promise((resolve,reject)=>{
      cancel=()=>reject(new Outcome('cancelled','WebRTC 測試已停止'));r.add(cancel);
      delay(()=>reject(new Outcome('condition','WebRTC 本機迴路 10 秒逾時')),10000,r);
      b.ondatachannel=e=>{e.channel.onmessage=message=>message.data==='lab-ping'?resolve():reject(new Error('資料不一致'));};
      channel.onopen=()=>channel.send('lab-ping');channel.onerror=()=>reject(new Error('DataChannel 失敗'));
    });
    // Attach early so a timeout during signalling does not become an unhandled rejection.
    receive.catch(()=>{});
    await a.setLocalDescription(await a.createOffer());await b.setRemoteDescription(a.localDescription);
    for(const c of queues[1])await b.addIceCandidate(c);
    await b.setLocalDescription(await b.createAnswer());await a.setRemoteDescription(b.localDescription);
    for(const c of queues[0])await a.addIceCandidate(c);
    await receive;if(iceError)throw iceError;r.stop();return ok('本機 WebRTC DataChannel 往返成功');
  }
  async function idbProbe(){
    const db=await new Promise((resolve,reject)=>{const q=indexedDB.open('ios-pwa-lab-probe',1);q.onupgradeneeded=()=>q.result.createObjectStore('probe');q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    try {
      const transaction=(method,value)=>new Promise((resolve,reject)=>{const tx=db.transaction('probe',method==='get'?'readonly':'readwrite');const req=tx.objectStore('probe')[method](...(method==='get'?['value']:[value,'value']));tx.oncomplete=()=>resolve(req.result);tx.onerror=()=>reject(tx.error);});
      const previous=await transaction('get');const value=new Date().toISOString();await transaction('put',value);
      if(await transaction('get')!==value)throw new Error('IndexedDB 讀回不一致');return ok(`IndexedDB 寫入／讀回一致；先前值 ${previous||'無'}`);
    }finally{db.close();}
  }
  return {
    environment:()=>{const data={secure:isSecureContext,protocol:location.protocol,mode:ctx.environment.mode,userAgent:navigator.userAgent,language:navigator.language,screen:[screen.width,screen.height],viewport:[innerWidth,innerHeight],pixelRatio:devicePixelRatio,dark:matchMedia('(prefers-color-scheme: dark)').matches,orientation:screen.orientation?.type,safeArea:getComputedStyle(document.querySelector('main')).padding};show(data);return ok(JSON.stringify(data));},
    touch:()=>{r.stop();const pad=element('div','在此點擊、雙指觸控與拖曳');pad.className='touchpad';const active=new Set();const generation=r.generation;let recorded=false;const track=e=>{e.preventDefault();if(e.type==='pointerdown'){active.add(e.pointerId);pad.setPointerCapture(e.pointerId);}if(['pointerup','pointercancel'].includes(e.type))active.delete(e.pointerId);pad.textContent=`${e.type} · ${active.size} 點 · ${Math.round(e.offsetX)}, ${Math.round(e.offsetY)}`;if(!recorded&&e.type==='pointerdown'){recorded=true;void finish('touch',ok(`收到 ${e.pointerType} Pointer Event；多點與拖曳請人工確認`));}};for(const event of ['pointerdown','pointermove','pointerup','pointercancel']){pad.addEventListener(event,track);r.add(()=>pad.removeEventListener(event,track));}return {status:'untested',summary:`觸控區已開啟，等待觸控（${generation}）`};},
    keyboard:()=>pending(`鍵盤欄位可用；視窗 ${innerWidth}×${innerHeight}，請旋轉並確認`),
    'camera-front':()=>media('user'), 'camera-back':()=>media('environment'),
    photo:()=>{if(!cameraVideo||!cameraVideo.videoWidth)condition('請先啟動相機並等待預覽');const canvas=element('canvas');canvas.width=cameraVideo.videoWidth;canvas.height=cameraVideo.videoHeight;canvas.getContext('2d').drawImage(cameraVideo,0,0);return ok(`拍照 ${canvas.width}×${canvas.height}；只留在畫面`);},
    video:()=>recording('video'),microphone:()=>media(false),record:()=>recording('record'),
    files:()=>{const input=document.querySelector('[data-files]');if(!input.files.length)condition('請先選擇檔案');for(const file of input.files){show({type:file.type,size:file.size});if(/^(image|video|audio)\//.test(file.type)){const url=URL.createObjectURL(file);r.add(()=>URL.revokeObjectURL(url));const view=element(file.type.startsWith('image')?'img':file.type.startsWith('video')?'video':'audio');view.src=url;view.controls=true;if(view.tagName==='IMG')view.alt='選取檔案預覽';}}return ok(`使用者選取 ${input.files.length} 個檔案；不保存媒體或檔名`);},
    download:()=>{download('iOS PWA Lab download test\n','ios-pwa-lab-test.txt');return pending('已觸發測試檔下載');},
    audio:async()=>{const Audio=globalThis.AudioContext||globalThis.webkitAudioContext;const audio=new Audio();r.add(()=>audio.close());await audio.resume();const osc=audio.createOscillator(),gain=audio.createGain();gain.gain.value=.08;osc.connect(gain).connect(audio.destination);osc.start();osc.stop(audio.currentTime+.4);return pending('Web Audio 短音已排程');},
    speech:()=>{const utterance=new SpeechSynthesisUtterance(text());utterance.lang='zh-TW';speechSynthesis.speak(utterance);r.add(()=>speechSynthesis.cancel());return pending(`朗讀已排程；語言 ${utterance.lang}，連線 ${navigator.onLine}`);},
    recognition:()=>{r.stop();const Recognition=globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition;const rec=new Recognition();rec.lang='zh-TW';const generation=r.generation;rec.onresult=e=>{if(generation!==r.generation)return;show(e.results[0][0].transcript);void finish('recognition',ok(`收到語音辨識結果；語言 zh-TW，連線 ${navigator.onLine}；逐字稿不保存`));};rec.onerror=e=>{if(generation===r.generation)void finish('recognition',{status:e.error==='aborted'?'cancelled':'condition',summary:`語音辨識 ${e.error}`});};r.add(()=>{rec.onresult=null;rec.onerror=null;rec.abort();});rec.start();delay(()=>{rec.stop();},15000,r);return {status:'untested',summary:'等待辨識，最長 15 秒；可能依賴平台服務'};},
    location:()=>position('location',false),'watch-location':()=>position('watch-location',true),
    motion:()=>sensor('motion'),orientation:()=>sensor('orientation'),
    share:async()=>{await navigator.share({title:'iOS PWA Lab',text:'PWA 能力分享測試',url:location.href});return pending('share promise 已完成');},
    'share-file':async()=>{const data={files:[new File(['PWA file share test'],'pwa-test.txt',{type:'text/plain'})]};if(!navigator.canShare?.(data))condition('此環境無法分享測試檔案');await navigator.share(data);return pending('檔案分享 promise 已完成');},
    copy:async()=>{await navigator.clipboard.writeText(text());return ok('剪貼簿文字寫入呼叫成功；未保存內容');},
    paste:async()=>{show(await navigator.clipboard.readText());return ok('剪貼簿文字讀取呼叫成功；內容只在畫面');},
    'clipboard-image':async()=>{if(!navigator.clipboard?.write)throw new Outcome('unsupported','未提供 clipboard.write');const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;canvas.getContext('2d').fillRect(0,0,16,16);const blob=new Promise(resolve=>canvas.toBlob(resolve,'image/png'));await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);return pending('PNG 圖片剪貼簿寫入成功');},
    wake:async()=>{await r.acquire(navigator.wakeLock.request('screen'),lock=>lock.release());return ok('取得 Wake Lock；停止或離開前景時釋放');},
    fullscreen:async()=>{await r.acquire(document.documentElement.requestFullscreen(),()=>document.fullscreenElement?document.exitFullscreen():undefined);return pending('全螢幕請求完成');},
    'orientation-lock':async()=>{await r.acquire(screen.orientation.lock('portrait'),()=>screen.orientation.unlock());return pending('方向鎖定請求完成');},
    'local-storage':()=>{const key='ios-pwa-lab:probe';const previous=localStorage.getItem(key);const value=new Date().toISOString();localStorage.setItem(key,value);if(localStorage.getItem(key)!==value)throw new Error('讀回不一致');return ok(`localStorage 寫入／讀回一致；先前值 ${previous||'無'}`);},
    indexeddb:idbProbe,
    cache:async()=>{const cache=await caches.open(`${CACHE_PREFIX}probe`);const key=new URL('./probe-cache',location.href);await cache.put(key,new Response('lab-cache-value'));if(await (await cache.match(key)).text()!=='lab-cache-value')throw new Error('快取讀回不一致');return ok('Cache Storage 寫入／讀回一致');},
    'storage-estimate':async()=>{const estimate=await navigator.storage.estimate();show(estimate);return ok(`估計使用 ${estimate.usage} / 配額 ${estimate.quota} bytes`);},
    persist:async()=>{const granted=await navigator.storage.persist();return granted?ok('持久儲存請求獲准；仍需匯出備份'):{status:'condition',summary:'持久儲存請求未獲准'};},
    offline:async()=>{const cache=await caches.open(`${CACHE_PREFIX}shell-${ctx.version}`);const keys=await cache.keys();const names=['index.html','styles.css','app.js','core.js','catalog.js','storage.js','probes.js','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','worker.js'];const missing=names.filter(name=>!keys.some(key=>key.url===new URL(name,location.href).href));if(missing.length)condition(`快取尚未完整：${missing.join(', ')}`);return ok(`shell-${ctx.version} 快取完整；連線 ${navigator.onLine}；飛航重啟仍待實機`);},
    install:()=>pending(`目前 ${ctx.environment.mode}；請完成主畫面安裝與飛航重啟`),
    fetch:async()=>{const controller=new AbortController();r.add(()=>controller.abort());const start=performance.now();const response=await fetch('./network-test.json',{cache:'no-store',signal:controller.signal});if(!response.ok)throw new Error(`HTTP ${response.status}`);if((await response.json()).probe!=='ios-pwa-lab')throw new Error('同站測試檔內容不符');return ok(`同站網路請求完成 ${(performance.now()-start).toFixed(1)} ms`);},
    'abort-fetch':async()=>{const controller=new AbortController();controller.abort();await fetch('./network-test.json',{signal:controller.signal,cache:'no-store'});throw new Error('取消後竟然完成');},
    webrtc:rtc,
    canvas:()=>{const canvas=element('canvas');canvas.width=160;canvas.height=80;const context=canvas.getContext('2d');if(!context)throw new Outcome('unsupported','2D context 不可用');context.fillStyle='#00ff00';context.fillRect(0,0,160,80);const pixel=context.getImageData(1,1,1,1).data;if(pixel[1]!==255)throw new Error('Canvas 像素不符');return ok('Canvas 繪圖像素讀回正確');},
    webgl:()=>{const canvas=element('canvas');canvas.width=160;canvas.height=80;const gl=canvas.getContext('webgl');if(!gl)throw new Outcome('unsupported','WebGL context 不可用');r.add(()=>gl.getExtension('WEBGL_lose_context')?.loseContext());gl.clearColor(0,1,0,1);gl.clear(gl.COLOR_BUFFER_BIT);const pixel=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);if(pixel[1]!==255)throw new Error('WebGL 像素不符');return ok('WebGL 繪圖像素讀回正確');},
    webgpu:async()=>{const generation=r.generation;const adapter=await navigator.gpu.requestAdapter();if(generation!==r.generation)throw new Outcome('cancelled','WebGPU 操作已停止');if(!adapter)condition('沒有可用的 GPU adapter');const device=await r.acquire(adapter.requestDevice(),value=>value.destroy());const canvas=element('canvas');canvas.width=160;canvas.height=80;const context=canvas.getContext('webgpu');if(!context)condition('WebGPU context 不可用');context.configure({device,format:navigator.gpu.getPreferredCanvasFormat()});r.add(()=>context.unconfigure());const encoder=device.createCommandEncoder();const pass=encoder.beginRenderPass({colorAttachments:[{view:context.getCurrentTexture().createView(),clearValue:{r:0,g:1,b:0,a:1},loadOp:'clear',storeOp:'store'}]});pass.end();device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();return pending('WebGPU 清除畫面指令完成');},
    wasm:async()=>{const bytes=new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,7,1,3,114,117,110,0,0,10,6,1,4,0,65,42,11]);const {instance}=await WebAssembly.instantiate(bytes);if(instance.exports.run()!==42)throw new Error('WASM 值不符');return ok('WebAssembly 回傳 42');},
    worker:()=>new Promise((resolve,reject)=>{const worker=new Worker('./worker.js');r.add(()=>{worker.terminate();reject(new Outcome('cancelled','Worker 已停止'));});delay(()=>reject(new Error('Worker 逾時')),5000,r);worker.onmessage=e=>{worker.terminate();e.data===5050?resolve(ok('Worker 計算 1…100 = 5050')):reject(new Error('Worker 值不符'));};worker.onerror=()=>reject(new Error('Worker 執行失敗'));worker.postMessage(100);}),
    crypto:async()=>{const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('abc'));const hex=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');if(hex!=='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')throw new Error('雜湊不符');return ok('SHA-256 已知測試值正確');},
    lifecycle:()=>{show(ctx.lifecycle());return pending('生命週期事件見即時畫面，切換 App／鎖屏後再次查看');},
    notification:async()=>{const permission=await Notification.requestPermission();return permission==='granted'?ok('通知權限 granted；未發送或接收推播'):{status:'condition',summary:`通知權限 ${permission}；未收到遠端推播`};},
    badge:async()=>{await navigator.setAppBadge(1);return pending('徽章設定呼叫完成');},
    'clear-badge':async()=>{await navigator.clearAppBadge();return pending('徽章清除呼叫完成');},
    system:()=>pending('請自行填寫目標並開啟系統入口'),
    bluetooth:async()=>{await navigator.bluetooth.requestDevice({acceptAllDevices:true});return ok('Bluetooth 裝置已選擇；未連線');},
    usb:async()=>{await navigator.usb.requestDevice({filters:[]});return ok('USB 裝置已選擇；未開啟');},
    serial:async()=>{await navigator.serial.requestPort();return ok('Serial 埠已選擇；未開啟');},
    hid:async()=>{const devices=await navigator.hid.requestDevice({filters:[]});if(!devices.length)throw new Outcome('cancelled','未選擇 HID 裝置');return ok(`選擇 ${devices.length} 個 HID 裝置；未開啟`);},
    contacts:async()=>{const contacts=await navigator.contacts.select(['name'],{multiple:true});return contacts.length?ok(`選擇 ${contacts.length} 筆聯絡人；不保存資料`):{status:'cancelled',summary:'未選擇聯絡人'};},
    nfc:async()=>{r.stop();const reader=new NDEFReader();const controller=new AbortController();r.add(()=>controller.abort());await reader.scan({signal:controller.signal});reader.onreading=e=>{void finish('nfc',ok(`收到 ${e.message.records.length} 個 NDEF record；內容不保存`));};r.add(()=>{reader.onreading=null;});delay(()=>{controller.abort();void finish('nfc',{status:'condition',summary:'NFC 讀取已結束，請確認標籤／硬體條件'});},15000,r);return {status:'untested',summary:'等待 NFC 標籤；最長 15 秒'};},
    battery:async()=>{const value=await navigator.getBattery();return ok(`電量 ${Math.round(value.level*100)}%，充電 ${value.charging}`);},
    connection:()=>ok(JSON.stringify({type:navigator.connection.effectiveType,downlink:navigator.connection.downlink,rtt:navigator.connection.rtt,saveData:navigator.connection.saveData})),
    xr:async()=>{const available=await navigator.xr.isSessionSupported('immersive-ar');return {status:available?'untested':'condition',summary:`immersive-ar 條件 ${available}；未啟動 AR session`,evidence:'API 偵測'};},
    passkey:async()=>({status:'backend',summary:`平台驗證器可用 ${await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()}；完整註冊／認證待後端`,evidence:'API 偵測'}),
  };
}
