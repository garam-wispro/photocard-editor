/**
 * 포토카드 에디터 접수 프로그램 (Google Apps Script 웹 앱, prtromance@gmail.com 계정)
 * 에디터가 만든 제작용 ZIP을 구글 드라이브로 받고, 접수 메일을 보낸다.
 * 권한은 최소로 둔다: 이 프로그램이 만든 드라이브 파일만(drive.file), 메일 보내기, 외부 요청.
 * 메일 라벨은 지메일 필터(제목에 "[포토카드 시안]")로 붙인다.
 *
 * 흐름: ① 에디터가 start 요청 → 드라이브 업로드 주소와 접수표(token)를 돌려준다
 *       ② 에디터가 그 주소로 파일을 직접 올린다(파일은 이 프로그램을 거치지 않는다)
 *       ③ 에디터가 done 요청 → 파일을 확인하고 접수 메일을 보낸다
 */
const CFG = {
  notify: 'prtromance@gmail.com',
  subjectTag: '[포토카드 시안]',
  rootName: '포토카드 시안 접수',
  origins: ['https://photocard.prtromance.com', 'http://localhost:8770'],
  maxBytes: 2 * 1024 * 1024 * 1024, // 파일 하나 최대 2GB
  dailyLimit: 90, // 하루 접수 한도(지메일 발송 한도 100통 안쪽)
  zipPw: '123123'
};
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';

function doGet() { return out_({ ok: true, service: 'photocard-receiver' }); }

function doPost(e) {
  try {
    const q = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (q.action === 'start') return out_(start_(q));
    if (q.action === 'done') return out_(done_(q));
    return out_({ ok: false, error: '알 수 없는 요청' });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function clean_(s, n) {
  return String(s == null ? '' : s).replace(/[\/\\:*?"<>|\x00-\x1f]/g, '').trim().slice(0, n);
}

function api_(method, url, body, headers) {
  const opt = {
    method: method, muteHttpExceptions: true,
    headers: Object.assign({ Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, headers || {})
  };
  if (body !== undefined) { opt.contentType = 'application/json; charset=UTF-8'; opt.payload = JSON.stringify(body); }
  const r = UrlFetchApp.fetch(url, opt), c = r.getResponseCode();
  if (c < 200 || c >= 300) throw new Error('드라이브 오류 ' + c + ': ' + r.getContentText().slice(0, 200));
  return r;
}

// 폴더 ID를 기억해 두고, 지워졌으면 다시 만든다
function folder_(key, name, parent) {
  const p = PropertiesService.getScriptProperties();
  let id = p.getProperty(key);
  if (id) {
    try {
      const f = JSON.parse(api_('get', DRIVE + '/' + id + '?fields=id,trashed').getContentText());
      if (!f.trashed) return id;
    } catch (e) { /* 없어진 폴더 → 새로 만든다 */ }
  }
  const body = { name: name, mimeType: 'application/vnd.google-apps.folder' };
  if (parent) body.parents = [parent];
  id = JSON.parse(api_('post', DRIVE + '?fields=id', body).getContentText()).id;
  p.setProperty(key, id);
  return id;
}

// 접수 폴더 > 월별 폴더(예: 2026-11)
function monthFolder_() {
  const root = folder_('root', CFG.rootName);
  const m = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM');
  return folder_('m:' + m, m, root);
}

// 하루 접수 한도
function countToday_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const p = PropertiesService.getScriptProperties();
    const k = 'n:' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
    const n = Number(p.getProperty(k) || 0) + 1;
    if (n > CFG.dailyLimit) throw new Error('오늘 접수 한도를 넘었습니다.');
    p.setProperty(k, String(n));
  } finally { lock.releaseLock(); }
}

function start_(q) {
  const origin = String(q.origin || '');
  if (CFG.origins.indexOf(origin) < 0) throw new Error('허용되지 않은 주소');
  const name = clean_(q.name, 30), ono = clean_(q.ono, 40), size = Number(q.size);
  if (!name) throw new Error('주문자명이 없습니다.');
  if (!ono) throw new Error('주문번호가 없습니다.');
  if (!(size > 0 && size <= CFG.maxBytes) || size !== Math.floor(size)) throw new Error('파일 크기가 맞지 않습니다.');
  let fileName = clean_(q.fileName, 120);
  if (!/\.zip$/i.test(fileName)) fileName += '.zip';
  countToday_();
  const folder = monthFolder_();
  const r = api_('post', UPLOAD,
    { name: fileName, parents: [folder], mimeType: 'application/zip', description: '주문번호 ' + ono + ' / 주문자 ' + name },
    { Origin: origin, 'X-Upload-Content-Type': 'application/zip', 'X-Upload-Content-Length': String(size) });
  const h = r.getHeaders(), url = h.Location || h.location;
  if (!url) throw new Error('업로드 주소를 받지 못했습니다.');
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('t:' + token,
    JSON.stringify({ name: name, ono: ono, fileName: fileName, size: size, folder: folder }), 21600);
  return { ok: true, url: url, token: token };
}

function done_(q) {
  const cache = CacheService.getScriptCache(), key = 't:' + String(q.token || ''), raw = cache.get(key);
  if (!raw) throw new Error('접수 시간이 지났습니다. 다시 시도해 주세요.');
  const t = JSON.parse(raw), fields = 'id,name,size,parents,webViewLink,trashed';
  let f = null;
  if (q.fileId && /^[\w-]{10,80}$/.test(String(q.fileId))) {
    f = JSON.parse(api_('get', DRIVE + '/' + q.fileId + '?fields=' + fields).getContentText());
  } else { // 에디터가 업로드 응답을 읽지 못한 경우: 접수 폴더에서 같은 이름의 가장 최근 파일을 찾는다
    const qs = "'" + t.folder + "' in parents and name='" + t.fileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "' and trashed=false";
    const l = JSON.parse(api_('get', DRIVE + '?orderBy=createdTime%20desc&pageSize=1&fields=files(' + fields + ')&q=' + encodeURIComponent(qs)).getContentText());
    f = l.files && l.files[0];
  }
  if (!f || f.trashed || (f.parents || []).indexOf(t.folder) < 0 || Number(f.size) !== t.size) throw new Error('파일이 올바르게 올라오지 않았습니다.');
  cache.remove(key);
  const summary = clean_(q.summary, 100), sheet = String(q.sheet || '').slice(0, 6000);
  const now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
  const lines = ['포토카드 에디터에서 제작용 파일이 접수됐습니다.', '',
    '주문번호: ' + t.ono, '주문자명: ' + t.name, '접수일시: ' + now];
  if (summary) lines.push('내용: ' + summary);
  lines.push('', '파일: ' + t.fileName + ' (' + (t.size / 1048576).toFixed(1) + 'MB)', '받기: ' + f.webViewLink,
    '압축 암호: ' + CFG.zipPw, '', '보관 위치: 구글 드라이브 > ' + CFG.rootName, '', '----- 주문 내역 -----', sheet);
  MailApp.sendEmail(CFG.notify, CFG.subjectTag + ' ' + t.ono + ' · ' + t.name + (summary ? ' · ' + summary : ''),
    lines.join('\n'), { name: '포토카드 에디터' });
  return { ok: true };
}

// 처음 한 번 편집기에서 실행: 권한을 승인하고 접수 폴더를 만든다
function setup() {
  Logger.log('접수 폴더: ' + monthFolder_());
  Logger.log('오늘 남은 메일 발송 수: ' + MailApp.getRemainingDailyQuota());
}
