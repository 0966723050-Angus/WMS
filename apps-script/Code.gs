/**
 * WMS 登入驗證 + 儲位編輯中繼 (Google Apps Script Web App)
 *
 * 前端以 Google 登入取得 ID token -> action=auth 驗證並檢查名單 -> 回傳資料解密金鑰與工作階段(session)
 * 之後的動作(儲存、待寫入清單、管理名單)都用 session,每次呼叫都會重新檢查名單。
 * 本機排程用 SYNC_KEY 取回/確認待寫入的修改,並可設定 DATA_KEY。
 *
 * 機密只放在「專案設定 > 指令碼屬性」,不寫在程式碼裡:
 *   GOOGLE_CLIENT_ID  Google Cloud 建立的 OAuth 用戶端 ID(網頁應用程式)
 *   ADMIN_EMAIL       唯一的管理者帳號(可進入設定頁管理名單)
 *   SYNC_KEY          本機排程使用的金鑰
 *   DATA_KEY          資料解密金鑰(由本機 setup_auth.py 產生並上傳,不必手動設定)
 *   SESSION_SECRET    工作階段簽章用,第一次使用時自動產生
 * 授權名單存在以 u_ 開頭的屬性,由管理者在網站設定頁新增/編輯/刪除。
 */

var PREFIX = 'e_';          // 待寫入 Excel 的修改
var USER_PREFIX = 'u_';     // 授權名單
var MAX_PENDING = 500;
var MAX_USERS = 400;
var MAX_FAILS = 10;
var FAIL_WINDOW_MS = 10 * 60 * 1000;
var SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function props_() { return PropertiesService.getScriptProperties(); }

function clip_(v, n) {
  return String(v === null || v === undefined ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n || 100);
}

function normEmail_(v) { return String(v || '').trim().toLowerCase(); }

// 屬性名稱有長度限制,所以 Email 限制在 48 字元內(加上 u_ 前綴 50 字元)
function isEmail_(v) { return v.length <= 48 && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(v); }

// ---------- 本機同步金鑰(含失敗次數限制) ----------

function checkSyncKey_(given) {
  var p = props_();
  var now = Date.now();
  var fails = JSON.parse(p.getProperty('FAILS') || '[]').filter(function (t) { return now - t < FAIL_WINDOW_MS; });
  if (fails.length >= MAX_FAILS) return '錯誤次數過多,請 10 分鐘後再試';
  var secret = p.getProperty('SYNC_KEY');
  if (!secret || String(given) !== String(secret)) {
    fails.push(now);
    p.setProperty('FAILS', JSON.stringify(fails));
    return '同步金鑰錯誤';
  }
  return null;
}

// ---------- Google ID token 與 session ----------

function verifyIdToken_(idToken) {
  var clientId = props_().getProperty('GOOGLE_CLIENT_ID');
  if (!clientId) throw new Error('尚未設定 GOOGLE_CLIENT_ID');
  var res = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(idToken || '')),
    { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  var t = JSON.parse(res.getContentText());
  var issOk = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com';
  if (t.aud !== clientId || !issOk || String(t.email_verified) !== 'true' || Number(t.exp) * 1000 < Date.now()) return null;
  return { email: normEmail_(t.email), name: clip_(t.name, 80) };
}

function sessionSecret_() {
  var p = props_();
  var s = p.getProperty('SESSION_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    p.setProperty('SESSION_SECRET', s);
  }
  return s;
}

function sign_(msg) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(msg, sessionSecret_())).replace(/=+$/, '');
}

function makeSession_(email) {
  var exp = Date.now() + SESSION_TTL_MS;
  var body = exp + '|' + email;
  return { token: encodeURIComponent(body) + '.' + sign_(body), exp: exp };
}

// ---------- 權限 ----------
// admin 名單管理 / edit 儲位編輯 / receive 收料 / erp_receipt 進貨單 / erp_issue 製令領料單 / erp_wms WMS更新
// 帳號記錄裡沒有 perms 的舊帳號 = 只有「儲位編輯」(維持原本能做的事)。主管理者(ADMIN_EMAIL)永遠全部權限。

var PERM_KEYS = ['admin', 'edit', 'receive', 'erp_receipt', 'erp_issue', 'erp_wms'];
// 沒設定過的項目用預設值:儲位編輯、收料原本所有人都能用,所以舊帳號維持有這兩項
var PERM_DEFAULTS = { admin: false, edit: true, receive: true, erp_receipt: false, erp_issue: false, erp_wms: false };

function normPerms_(p) {
  var out = {};
  PERM_KEYS.forEach(function (k) {
    out[k] = (p && typeof p[k] === 'boolean') ? p[k] : PERM_DEFAULTS[k];
  });
  return out;
}

function allPerms_() {
  var out = {};
  PERM_KEYS.forEach(function (k) { out[k] = true; });
  return out;
}

function isPrimaryAdmin_(email) {
  var admin = normEmail_(props_().getProperty('ADMIN_EMAIL'));
  return !!admin && normEmail_(email) === admin;
}

// 目前仍在名單內(且啟用)的使用者;主管理者永遠有效
function userFor_(email) {
  var raw = props_().getProperty(USER_PREFIX + email);
  var u = null;
  try { u = raw ? JSON.parse(raw) : null; } catch (err) { u = null; }
  if (isPrimaryAdmin_(email)) return { email: email, name: (u && u.name) || '管理者', isAdmin: true, perms: allPerms_() };
  if (u && u.enabled !== false) {
    var perms = normPerms_(u.perms);
    return { email: email, name: u.name || '', isAdmin: perms.admin, perms: perms };
  }
  return null;
}

function denied_(what) { return json_({ ok: false, error: '您沒有「' + what + '」的權限' }); }

function checkSession_(token) {
  token = String(token || '');
  var i = token.lastIndexOf('.');
  if (i < 1) return null;
  var body;
  try { body = decodeURIComponent(token.slice(0, i)); } catch (err) { return null; }
  if (sign_(body) !== token.slice(i + 1)) return null;
  var sep = body.indexOf('|');
  var exp = Number(body.slice(0, sep));
  if (!(exp > Date.now())) return null;
  return userFor_(body.slice(sep + 1));
}

// ---------- 名單 ----------

function listUsers_() {
  var all = props_().getProperties();
  var out = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(USER_PREFIX) !== 0) return;
    try {
      var u = JSON.parse(all[k]);
      out.push({ email: k.slice(USER_PREFIX.length), name: u.name || '', enabled: u.enabled !== false, addedAt: u.addedAt || 0, perms: normPerms_(u.perms) });
    } catch (err) { /* 略過壞資料 */ }
  });
  out.sort(function (a, b) { return a.email < b.email ? -1 : a.email > b.email ? 1 : 0; });
  return out;
}

function putUser_(email, name, enabled, addedAt, perms) {
  props_().setProperty(USER_PREFIX + email, JSON.stringify({
    name: clip_(name, 80), enabled: enabled !== false, addedAt: addedAt || Date.now(), perms: normPerms_(perms)
  }));
}

function adminAction_(body, user) {
  var p = props_();
  if (body.action === 'admin_list') return { ok: true, users: listUsers_(), adminEmail: user.email };

  if (body.action === 'admin_add') {
    var items = Array.isArray(body.users) ? body.users : [];
    var existing = listUsers_();
    var have = {};
    existing.forEach(function (u) { have[u.email] = true; });
    var added = 0, skipped = [];
    items.forEach(function (it) {
      var email = normEmail_(it && it.email);
      if (!isEmail_(email)) { skipped.push(String(it && it.email || '').slice(0, 60) + '(格式不正確)'); return; }
      if (have[email]) { skipped.push(email + '(已存在)'); return; }
      if (existing.length + added >= MAX_USERS) { skipped.push(email + '(名單已達上限)'); return; }
      if (isPrimaryAdmin_(email) && !isPrimaryAdmin_(user.email)) { skipped.push(email + '(主管理者)'); return; }
      putUser_(email, it.name, true, 0, body.perms);
      have[email] = true;
      added++;
    });
    return { ok: true, added: added, skipped: skipped, users: listUsers_() };
  }

  var email0 = normEmail_(body.email);
  var raw = p.getProperty(USER_PREFIX + email0);
  if (!raw) return { ok: false, error: '名單中找不到此帳號' };
  var old = JSON.parse(raw);

  // 主管理者的記錄只有主管理者自己能改(避免被其他有「名單管理」權限的人刪除或改名)
  if (isPrimaryAdmin_(email0) && !isPrimaryAdmin_(user.email)) return { ok: false, error: '只有主管理者可以修改主管理者' };

  if (body.action === 'admin_delete') {
    p.deleteProperty(USER_PREFIX + email0);
    return { ok: true, users: listUsers_() };
  }

  if (body.action === 'admin_update') {
    var newEmail = body.newEmail ? normEmail_(body.newEmail) : email0;
    if (!isEmail_(newEmail)) return { ok: false, error: 'Email 格式不正確' };
    if (newEmail !== email0 && p.getProperty(USER_PREFIX + newEmail)) return { ok: false, error: '新的 Email 已在名單中' };
    if (newEmail !== email0 && isPrimaryAdmin_(newEmail) && !isPrimaryAdmin_(user.email)) return { ok: false, error: '不能改成主管理者的帳號' };
    var enabled = body.enabled === undefined ? old.enabled !== false : !!body.enabled;
    if (newEmail !== email0) p.deleteProperty(USER_PREFIX + email0);
    putUser_(newEmail, body.name === undefined ? old.name : body.name, enabled, old.addedAt,
      body.perms === undefined ? old.perms : body.perms);
    return { ok: true, users: listUsers_() };
  }
  return { ok: false, error: '不支援的動作' };
}

// ---------- 待寫入 Excel 的修改 ----------

function listPending_() {
  var all = props_().getProperties();
  var out = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(PREFIX) !== 0) return;
    try { out.push(JSON.parse(all[k])); } catch (err) { /* 略過壞資料 */ }
  });
  out.sort(function (a, b) { return a.ts - b.ts; });
  return out;
}

function saveEdit_(body, user) {
  var row = parseInt(body.row, 10);
  var code = clip_(body.code, 60);
  if (!code || !(row >= 2)) return { ok: false, error: '缺少材料品號或列號' };
  if (listPending_().length >= MAX_PENDING) return { ok: false, error: '待處理修改過多,請稍後再試' };
  var ts = Date.now();
  var id = ts + '_' + Math.random().toString(36).slice(2, 8);
  var edit = {
    id: id, ts: ts, row: row, code: code, by: user.email,
    name: clip_(body.name, 200), spec: clip_(body.spec, 200), stock: clip_(body.stock, 30),
    category: clip_(body.category), location: clip_(body.location), bin: clip_(body.bin)
  };
  props_().setProperty(PREFIX + id, JSON.stringify(edit));
  return { ok: true, id: id };
}

// ---------- 收料(網頁送出,本機排程寫入 WMS.xlsx 的「收料」工作表) ----------

var RECEIPT_PREFIX = 'r_';
var MAX_RECEIPTS = 500;

function listReceipts_() {
  var all = props_().getProperties();
  var out = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(RECEIPT_PREFIX) !== 0) return;
    try { out.push(JSON.parse(all[k])); } catch (err) { /* 略過壞資料 */ }
  });
  out.sort(function (a, b) { return a.ts - b.ts; });
  return out;
}

function saveReceipt_(body, user) {
  var code = clip_(body.code, 60);
  var qty = Number(body.qty);
  if (!code) return { ok: false, error: '缺少品號' };
  if (!(qty > 0) || qty > 10000000) return { ok: false, error: '數量必須大於 0' };
  qty = Math.round(qty * 1000) / 1000;
  if (listReceipts_().length >= MAX_RECEIPTS) return { ok: false, error: '待處理的收料過多,請稍後再試' };
  var ts = Date.now();
  var id = ts + '_' + Math.random().toString(36).slice(2, 8);
  var rec = {
    id: id, ts: ts, by: user.email,
    vendor: clip_(body.vendor, 100), po: clip_(body.po, 100),
    code: code, name: clip_(body.name, 200), qty: qty, order: clip_(body.order, 60)
  };
  props_().setProperty(RECEIPT_PREFIX + id, JSON.stringify(rec));
  return { ok: true, id: id };
}

// ---------- WMS 更新(管理者在 ERP 頁按「WMS更新」,本機排程取回後啟動「WMS 自動更新」) ----------
// WMS_REQ    :尚未被本機取走的更新請求 {ts, by}
// WMS_STATUS :本機回報的狀態 {state: running|done|error, msg, ts}

var WMS_REQ_KEY = 'WMS_REQ';
var WMS_STATUS_KEY = 'WMS_STATUS';
var WMS_STALE_MS = 2 * 60 * 60 * 1000;   // 執行中狀態超過 2 小時視為已失效(避免本機當掉後按鈕永遠鎖住)

function readJson_(key) {
  try { return JSON.parse(props_().getProperty(key) || 'null'); } catch (err) { return null; }
}

function wmsView_() {
  var req = readJson_(WMS_REQ_KEY);
  var st = readJson_(WMS_STATUS_KEY);
  if (st && st.state === 'running' && Date.now() - st.ts > WMS_STALE_MS) st = { state: 'error', msg: '執行逾時未回報', ts: st.ts };
  return { ok: true, queued: req, status: st };
}

function requestWmsUpdate_(user) {
  var v = wmsView_();
  if (v.queued) return { ok: false, error: '已有更新請求排隊中,請稍候(電腦約每 5 分鐘檢查一次)' };
  if (v.status && v.status.state === 'running') return { ok: false, error: 'WMS 更新正在執行中' };
  props_().setProperty(WMS_REQ_KEY, JSON.stringify({ ts: Date.now(), by: user.email }));
  return { ok: true };
}

// ---------- ERP「進貨單」(PURI09):網頁送出請求,電腦上的 Claude 排程取走後執行 puri09 skill ----------
// PURI09_REQ    :排隊中的請求 {ts, by}
// PURI09_STATUS :執行狀態 {state: running|done|error, msg, ts, by}

var PURI_REQ_KEY = 'PURI09_REQ';
var PURI_STATUS_KEY = 'PURI09_STATUS';
var PURI_STALE_MS = 3 * 60 * 60 * 1000;   // 執行中超過 3 小時視為失效(避免當掉後按鈕永遠鎖住)

function puriView_() {
  var req = readJson_(PURI_REQ_KEY);
  var st = readJson_(PURI_STATUS_KEY);
  if (st && st.state === 'running' && Date.now() - st.ts > PURI_STALE_MS) st = { state: 'error', msg: '執行逾時未回報', ts: st.ts, by: st.by };
  return { ok: true, queued: req, status: st };
}

function requestPuri_(user) {
  var v = puriView_();
  if (v.queued) return { ok: false, error: '已有進貨單請求排隊中,請稍候' };
  if (v.status && v.status.state === 'running') return { ok: false, error: '進貨單正在執行中' };
  props_().setProperty(PURI_REQ_KEY, JSON.stringify({ ts: Date.now(), by: user.email }));
  return { ok: true };
}

// Claude 排程取請求:有排隊中的請求且目前沒有執行中,就取走並標記為執行中
function puriClaim_() {
  var v = puriView_();
  if (!v.queued) return { ok: true, pending: false };
  if (v.status && v.status.state === 'running') return { ok: true, pending: false, busy: true };
  props_().deleteProperty(PURI_REQ_KEY);
  props_().setProperty(PURI_STATUS_KEY, JSON.stringify({ state: 'running', msg: '', ts: Date.now(), by: v.queued.by }));
  return { ok: true, pending: true, request: v.queued };
}

function puriReport_(state, msg) {
  if (['done', 'error'].indexOf(state) === -1) return { ok: false, error: '狀態不正確' };
  var cur = readJson_(PURI_STATUS_KEY) || {};
  props_().setProperty(PURI_STATUS_KEY, JSON.stringify({ state: state, msg: clip_(msg, 300), ts: Date.now(), by: cur.by || '' }));
  return { ok: true };
}

// ---------- 自動執行排程(ERP 頁「設定」;由本機排程每 5 分鐘取回並依時間啟動) ----------
// SCHEDULES:{ <job>: { enabled, start: 'HH:MM', end: 'HH:MM', interval: 分鐘, skipSat, skipSun, updatedAt, by } }
// 每天 start 起每 interval 分鐘執行一次,到 end 為止;skipSat / skipSun 為 true 時該天不執行。

var SCHEDULES_KEY = 'SCHEDULES';
var SCHED_JOBS = { wms: 'WMS更新' };   // 可設定自動執行的執行鍵
var SCHED_MIN_INTERVAL = 30;
var SCHED_MAX_INTERVAL = 1440;

function getSchedules_() { return readJson_(SCHEDULES_KEY) || {}; }

function isHm_(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')); }

function scheduleAction_(body, user) {
  var all = getSchedules_();
  if (body.action === 'sched_get') return { ok: true, schedules: all, jobs: SCHED_JOBS };

  var job = String(body.job || '');
  if (!SCHED_JOBS.hasOwnProperty(job)) return { ok: false, error: '不支援的執行鍵' };

  if (body.action === 'sched_delete') {
    delete all[job];
  } else if (body.action === 'sched_set') {
    var start = String(body.start || ''), end = String(body.end || '');
    var interval = parseInt(body.interval, 10);
    if (!isHm_(start) || !isHm_(end)) return { ok: false, error: '時間格式不正確' };
    if (start >= end) return { ok: false, error: '結束時間必須晚於開始時間' };
    if (!(interval >= SCHED_MIN_INTERVAL && interval <= SCHED_MAX_INTERVAL)) {
      return { ok: false, error: '間隔必須介於 30 分鐘到 24 小時之間' };
    }
    all[job] = {
      enabled: body.enabled !== false, start: start, end: end, interval: interval,
      skipSat: body.skipSat === true, skipSun: body.skipSun === true,   // 勾選的日子不自動執行
      updatedAt: Date.now(), by: user.email
    };
  } else {
    return { ok: false, error: '不支援的動作' };
  }
  props_().setProperty(SCHEDULES_KEY, JSON.stringify(all));
  return { ok: true, schedules: all, jobs: SCHED_JOBS };
}

// ---------- 編輯畫面的下拉選單項目(類別 / 儲放地點) ----------
// 存在指令碼屬性 OPTIONS(JSON:{category:[...], location:[...]}),所有登入者共用。
// 某欄位尚未設定過時回傳 null,由前端用現有資料的值當初始選項。

var OPTIONS_KEY = 'OPTIONS';
var MAX_OPTIONS = 100;       // 每個欄位最多項目數
var MAX_OPTION_LEN = 30;     // 單一項目最長字數

function getOptions_() {
  try { return JSON.parse(props_().getProperty(OPTIONS_KEY) || '{}') || {}; } catch (err) { return {}; }
}

function cleanList_(arr) {
  var seen = {}, out = [];
  (Array.isArray(arr) ? arr : []).forEach(function (x) {
    var v = clip_(x, MAX_OPTION_LEN);
    if (v && !seen[v]) { seen[v] = true; out.push(v); }
  });
  return out.slice(0, MAX_OPTIONS);
}

// op: 'add' | 'remove';seed 只在該欄位尚未設定過時當作起始清單
function changeOption_(body) {
  var field = body.field;
  if (field !== 'category' && field !== 'location') return { ok: false, error: '欄位不正確' };
  var value = clip_(body.value, MAX_OPTION_LEN);
  if (!value) return { ok: false, error: '項目不可空白' };
  var opts = getOptions_();
  var list = Array.isArray(opts[field]) ? cleanList_(opts[field]) : cleanList_(body.seed);
  if (body.op === 'add') {
    if (list.indexOf(value) === -1) {
      if (list.length >= MAX_OPTIONS) return { ok: false, error: '項目已達上限(' + MAX_OPTIONS + ')' };
      list.push(value);
    }
  } else if (body.op === 'remove') {
    list = list.filter(function (x) { return x !== value; });
  } else {
    return { ok: false, error: '不支援的動作' };
  }
  opts[field] = list;
  var raw = JSON.stringify(opts);
  if (raw.length > 8000) return { ok: false, error: '選單內容過長,請先刪除不用的項目' };
  props_().setProperty(OPTIONS_KEY, raw);
  return { ok: true, options: opts };
}

// ---------- 進入點 ----------

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var action = body.action;

    if (action === 'auth') {
      var info = verifyIdToken_(body.idToken);
      if (!info) return json_({ ok: false, error: '登入驗證失敗,請重新登入' });
      var user = userFor_(info.email);
      if (!user) return json_({ ok: false, error: '此帳號(' + info.email + ')不在授權名單內,請聯絡管理者' });
      var key = props_().getProperty('DATA_KEY');
      if (!key) return json_({ ok: false, error: '系統尚未完成設定(缺少資料金鑰),請聯絡管理者' });
      var s = makeSession_(user.email);
      return json_({ ok: true, email: user.email, name: user.name || info.name, isAdmin: user.isAdmin, perms: user.perms, key: key, session: s.token, exp: s.exp });
    }

    var me = checkSession_(body.session);
    if (!me) return json_({ ok: false, needLogin: true, error: '登入已失效,請重新登入' });

    // 目前的權限(管理者可能在登入後才調整,前端開啟時會用這個更新)
    if (action === 'me') return json_({ ok: true, email: me.email, name: me.name, isAdmin: me.isAdmin, perms: me.perms });

    if (action === 'pending') return json_({ ok: true, pending: listPending_() });
    if (action === 'save') {
      if (!me.perms.edit) return denied_('儲位編輯');
      return json_(saveEdit_(body, me));
    }
    if (action === 'receive') {
      if (!me.perms.receive) return denied_('收料');
      return json_(saveReceipt_(body, me));
    }
    if (action === 'wms_status' || action === 'wms_update') {
      if (!me.perms.erp_wms) return denied_('WMS更新');
      return json_(action === 'wms_update' ? requestWmsUpdate_(me) : wmsView_());
    }
    if (action === 'puri09_status' || action === 'puri09_request') {
      if (!me.perms.erp_receipt) return denied_('進貨單');
      return json_(action === 'puri09_request' ? requestPuri_(me) : puriView_());
    }
    if (action === 'sched_get' || action === 'sched_set' || action === 'sched_delete') {
      if (!me.isAdmin) return json_({ ok: false, error: '只有管理者可以使用' });
      return json_(scheduleAction_(body, me));
    }
    if (action === 'options_get') return json_({ ok: true, options: getOptions_() });
    if (action === 'options_change') {
      if (!me.perms.edit) return denied_('儲位編輯');
      return json_(changeOption_(body));
    }
    if (String(action).indexOf('admin_') === 0) {
      if (!me.isAdmin) return json_({ ok: false, error: '只有管理者可以使用' });
      return json_(adminAction_(body, me));
    }
    return json_({ ok: false, error: '不支援的動作' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (p.action === 'pull' || p.action === 'ack' || p.action === 'set_data_key' || p.action === 'wms_report' ||
        p.action === 'puri09_claim' || p.action === 'puri09_report') {
      var err = checkSyncKey_(p.key);
      if (err) return json_({ ok: false, error: err });

      if (p.action === 'puri09_claim') return json_(puriClaim_());
      if (p.action === 'puri09_report') return json_(puriReport_(String(p.state || ''), p.msg));

      if (p.action === 'pull') return json_({ ok: true, edits: listPending_(), receipts: listReceipts_(), wms: readJson_(WMS_REQ_KEY), schedules: getSchedules_() });

      // 本機回報 WMS 更新狀態;回報 running 代表請求已被取走,一併清除排隊中的請求
      if (p.action === 'wms_report') {
        var st = String(p.state || '');
        if (['running', 'done', 'error'].indexOf(st) === -1) return json_({ ok: false, error: '狀態不正確' });
        props_().setProperty(WMS_STATUS_KEY, JSON.stringify({ state: st, msg: clip_(p.msg, 200), ts: Date.now() }));
        if (st === 'running') props_().deleteProperty(WMS_REQ_KEY);
        return json_({ ok: true });
      }

      if (p.action === 'set_data_key') {
        if (!/^[A-Za-z0-9+\/]{43}=$/.test(String(p.dataKey || ''))) return json_({ ok: false, error: '金鑰格式不正確' });
        props_().setProperty('DATA_KEY', p.dataKey);
        return json_({ ok: true });
      }

      var removed = 0;
      String(p.ids || '').split(',').forEach(function (id) {
        id = id.trim();
        if (!id) return;
        [PREFIX, RECEIPT_PREFIX].forEach(function (pre) {
          if (props_().getProperty(pre + id) !== null) {
            props_().deleteProperty(pre + id);
            removed++;
          }
        });
      });
      return json_({ ok: true, removed: removed });
    }
    return json_({ ok: true, service: 'wms-edit' });
  } catch (err2) {
    return json_({ ok: false, error: String(err2) });
  } finally {
    lock.releaseLock();
  }
}
