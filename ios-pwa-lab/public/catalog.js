// Detection never asks permission. Only Run handlers may open system prompts.
const api = path => () => path.split('.').reduce((value, key) => value?.[key], globalThis) != null;
const item = (id, title, note, detect = () => true, control = '', fixed = '') => ({ id, title, note, detect, control, fixed });
export const CATEGORIES = [
  { id:'environment', title:'環境與顯示', note:'讀取瀏覽器公開的環境；機型與完整 iOS 版本請手動填寫。', tests:[
    item('environment','環境快照','HTTPS、顯示模式、語言、像素比例、視窗與安全區域。'),
  ]},
  { id:'input', title:'觸控與輸入', note:'在操作區測試單點、多點與拖曳；鍵盤、旋轉後的顯示效果需自行確認。', tests:[
    item('touch','觸控與 Pointer Events','顯示觸點數、座標及拖曳事件。',api('PointerEvent')),
    item('keyboard','文字／數字鍵盤','聚焦欄位，旋轉手機並確認是否遮擋。',()=>true,'keyboard'),
  ]},
  { id:'camera', title:'相機', note:'所有媒體只在記憶體預覽。停止、切換分類或離開前景時釋放相機。', tests:[
    item('camera-front','前鏡頭預覽與能力','公開的解析度、縮放與補光能力不代表可用。',api('navigator.mediaDevices.getUserMedia')),
    item('camera-back','後鏡頭預覽與能力','可選擇縮放與補光；不支援時保留說明。',api('navigator.mediaDevices.getUserMedia')),
    item('photo','拍照','先啟動相機，影像只在畫面顯示。',api('navigator.mediaDevices.getUserMedia')),
    item('video','短片錄製','先啟動相機，最長 10 秒，可手動停止。',api('MediaRecorder')),
  ]},
  { id:'microphone', title:'麥克風', note:'由按鈕取得授權；錄音不自動下載或保存。', tests:[
    item('microphone','麥克風與音量','開始音量分析並顯示輸入。',api('navigator.mediaDevices.getUserMedia')),
    item('record','短時間錄音','最長 10 秒，停止後可回放。',api('MediaRecorder')),
  ]},
  { id:'files', title:'相簿與檔案', note:'只能讀取使用者選取的檔案，不能瀏覽完整相簿。', tests:[
    item('files','選取照片、影片或檔案','顯示大小、類型與本次預覽；不保存檔名或媒體。',()=>true,'files'),
    item('download','下載測試檔','下載文字檔；檔案是否存入 Files 需人工確認。'),
  ]},
  { id:'audio', title:'聲音與語音', note:'聲音是否可聽、辨識品質及飛航模式行為需實機確認。', tests:[
    item('audio','Web Audio 播放','播放短音；執行呼叫後人工確認。',()=>!!(globalThis.AudioContext||globalThis.webkitAudioContext)),
    item('speech','文字朗讀','使用系統語音朗讀測試文字。',api('speechSynthesis'),'text'),
    item('recognition','語音辨識','可能需要平台線上服務；最長 15 秒。',()=>!!(globalThis.SpeechRecognition||globalThis.webkitSpeechRecognition)),
  ]},
  { id:'location', title:'定位', note:'座標只在即時畫面顯示，紀錄只保存精度、時間與結果。', tests:[
    item('location','單次定位','拒絕、不可用與 10 秒逾時分別記錄。',api('navigator.geolocation')),
    item('watch-location','前景連續定位','停止或離開前景時 clearWatch。',api('navigator.geolocation')),
  ]},
  { id:'motion', title:'動作與方向', note:'iOS 可能要求使用者操作以授權；未收到有效資料不判定成功。', tests:[
    item('motion','加速度與旋轉速率','請輕輕移動手機；10 秒內無資料標示缺少條件。',api('DeviceMotionEvent')),
    item('orientation','裝置方向與方位','僅在瀏覽器有提供時顯示方位資訊。',api('DeviceOrientationEvent')),
  ]},
  { id:'sharing', title:'分享與剪貼簿', note:'由按鈕直接呼叫，分享視窗是否完成需人工確認。', tests:[
    item('share','文字／網址分享','分享目前頁面網址與測試文字。',api('navigator.share')),
    item('share-file','檔案分享','使用無個資的測試文字檔。',api('navigator.share')),
    item('copy','複製文字','剪貼簿寫入測試文字。',api('navigator.clipboard.writeText'),'text'),
    item('paste','貼上文字','讀取文字只顯示在畫面，不寫入報告。',api('navigator.clipboard.readText')),
    item('clipboard-image','圖片剪貼簿','寫入本 App 產生的 PNG，貼上效果人工確認。',api('ClipboardItem')),
  ]},
  { id:'screen', title:'螢幕控制', note:'API 與裝置模式影響操作；沒有全螢幕支援不等於 App 故障。', tests:[
    item('wake','保持螢幕喚醒','離開前景釋放 Wake Lock。',api('navigator.wakeLock.request')),
    item('fullscreen','全螢幕','測試請求與退出；效果需確認。',api('document.documentElement.requestFullscreen')),
    item('orientation-lock','鎖定方向','通常有全螢幕等條件。',api('screen.orientation.lock')),
  ]},
  { id:'storage', title:'本機儲存', note:'測試鍵值使用本 App 命名空間，不清除其他網站的資料。', tests:[
    item('local-storage','localStorage 寫入／讀回','留下一筆測試值供重啟讀回。'),
    item('indexeddb','IndexedDB 写入／讀回','使用獨立測試資料庫。',api('indexedDB')),
    item('cache','Cache Storage 寫入／讀回','使用獨立測試快取。',api('caches')),
    item('storage-estimate','儲存容量估計','估計不代表永久容量保證。',api('navigator.storage.estimate')),
    item('persist','持久儲存請求','被拒絕不視為永久保存。',api('navigator.storage.persist')),
  ]},
  { id:'offline', title:'離線與更新', note:'第一次快取完成後才可離線。主畫面安裝、飛航模式重啟與更新最後需 iPhone 驗收。', tests:[
    item('offline','快取與版本狀態','檢查 shell 完整快取，並記錄連線狀態。',api('navigator.serviceWorker')),
    item('install','主畫面安裝／離線重啟','請依頁尾步驟安裝，飛航模式下重啟後人工確認。'),
  ]},
  { id:'network', title:'網路與通訊', note:'只請求同站測試檔，WebRTC 只建立本機迴路，不連接外部服務。', tests:[
    item('fetch','同站請求與時間','以 no-store 取得測試檔；離線不使用 shell 快取假裝網路成功。',api('fetch')),
    item('abort-fetch','取消請求','取消的結果應標為使用者取消。',api('AbortController')),
    item('webrtc','WebRTC 本機資料迴路','兩個本機 peer 傳遞測試文字；不要求相機。',api('RTCPeerConnection')),
  ]},
  { id:'graphics', title:'圖形與計算', note:'基本繪圖與計算能成功不代表效能或完整 API 支援。', tests:[
    item('canvas','Canvas 繪圖','產生色塊並檢查像素值。'),
    item('webgl','WebGL 繪圖','清除畫面並讀回像素。'),
    item('webgpu','WebGPU 繪圖','取得 adapter/device，提交畫面清除指令；顯示效果人工確認。',api('navigator.gpu')),
    item('wasm','WebAssembly 計算','執行回傳 42 的最小模組。',api('WebAssembly')),
    item('worker','Web Worker 計算','在獨立 worker 計算與回傳。',api('Worker')),
    item('crypto','Web Crypto 雜湊','SHA-256 與已知測試值比對。',api('crypto.subtle')),
  ]},
  { id:'lifecycle', title:'生命週期', note:'切換 App／鎖屏後回前景查看事件，不推論可持續背景執行。', tests:[
    item('lifecycle','事件與計時器觀察','顯示 visibility、pagehide、pageshow 以及 timer 時間間隔。'),
  ]},
  { id:'notifications', title:'通知與徽章', note:'權限、API 呼叫、可見效果與遠端推播分開記錄。通知權限可依 iOS 模式受限。', tests:[
    item('notification','通知權限請求','只記錄權限，不宣稱已收到通知。',api('Notification.requestPermission')),
    item('badge','設定徽章','設定為 1；主畫面圖示效果需人工確認。',api('navigator.setAppBadge')),
    item('clear-badge','清除徽章','清除後自行查看主畫面。',api('navigator.clearAppBadge')),
    item('push','遠端 Web Push','訂閱、伺服器送出與接收測試待後端。',api('PushManager'),'','backend'),
  ]},
  { id:'system', title:'系統入口', note:'連結由使用者自行點擊開啟介面，不自動撥號或送出。', tests:[
    item('system','電話／簡訊／郵件入口','請自行填寫目標並點連結，開啟效果人工確認。',()=>true,'system'),
  ]},
  { id:'conditional', title:'條件式 Web API', note:'API 存在時提供最小操作；設備、瀏覽器或外部服務不足時記錄缺少條件。', tests:[
    item('bluetooth','Bluetooth 裝置選擇','只選擇裝置，不連線或讀寫。',api('navigator.bluetooth.requestDevice')),
    item('nfc','NFC 讀取','需支援 NDEFReader 與實體標籤，15 秒逾時。',api('NDEFReader')),
    item('usb','USB 裝置選擇','只選擇裝置，不開啟連線。',api('navigator.usb.requestDevice')),
    item('serial','Serial 埠選擇','只選擇埠，不開啟連線。',api('navigator.serial.requestPort')),
    item('hid','HID 裝置選擇','只選擇裝置，不讀寫。',api('navigator.hid.requestDevice')),
    item('contacts','Contacts Picker','手動選擇；報告僅保存數量，不保存聯絡資訊。',api('navigator.contacts.select')),
    item('battery','Battery','讀取電量及充電狀態。',api('navigator.getBattery')),
    item('connection','Network Information','讀取瀏覽器提供的連線摘要。',api('navigator.connection')),
    item('xr','WebXR','偵測 immersive-ar session 條件，不啟動 AR。',api('navigator.xr.isSessionSupported')),
  ]},
  { id:'passkey', title:'Passkey 與原生限制', note:'平台驗證器不提供 Face ID 生物資料；完整註冊、認證與伺服器驗證待後端。', tests:[
    item('passkey','平台驗證器支援偵測','只查詢平台驗證器可用性。',api('PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable')),
    item('passkey-flow','完整 Passkey 流程','需後端 challenge、驗證及帳號流程。',api('PublicKeyCredential'),'','backend'),
    item('native','原生／特殊服務研究','HealthKit、HomeKit、完整相簿／行事曆、背景定位、ARKit／LiDAR、Siri／捷徑、Widget／Live Activities、Screen Time、Keychain／iCloud、Apple Watch／CarPlay、Apple Pay／登入／內購需逐項評估 SDK、資格與服務。其他 App 私有資料、簡訊紀錄、任意 Wi-Fi 掃描沒有一般 Web 入口。',()=>false,'','native'),
  ]},
];
export const TESTS = CATEGORIES.flatMap(category => category.tests);
