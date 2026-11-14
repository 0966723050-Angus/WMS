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
var SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;   // 登入有效 180 天,每次開啟網頁會自動順延(me),除非自己登出

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
// admin 名單管理 / edit 儲位編輯 / receive 收料 / ret 退料 / erp_receipt 進貨單 / erp_return 退貨單 / erp_issue 製令領料單 / erp_sign 待簽核表單 / erp_wms WMS更新
// 帳號記錄裡沒有 perms 的舊帳號 = 只有「儲位編輯」(維持原本能做的事)。主管理者(ADMIN_EMAIL)永遠全部權限。

var PERM_KEYS = ['admin', 'edit', 'receive', 'ret', 'erp_receipt', 'erp_return', 'erp_issue', 'erp_sign', 'erp_wms'];
// 沒設定過的項目用預設值:儲位編輯、收料原本所有人都能用,所以舊帳號維持有這兩項
var PERM_DEFAULTS = { admin: false, edit: true, receive: true, ret: false, erp_receipt: false, erp_return: false, erp_issue: false, erp_sign: false, erp_wms: false };

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

// ---------- 收料 / 退料(網頁送出,本機排程寫入 WMS.xlsx 的「收料」「退料」工作表) ----------
// 兩種清單共用同一套流程,依 kind 選用不同的屬性前綴與狀態鍵:
//   receipt:收料 -> 進貨單簽核(PURI09)      ret:退料 -> 退貨單簽核

var KINDS = {
  receipt: { prefix: 'r_', delPrefix: 'd_', snapKey: 'RECEIPT_SNAPSHOT', reqKey: 'PURI09_REQ', statusKey: 'PURI09_STATUS', label: '進貨單', what: '收料' },
  ret:     { prefix: 't_', delPrefix: 'x_', snapKey: 'RETURN_SNAPSHOT',  reqKey: 'RETURN_REQ',  statusKey: 'RETURN_STATUS',  label: '退貨單', what: '退料' }
};
// 待簽核表單的簽核請求也走同一套請求/狀態機制(只用到 reqKey / statusKey)
KINDS.sign = { prefix: '__sign_', delPrefix: '__signd_', snapKey: 'SIGN_SNAPSHOT', reqKey: 'SIGN_REQ', statusKey: 'SIGN_STATUS', label: '簽核', what: '簽核' };
var MAX_RECEIPTS = 500;

function kindOf_(kind) { return kind === 'ret' ? KINDS.ret : kind === 'sign' ? KINDS.sign : KINDS.receipt; }

function listByPrefix_(prefix) {
  var all = props_().getProperties();
  var out = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf(prefix) !== 0) return;
    try { out.push(JSON.parse(all[k])); } catch (err) { /* 略過壞資料 */ }
  });
  out.sort(function (a, b) { return a.ts - b.ts; });
  return out;
}

function listReceipts_(kind) { return listByPrefix_(kindOf_(kind).prefix); }

function saveReceipt_(body, user, kind) {
  var K = kindOf_(kind), isRet = K === KINDS.ret;
  var code = clip_(body.code, 60);
  var qty = Number(body.qty);
  if (!code) return { ok: false, error: '缺少品號' };
  if (!(qty > 0) || qty > 10000000) return { ok: false, error: '數量必須大於 0' };
  qty = Math.round(qty * 1000) / 1000;
  var docType = clip_(body.docType, 20), docNo = clip_(body.docNo, 40);
  if (isRet && (!docType || !docNo)) return { ok: false, error: '請填入進貨單別與進貨單號' };
  if (listReceipts_(kind).length >= MAX_RECEIPTS) return { ok: false, error: '待處理的' + K.what + '過多,請稍後再試' };
  var ts = Date.now();
  var id = ts + '_' + Math.random().toString(36).slice(2, 8);
  var rec = {
    id: id, ts: ts, by: user.email,
    vendor: clip_(body.vendor, 100), po: clip_(body.po, 100),
    code: code, name: clip_(body.name, 200), qty: qty, order: clip_(body.order, 60)
  };
  if (isRet) { rec.docType = docType; rec.docNo = docNo; }
  props_().setProperty(K.prefix + id, JSON.stringify(rec));
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

// ---------- ERP「進貨單」(PURI09)/「退貨單」:網頁送出請求,電腦上的 Claude 取走後執行對應的 skill ----------
// PURI09_REQ / RETURN_REQ       :排隊中的請求 {ts, by}
// PURI09_STATUS / RETURN_STATUS :執行狀態 {state: running|done|error, msg, ts, by}

var PURI_STALE_MS = 3 * 60 * 60 * 1000;   // 執行中超過 3 小時視為失效(避免當掉後按鈕永遠鎖住)

function puriView_(kind) {
  var K = kindOf_(kind);
  var req = readJson_(K.reqKey);
  var st = readJson_(K.statusKey);
  if (st && st.state === 'running' && Date.now() - st.ts > PURI_STALE_MS) st = { state: 'error', msg: '執行逾時未回報', ts: st.ts, by: st.by };
  return { ok: true, queued: req, status: st };
}

function requestPuri_(user, kind) {
  var K = kindOf_(kind);
  var v = puriView_(kind);
  if (v.queued) return { ok: false, error: '已有' + K.label + '請求排隊中,請稍候' };
  if (v.status && v.status.state === 'running') return { ok: false, error: K.label + '正在執行中' };
  var dn = listDeletes_(kind).length;   // 有刪除還沒同步到 Excel,這時送出會把已刪除的列也建成單據
  if (dn) return { ok: false, error: '還有 ' + dn + ' 筆刪除正在同步到 Excel(約 5 分鐘內),請稍後再確認' };
  props_().setProperty(K.reqKey, JSON.stringify({ ts: Date.now(), by: user.email }));
  return { ok: true };
}

// Claude 取請求:有排隊中的請求且目前沒有執行中,就取走並標記為執行中
function puriClaim_(kind) {
  var K = kindOf_(kind);
  var v = puriView_(kind);
  if (!v.queued) return { ok: true, pending: false };
  if (v.status && v.status.state === 'running') return { ok: true, pending: false, busy: true };
  props_().deleteProperty(K.reqKey);
  props_().setProperty(K.statusKey, JSON.stringify({ state: 'running', msg: '', ts: Date.now(), by: v.queued.by }));
  return { ok: true, pending: true, request: v.queued };
}

function puriReport_(state, msg, kind) {
  var K = kindOf_(kind);
  if (['done', 'error'].indexOf(state) === -1) return { ok: false, error: '狀態不正確' };
  var cur = readJson_(K.statusKey) || {};
  props_().setProperty(K.statusKey, JSON.stringify({ state: state, msg: clip_(msg, 300), ts: Date.now(), by: cur.by || '' }));
  return { ok: true };
}

// ---------- 「已收料 / 已退料清單」(WMS.xlsx「收料」「退料」工作表的內容快照) ----------
// 電腦端每次寫入 / 清除後,會把工作表目前的資料列回報上來(receipts_snapshot / returns_snapshot,需同步金鑰);
// 網站「進貨單簽核」「退貨單簽核」按下後,列出這份快照 + 尚未寫入 Excel 的排隊中項目,供使用者確認。

var RSNAP_MAX_ROWS = 60;
var RSNAP_MAX_CHARS = 8500;   // 指令碼屬性單一值上限約 9KB

function saveSnapshot_(body, kind) {
  var K = kindOf_(kind), isRet = K === KINDS.ret;
  var rows = Array.isArray(body.rows) ? body.rows : [];
  var out = [];
  rows.slice(0, RSNAP_MAX_ROWS).forEach(function (r) {
    if (!r) return;
    var o = {
      v: clip_(r.v, 20), p: clip_(r.p, 32), c: clip_(r.c, 32), n: clip_(r.n, 24),
      q: Number(r.q) || 0, d: clip_(r.d, 10),
      f: clip_(r.f, 80)   // 工作表「狀態」欄的失敗標記,例「⚠ 失敗:查無採購序號」
    };
    if (isRet) { o.dt = clip_(r.dt, 12); o.dn = clip_(r.dn, 24); }
    out.push(o);
  });
  var snap = { ts: Date.now(), total: parseInt(body.total, 10) || out.length, rows: out };
  var raw = JSON.stringify(snap);
  while (raw.length > RSNAP_MAX_CHARS && out.length) { out.pop(); raw = JSON.stringify(snap); }
  props_().setProperty(K.snapKey, raw);
  return { ok: true, stored: out.length };
}

// ---- 清單的「刪除」:網站送出刪除請求,電腦端約每 1 分鐘從 WMS.xlsx 對應工作表移除該列並回報 ----
var MAX_DELETES = 200;

function listDeletes_(kind) { return listByPrefix_(kindOf_(kind).delPrefix); }

// 以「廠商|採購單|品號|數量|進貨單別-單號」辨識同一列(和快照內容一致,字數已依快照上限截短);進貨單別-單號只有退料用
function rowKey_(v, p, c, q, doc) {
  return [clip_(v, 20), clip_(p, 32), clip_(c, 32), String(Number(q) || 0), clip_(doc, 40)].join('|');
}

function docKey_(dt, dn) { return (dt || dn) ? clip_(dt, 12) + '-' + clip_(dn, 24) : ''; }

function receiptListView_(kind) {
  var K = kindOf_(kind), isRet = K === KINDS.ret;
  var pending = listReceipts_(kind).map(function (r) {
    var o = { id: r.id, v: r.vendor, p: r.po, c: r.code, n: clip_(r.name, 24), q: r.qty, ts: r.ts };
    if (isRet) { o.dt = r.docType; o.dn = r.docNo; }
    return o;
  });
  var snap = readJson_(K.snapKey);
  var dels = listDeletes_(kind);
  if (snap && Array.isArray(snap.rows) && dels.length) {   // 已送出刪除、電腦還沒處理的列,標記「刪除中」
    var left = {};
    dels.forEach(function (d) { var k = rowKey_(d.vendor, d.po, d.code, d.qty, docKey_(d.docType, d.docNo)); left[k] = (left[k] || 0) + 1; });
    snap.rows.forEach(function (r) {
      var k = rowKey_(r.v, r.p, r.c, r.q, docKey_(r.dt, r.dn));
      if (left[k] > 0) { r.del = true; left[k]--; }
    });
  }
  return { ok: true, snapshot: snap, pending: pending, deleting: dels.length };
}

// 已收料但 ERP 進貨單還沒簽核的項目(排隊中還沒寫進 Excel 的 + 「收料」工作表快照裡的)。
// busy = 進貨單簽核已經按下(排隊中或執行中):這時收料鍵不再標黃,等執行完還留在「收料」裡的(失敗的)才會再變黃。
function receiptPendingView_() {
  var items = [], seen = {};
  function add(p, c) {
    var k = p + '|' + c;
    if (c && !seen[k]) { seen[k] = true; items.push({ p: p, c: c }); }
  }
  listReceipts_('receipt').forEach(function (r) { add(String(r.po || ''), String(r.code || '')); });
  var snap = readJson_(KINDS.receipt.snapKey);
  if (snap && Array.isArray(snap.rows)) snap.rows.forEach(function (r) { if (!r.del) add(String(r.p || ''), String(r.c || '')); });
  var v = puriView_('receipt');
  return { ok: true, items: items.slice(0, 300), busy: !!(v.queued || (v.status && v.status.state === 'running')) };
}

function deleteReceiptRow_(body, user, kind) {
  var K = kindOf_(kind), isRet = K === KINDS.ret;
  var sub = String(body.kind || '');
  if (sub === 'pending') {   // 還沒寫進 Excel 的排隊中項目:直接移除,之後就不會寫入
    var id = String(body.id || '').trim();
    if (!id || props_().getProperty(K.prefix + id) === null) {
      return { ok: false, error: '這筆已經寫入 Excel(或已不存在),請重新開啟清單後再刪除' };
    }
    props_().deleteProperty(K.prefix + id);
    return { ok: true, removed: true };
  }
  if (sub !== 'sheet') return { ok: false, error: '不支援的動作' };

  var po = clip_(body.po, 32), code = clip_(body.code, 32);
  if (!code) return { ok: false, error: '缺少品號' };   // 採購單號可以是空白(沒有採購單的列也要能刪除)
  var v = puriView_(kind);
  if (v.queued || (v.status && v.status.state === 'running')) {
    return { ok: false, error: K.label + '簽核請求已送出或正在執行,現在不能刪除清單' };
  }
  var dt = isRet ? clip_(body.docType, 12) : '', dn = isRet ? clip_(body.docNo, 24) : '';
  var key = rowKey_(body.vendor, po, code, body.qty, docKey_(dt, dn));
  var snap = readJson_(K.snapKey);
  var have = snap && Array.isArray(snap.rows)
    ? snap.rows.filter(function (r) { return rowKey_(r.v, r.p, r.c, r.q, docKey_(r.dt, r.dn)) === key; }).length : 0;
  if (!have) return { ok: false, error: '清單已更新,找不到這筆,請重新開啟清單' };
  var dels = listDeletes_(kind);
  var already = dels.filter(function (d) { return rowKey_(d.vendor, d.po, d.code, d.qty, docKey_(d.docType, d.docNo)) === key; }).length;
  if (already >= have) return { ok: false, error: '這筆已經在刪除中' };
  if (dels.length >= MAX_DELETES) return { ok: false, error: '待處理的刪除過多,請稍後再試' };

  var ts = Date.now();
  var did = ts + '_' + Math.random().toString(36).slice(2, 8);
  var rec = { id: did, ts: ts, by: user.email, vendor: clip_(body.vendor, 20), po: po, code: code, qty: Number(body.qty) || 0 };
  if (isRet) { rec.docType = dt; rec.docNo = dn; }
  props_().setProperty(K.delPrefix + did, JSON.stringify(rec));
  return { ok: true, queued: true };
}

// ---------- 待簽核表單 ----------
// 來源有兩種:(1) 同事把截圖貼到網頁上傳,電腦端辨識後送上來(signforms_push);(2) 網頁上手動輸入 / 修改(signforms_save)。
// 每張表單一個屬性 s_<id>:{id, ts, name 表單名稱, prog 程式代碼, docType 單別, docNo 單號, vendor 廠商, docName, src, conf, by, f 失敗原因}。
// 網頁勾選後按「確認」送出簽核請求(SIGN_REQ,同進貨單簽核的作法),由電腦上的 Claude 取走執行。

var SIGN_PREFIX = 's_';
var MAX_SIGN_FORMS = 200;
var MAX_SIGN_ITEMS = 40;   // 一次簽核請求最多幾張(請求存在單一屬性,有 9KB 上限)

function newId_() { return Date.now() + '_' + Math.random().toString(36).slice(2, 8); }

function listSignForms_() {
  var out = listByPrefix_(SIGN_PREFIX);
  out.sort(function (a, b) { return b.ts - a.ts; });   // 新的在前
  return out;
}

// 欄位檢查與清理;回傳 {error} 或 {rec 的欄位}
function cleanSignFields_(f) {
  var dt = clip_(f.docType, 6), dn = clip_(f.docNo, 16);
  if (!/^\d{3,6}$/.test(dt)) return { error: '單別必須是 3~6 位數字' };
  if (!/^\d{6,16}$/.test(dn)) return { error: '單號必須是 6~16 位數字(一般是 11 碼)' };
  var prog = clip_(f.prog, 10).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!prog) return { error: '請選擇表單名稱或填入程式代碼' };
  return { name: clip_(f.name, 30), prog: prog, docType: dt, docNo: dn, vendor: clip_(f.vendor, 30) };
}

function findSignForm_(all, prog, dt, dn, exceptId) {
  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    if (r.prog === prog && r.docType === dt && r.docNo === dn && r.id !== exceptId) return r;
  }
  return null;
}

// 辨識程式送上來的表單:同一張(程式代碼+單別+單號)再送只更新,不重複
function pushSignForms_(body, by) {
  var forms = Array.isArray(body.forms) ? body.forms : [];
  var all = listSignForms_();
  var imgRec = body.img ? readJson_(SIGNFILE_PREFIX + String(body.img)) : null;
  var now = Date.now(), added = 0, updated = 0, skipped = 0;
  forms.slice(0, 100).forEach(function (f) {
    if (!f) { skipped++; return; }
    var c = cleanSignFields_({ docType: f.docType, docNo: f.docNo, prog: f.prog || 'UNKNOWN', name: f.progName || f.name, vendor: f.vendor });
    if (c.error) { skipped++; return; }
    var old = findSignForm_(all, c.prog, c.docType, c.docNo, '');
    var rec = old || { id: newId_(), ts: now, n: 0, by: clip_(by, 60) };
    rec.name = c.name || rec.name || '';
    rec.prog = c.prog; rec.docType = c.docType; rec.docNo = c.docNo;
    rec.docName = clip_(f.docName, 20); rec.vendor = c.vendor || rec.vendor || ''; rec.src = clip_(f.src, 10);
    rec.conf = f.conf === 'low' ? 'low' : 'high';      // low = 辨識把握度不高,網站會標示請人工核對
    rec.seen = now; rec.n = (rec.n || 0) + 1;
    if (imgRec && !rec.imgUrl) { rec.imgId = imgRec.id; rec.imgUrl = imgRec.url; }   // 這張表單是從哪張截圖辨識出來的
    props_().setProperty(SIGN_PREFIX + rec.id, JSON.stringify(rec));
    if (old) updated++; else { added++; all.push(rec); queueSignNotify_(rec); }
  });
  all = listSignForms_();
  if (all.length > MAX_SIGN_FORMS) {   // 超過上限:刪掉最舊的
    all.slice(MAX_SIGN_FORMS).forEach(function (r) { props_().deleteProperty(SIGN_PREFIX + r.id); });
  }
  return { ok: true, added: added, updated: updated, skipped: skipped, total: Math.min(all.length, MAX_SIGN_FORMS) };
}

// 待簽核清單有新增項目時,先記在通知佇列(SIGN_NOTIFY);電腦端排程 pull 時取走,用釘釘機器人發通知(網址 / 金鑰只放在電腦端設定檔),
// 發送成功後呼叫 sign_notify_ack 清掉。佇列最多留 100 筆,超過就丟掉最舊的。
var SIGN_NOTIFY_KEY = 'SIGN_NOTIFY';
function queueSignNotify_(rec) {
  var q = readJson_(SIGN_NOTIFY_KEY) || [];
  q.push({ id: rec.id, ts: rec.ts, name: rec.name || '', prog: rec.prog, docType: rec.docType, docNo: rec.docNo, vendor: rec.vendor || '', by: rec.by || '', src: rec.src || '', img: rec.imgUrl || '' });
  if (q.length > 100) q = q.slice(q.length - 100);
  props_().setProperty(SIGN_NOTIFY_KEY, JSON.stringify(q));
}

function signNotifyAck_(idsCsv) {
  var ids = String(idsCsv || '').split(',').filter(String);
  var q = readJson_(SIGN_NOTIFY_KEY) || [];
  var left = q.filter(function (x) { return ids.indexOf(x.id) === -1; });
  if (left.length) props_().setProperty(SIGN_NOTIFY_KEY, JSON.stringify(left)); else props_().deleteProperty(SIGN_NOTIFY_KEY);
  return { ok: true, removed: q.length - left.length };
}

// ---------- 表單名稱 / 程式代碼對照清單(網頁「手動新增」下拉選單用;可在網頁編輯) ----------
// 沒編輯過是 null,網頁就用對照表 Excel(隨 data.enc 發布)的預設清單;編輯過就整份存在 SIGN_PROGS,
// 並隨 pull 帶回給電腦端,辨識程式也用這份校正標題列的程式代碼。編輯權限:管理者或 erp_sign。
var SIGN_PROGS_KEY = 'SIGN_PROGS';
var MAX_SIGN_PROGS = 100;
function getSignProgs_() { var v = readJson_(SIGN_PROGS_KEY); return Array.isArray(v) ? v : null; }

function saveSignProgs_(body) {
  var list = Array.isArray(body.progs) ? body.progs : null;
  if (!list) return { ok: false, error: '清單格式不正確' };
  if (list.length > MAX_SIGN_PROGS) return { ok: false, error: '最多 ' + MAX_SIGN_PROGS + ' 筆' };
  var out = [], seen = {};
  for (var i = 0; i < list.length; i++) {
    var x = list[i] || {};
    var name = clip_(x.name, 30).replace(/^\s+|\s+$/g, ''), code = String(x.code || '').replace(/\s+/g, '').toUpperCase();
    if (!name && !code) continue;   // 空白列略過
    if (!name) return { ok: false, error: '第 ' + (i + 1) + ' 列:表單名稱不可空白' };
    if (!/^[A-Z0-9]{4,10}$/.test(code)) return { ok: false, error: '第 ' + (i + 1) + ' 列:程式代碼要 4~10 碼英文字母或數字' };
    var k = name + '|' + code;
    if (seen[k]) continue;
    seen[k] = true;
    out.push({ name: name, code: code });
  }
  var raw = JSON.stringify(out);
  if (encodeURIComponent(raw).replace(/%[0-9A-F]{2}/g, 'x').length > 8500) return { ok: false, error: '清單太長(名稱請簡短一點)' };
  props_().setProperty(SIGN_PROGS_KEY, raw);
  return { ok: true, progs: out };
}

// 網頁上手動新增 / 修改一張(有 id 就是修改)
function saveSignForm_(body, user) {
  var c = cleanSignFields_(body);
  if (c.error) return { ok: false, error: c.error };
  var all = listSignForms_();
  var id = String(body.id || '');
  var rec;
  if (id) {
    rec = all.filter(function (r) { return r.id === id; })[0];
    if (!rec) return { ok: false, error: '這張已經不存在,請重新整理' };
  } else {
    if (all.length >= MAX_SIGN_FORMS) return { ok: false, error: '待簽核表單已達上限(' + MAX_SIGN_FORMS + ' 張),請先刪除不用的' };
    rec = { id: newId_(), ts: Date.now(), n: 1, by: user.email, src: '手動', conf: 'high' };
  }
  if (findSignForm_(all, c.prog, c.docType, c.docNo, rec.id)) return { ok: false, error: '這張表單已經在清單中了' };
  rec.name = c.name; rec.prog = c.prog; rec.docType = c.docType; rec.docNo = c.docNo; rec.vendor = c.vendor;
  if (id) { rec.conf = 'high'; rec.f = ''; }   // 人工確認過,不再標示辨識不確定 / 失敗
  props_().setProperty(SIGN_PREFIX + rec.id, JSON.stringify(rec));
  if (!id) queueSignNotify_(rec);   // 新增(不是修改)才通知
  return { ok: true, form: rec };
}

function deleteSignForm_(body) {
  if (body.all === true) {
    var n = 0;
    listSignForms_().forEach(function (r) { props_().deleteProperty(SIGN_PREFIX + r.id); n++; });
    return { ok: true, removed: n };
  }
  var id = String(body.id || '');
  if (!id || props_().getProperty(SIGN_PREFIX + id) === null) return { ok: false, error: '這筆已經不存在,請重新整理' };
  props_().deleteProperty(SIGN_PREFIX + id);
  return { ok: true, removed: 1 };
}

// 送出簽核請求:body.ids = 勾選的表單 id。請求內容(單別/單號等)在送出當下存成快照,執行期間再改清單也不影響
function requestSign_(body, user) {
  var v = puriView_('sign');
  if (v.queued) return { ok: false, error: '已有簽核請求排隊中,請稍候' };
  if (v.status && v.status.state === 'running') return { ok: false, error: '簽核正在執行中' };
  var ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  if (!ids.length) return { ok: false, error: '請先勾選要簽核的表單' };
  if (ids.length > MAX_SIGN_ITEMS) return { ok: false, error: '一次最多送出 ' + MAX_SIGN_ITEMS + ' 張' };
  var byId = {};
  listSignForms_().forEach(function (r) { byId[r.id] = r; });
  var items = [];
  for (var i = 0; i < ids.length; i++) {
    var r = byId[ids[i]];
    if (!r) return { ok: false, error: '有表單已經不存在,請重新整理後再勾選' };
    items.push({ id: r.id, name: r.name || '', prog: r.prog, docType: r.docType, docNo: r.docNo, vendor: r.vendor || '', img: r.imgUrl || '' });
  }
  props_().setProperty(KINDS.sign.reqKey, JSON.stringify({ ts: Date.now(), by: user.email, items: items }));
  return { ok: true, count: items.length };
}

// 電腦端已把請求裡的表單寫進 WMS.xlsx「待簽核清單」:從網站清單移除這幾張、清掉請求、狀態記為完成
function signAck_(ts, msg) {
  var req = readJson_(KINDS.sign.reqKey);
  if (!req) return { ok: true, removed: 0 };
  if (ts && String(req.ts) !== String(ts)) return { ok: false, error: '請求已變更' };
  var removed = 0;
  (req.items || []).forEach(function (it) {
    if (props_().getProperty(SIGN_PREFIX + it.id) !== null) { props_().deleteProperty(SIGN_PREFIX + it.id); removed++; }
  });
  props_().deleteProperty(KINDS.sign.reqKey);
  props_().setProperty(KINDS.sign.statusKey, JSON.stringify({ state: 'done', msg: clip_(msg, 300), ts: Date.now(), by: req.by || '' }));
  return { ok: true, removed: removed };
}

// 執行端(Claude)回報逐張結果:done 的從清單移除;failed 的留著並寫上失敗原因,網頁會標示
function signResult_(body) {
  var done = Array.isArray(body.done) ? body.done.map(String) : [];
  var failed = Array.isArray(body.failed) ? body.failed : [];
  var removed = 0, marked = 0;
  done.forEach(function (id) {
    if (props_().getProperty(SIGN_PREFIX + id) !== null) { props_().deleteProperty(SIGN_PREFIX + id); removed++; }
  });
  failed.forEach(function (x) {
    if (!x) return;
    var rec = readJson_(SIGN_PREFIX + String(x.id || ''));
    if (!rec) return;
    rec.f = '⚠ 失敗:' + clip_(x.reason, 60);
    props_().setProperty(SIGN_PREFIX + rec.id, JSON.stringify(rec));
    marked++;
  });
  return { ok: true, removed: removed, marked: marked };
}

// ---------- 截圖上傳(同事把截圖貼到網頁 -> 暫存 -> 電腦端取回辨識) ----------
// 圖片(base64)切成每段 90KB 放進 CacheService(最長保留 6 小時),狀態記在屬性 si_<id>。
// 電腦端排程約每分鐘 pull 一次,取走排隊中的圖片 -> 辨識 -> signforms_push -> signimg_report。

var SIGNIMG_PREFIX = 'si_';
var SIGNIMG_PART = 90000;
var SIGNIMG_MAX_B64 = 2200000;      // 約 1.6 MB 的圖片
var SIGNIMG_TTL = 21600;            // CacheService 上限 6 小時
var SIGNIMG_CLAIM_MS = 3 * 60 * 1000;
var MAX_SIGNIMG_PENDING = 20;
var KEEP_SIGNIMG = 30;

function signImgKey_(id, n) { return 'img_' + id + '_' + n; }

// 圖片暫存最長 6 小時(CacheService 到期會自動刪除)。超過這個時間還沒辨識完的,狀態改成「逾時」並確實清掉暫存;
// 狀態紀錄(很小,沒有圖片)保留 3 天後刪除。
function expireSignImages_(list) {
  var now = Date.now();
  list.forEach(function (r) {
    if ((r.state === 'queued' || r.state === 'processing') && now - r.ts > SIGNIMG_TTL * 1000) {
      var keys = [];
      for (var i = 0; i < (r.parts || 0); i++) keys.push(signImgKey_(r.id, i));
      if (keys.length) CacheService.getScriptCache().removeAll(keys);
      r.state = 'error'; r.msg = '逾時:超過 6 小時沒有辨識,圖片已自動刪除,請重新上傳'; r.doneAt = now;
      props_().setProperty(SIGNIMG_PREFIX + r.id, JSON.stringify(r));
    }
  });
  return list;
}

function listSignImages_() {
  var out = listByPrefix_(SIGNIMG_PREFIX);
  out.sort(function (a, b) { return b.ts - a.ts; });
  var now = Date.now();
  out = out.filter(function (r) {
    if (now - r.ts > 3 * 24 * 3600 * 1000) { props_().deleteProperty(SIGNIMG_PREFIX + r.id); return false; }   // 3 天前的狀態紀錄
    return true;
  });
  return expireSignImages_(out);
}

function uploadSignImage_(body, user) {
  var data = String(body.data || '');
  var m = data.match(/^data:[^;,]*;base64,/);
  if (m) data = data.slice(m[0].length);
  if (data.length < 200 || !/^[A-Za-z0-9+\/]+=*$/.test(data)) return { ok: false, error: '圖片資料不正確' };
  if (data.length > SIGNIMG_MAX_B64) return { ok: false, error: '圖片太大(上限約 1.6 MB),請只截取 ERP 視窗,不要截整個螢幕' };
  var all = listSignImages_();
  var pending = all.filter(function (r) { return r.state === 'queued' || r.state === 'processing'; }).length;
  if (pending >= MAX_SIGNIMG_PENDING) return { ok: false, error: '還有 ' + pending + ' 張圖片等待辨識,請稍後再傳' };
  var id = newId_();
  var parts = Math.ceil(data.length / SIGNIMG_PART);
  var obj = {};
  for (var i = 0; i < parts; i++) obj[signImgKey_(id, i)] = data.substr(i * SIGNIMG_PART, SIGNIMG_PART);
  CacheService.getScriptCache().putAll(obj, SIGNIMG_TTL);
  var rec = { id: id, ts: Date.now(), by: user.email, name: clip_(body.name, 40), parts: parts, size: data.length, state: 'queued', msg: '', n: 0 };
  props_().setProperty(SIGNIMG_PREFIX + id, JSON.stringify(rec));
  saveSignImageFile_(id, data, rec.ts, user.email);   // 另存一份到雲端硬碟(7 天),讓待簽核清單有圖片連結;失敗不影響辨識
  all.unshift(rec);
  all.slice(KEEP_SIGNIMG).forEach(function (r) { removeSignImage_(r); });   // 只留最近的狀態紀錄
  return { ok: true, id: id };
}

// ---------- 截圖存檔(Google 雲端硬碟「ATK/待簽核截圖」,保留 7 天,到期移到垃圾桶並清掉清單上的連結) ----------
// 需要雲端硬碟授權:第一次請在 Apps Script 編輯器執行 authorizeDrive() 並同意授權;沒授權時只是沒有圖片連結,其他功能照常。
var SIGNFILE_PREFIX = 'sf_';
var SIGNFILE_DAYS = 7;
var SIGNFILE_FOLDER = '待簽核截圖';
var SIGNFILE_PURGE_KEY = 'SIGNFILE_LAST_PURGE';

function signFolder_() {
  var it = DriveApp.getFoldersByName(SIGNFILE_FOLDER);
  if (it.hasNext()) return it.next();
  var p = DriveApp.getFoldersByName('ATK');
  var f = (p.hasNext() ? p.next() : DriveApp.getRootFolder()).createFolder(SIGNFILE_FOLDER);
  try { f.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* 網域不允許就只有擁有者能開 */ }
  return f;
}

// 在編輯器手動執行一次,取得雲端硬碟授權並建立資料夾
function authorizeDrive() { return signFolder_().getUrl(); }

function imageMime_(b64) {
  return b64.indexOf('/9j/') === 0 ? 'image/jpeg' : b64.indexOf('UklGR') === 0 ? 'image/webp' : 'image/png';
}

function saveSignImageFile_(id, b64, ts, email) {
  try {
    var mime = imageMime_(b64), ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    var who = String(email || '').split('@')[0].replace(/[^A-Za-z0-9_.-]/g, '');
    var name = Utilities.formatDate(new Date(ts), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '_' + who + '_' + id + '.' + ext;
    var file = signFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(b64), mime, name));
    try { file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* 同上 */ }
    var rec = { id: id, fileId: file.getId(), url: file.getUrl(), ts: ts, by: email };
    props_().setProperty(SIGNFILE_PREFIX + id, JSON.stringify(rec));
    return rec;
  } catch (e) {
    return null;
  }
}

// 超過保留天數的截圖:檔案移到垃圾桶、紀錄刪除、清單上對應的連結清空。每小時最多做一次(由 pull 帶動)
function purgeSignFiles_() {
  var now = Date.now(), last = Number(props_().getProperty(SIGNFILE_PURGE_KEY) || 0);
  if (now - last < 3600 * 1000) return 0;
  props_().setProperty(SIGNFILE_PURGE_KEY, String(now));
  var old = listByPrefix_(SIGNFILE_PREFIX).filter(function (r) { return now - r.ts > SIGNFILE_DAYS * 24 * 3600 * 1000; });
  if (!old.length) return 0;
  var gone = {};
  old.forEach(function (r) {
    try { DriveApp.getFileById(r.fileId).setTrashed(true); } catch (e) { /* 檔案已被刪除或沒授權 */ }
    props_().deleteProperty(SIGNFILE_PREFIX + r.id);
    gone[r.id] = true;
  });
  listSignForms_().forEach(function (f) {
    if (f.imgId && gone[f.imgId]) { delete f.imgId; delete f.imgUrl; props_().setProperty(SIGN_PREFIX + f.id, JSON.stringify(f)); }
  });
  return old.length;
}

function removeSignImage_(rec) {
  var keys = [];
  for (var i = 0; i < (rec.parts || 0); i++) keys.push(signImgKey_(rec.id, i));
  if (keys.length) CacheService.getScriptCache().removeAll(keys);
  props_().deleteProperty(SIGNIMG_PREFIX + rec.id);
}

// 電腦端 pull 時呼叫:取走排隊中的圖片(標記處理中;處理中超過 3 分鐘沒回報的視為失敗重來)
function claimSignImages_() {
  var now = Date.now(), out = [];
  listSignImages_().forEach(function (r) {
    if (r.state === 'queued' || (r.state === 'processing' && now - (r.claimedAt || 0) > SIGNIMG_CLAIM_MS)) {
      r.state = 'processing'; r.claimedAt = now;
      props_().setProperty(SIGNIMG_PREFIX + r.id, JSON.stringify(r));
      out.push({ id: r.id, parts: r.parts, by: r.by, ts: r.ts, name: r.name });
    }
  });
  return out.reverse();   // 舊的先處理
}

function getSignImagePart_(id, n) {
  var v = CacheService.getScriptCache().get(signImgKey_(String(id), parseInt(n, 10)));
  if (v === null) return { ok: false, error: '圖片已過期或不存在' };
  return { ok: true, data: v };
}

function reportSignImage_(id, state, msg, n) {
  var rec = readJson_(SIGNIMG_PREFIX + String(id));
  if (!rec) return { ok: false, error: '找不到這張圖片' };
  if (['done', 'error'].indexOf(state) === -1) return { ok: false, error: '狀態不正確' };
  var keys = [];
  for (var i = 0; i < (rec.parts || 0); i++) keys.push(signImgKey_(rec.id, i));
  if (keys.length) CacheService.getScriptCache().removeAll(keys);   // 辨識完就不需要圖片了
  rec.state = state; rec.msg = clip_(msg, 120); rec.n = parseInt(n, 10) || 0; rec.doneAt = Date.now();
  props_().setProperty(SIGNIMG_PREFIX + rec.id, JSON.stringify(rec));
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

    // 電腦端回報「收料」工作表內容(用同步金鑰,不是登入工作階段)
    // 電腦端截圖辨識程式送上待簽核表單(用同步金鑰)
    if (action === 'signforms_push') {
      var kerr2 = checkSyncKey_(body.key);
      if (kerr2) return json_({ ok: false, error: kerr2 });
      return json_(pushSignForms_(body, body.by || body.source || '辨識程式'));
    }
    if (action === 'receipts_snapshot' || action === 'returns_snapshot') {
      var kerr = checkSyncKey_(body.key);
      if (kerr) return json_({ ok: false, error: kerr });
      return json_(saveSnapshot_(body, action === 'returns_snapshot' ? 'ret' : 'receipt'));
    }

    var me = checkSession_(body.session);
    if (!me) return json_({ ok: false, needLogin: true, error: '登入已失效,請重新登入' });

    // 目前的權限(管理者可能在登入後才調整,前端開啟時會用這個更新)
    if (action === 'me') {
      var ns = makeSession_(me.email);   // 每次開啟網頁順延有效期,沒登出就不必重新登入
      return json_({ ok: true, email: me.email, name: me.name, isAdmin: me.isAdmin, perms: me.perms, session: ns.token, exp: ns.exp });
    }

    if (action === 'pending') return json_({ ok: true, pending: listPending_() });
    if (action === 'save') {
      if (!me.perms.edit) return denied_('儲位編輯');
      return json_(saveEdit_(body, me));
    }
    if (action === 'receive') {
      if (!me.perms.receive) return denied_('收料');
      return json_(saveReceipt_(body, me, 'receipt'));
    }
    if (action === 'return') {
      if (!me.perms.ret) return denied_('退料');
      return json_(saveReceipt_(body, me, 'ret'));
    }
    if (action === 'wms_status' || action === 'wms_update') {
      if (!me.perms.erp_wms) return denied_('WMS更新');
      return json_(action === 'wms_update' ? requestWmsUpdate_(me) : wmsView_());
    }
    if (action === 'receipt_pending') {   // 物料明細的收料鍵要不要變黃:哪些(採購單, 品號)已收料、還沒做進貨單簽核
      if (!me.perms.receive && !me.perms.erp_receipt) return denied_('收料');
      return json_(receiptPendingView_());
    }
    if (action === 'receipt_list') {
      if (!me.perms.erp_receipt) return denied_('進貨單簽核');
      return json_(receiptListView_('receipt'));
    }
    if (action === 'receipt_delete') {
      if (!me.perms.erp_receipt) return denied_('進貨單簽核');
      return json_(deleteReceiptRow_(body, me, 'receipt'));
    }
    if (action === 'puri09_status' || action === 'puri09_request') {
      if (!me.perms.erp_receipt) return denied_('進貨單簽核');
      return json_(action === 'puri09_request' ? requestPuri_(me, 'receipt') : puriView_('receipt'));
    }
    if (action.indexOf('sign') === 0 && ['signprogs_get', 'signprogs_save', 'signprogs_reset', 'signforms_list', 'signforms_save', 'signforms_delete', 'sign_status', 'sign_request',
        'signimg_upload', 'signimg_list'].indexOf(action) !== -1) {
      // 待簽核表單頁面所有登入同仁都能用(看清單、上傳截圖、編輯、刪除);erp_sign 權限只管「確認」鍵(sign_request)
      if (action === 'sign_request' && !me.perms.erp_sign) return denied_('待簽核表單確認');
      if (action === 'signprogs_get') return json_({ ok: true, progs: getSignProgs_() });
      if (action === 'signprogs_save' || action === 'signprogs_reset') {
        if (!me.perms.admin && !me.perms.erp_sign) return denied_('編輯表單清單');
        if (action === 'signprogs_reset') { props_().deleteProperty(SIGN_PROGS_KEY); return json_({ ok: true, progs: null }); }
        return json_(saveSignProgs_(body));
      }
      if (action === 'signforms_list') return json_({ ok: true, forms: listSignForms_() });
      if (action === 'signforms_save') return json_(saveSignForm_(body, me));
      if (action === 'signforms_delete') return json_(deleteSignForm_(body));
      if (action === 'sign_status') return json_(puriView_('sign'));
      if (action === 'sign_request') return json_(requestSign_(body, me));
      if (action === 'signimg_upload') return json_(uploadSignImage_(body, me));
      return json_({ ok: true, images: listSignImages_().slice(0, 12).map(function (r) {
        return { id: r.id, ts: r.ts, by: r.by, name: r.name, state: r.state, msg: r.msg, n: r.n };
      }) });
    }
    if (action === 'return_list') {
      if (!me.perms.erp_return) return denied_('退貨單簽核');
      return json_(receiptListView_('ret'));
    }
    if (action === 'return_delete') {
      if (!me.perms.erp_return) return denied_('退貨單簽核');
      return json_(deleteReceiptRow_(body, me, 'ret'));
    }
    if (action === 'ret_status' || action === 'ret_request') {
      if (!me.perms.erp_return) return denied_('退貨單簽核');
      return json_(action === 'ret_request' ? requestPuri_(me, 'ret') : puriView_('ret'));
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
        p.action === 'puri09_claim' || p.action === 'puri09_report' || p.action === 'ret_claim' || p.action === 'ret_report' ||
        p.action === 'sign_claim' || p.action === 'sign_report' || p.action === 'sign_ack' || p.action === 'sign_notify_ack' || p.action === 'signimg_get' || p.action === 'signimg_report') {
      var err = checkSyncKey_(p.key);
      if (err) return json_({ ok: false, error: err });

      if (p.action === 'puri09_claim') return json_(puriClaim_('receipt'));
      if (p.action === 'puri09_report') return json_(puriReport_(String(p.state || ''), p.msg, 'receipt'));
      if (p.action === 'ret_claim') return json_(puriClaim_('ret'));
      if (p.action === 'ret_report') return json_(puriReport_(String(p.state || ''), p.msg, 'ret'));
      if (p.action === 'sign_claim') return json_(puriClaim_('sign'));
      if (p.action === 'sign_ack') return json_(signAck_(p.ts, p.msg));
      if (p.action === 'sign_notify_ack') return json_(signNotifyAck_(p.ids));
      if (p.action === 'sign_report') {
        var sres = puriReport_(String(p.state || ''), p.msg, 'sign');
        if (sres.ok && (p.done || p.failed)) {   // 逐張結果(done=id 以逗號分隔;failed=id:原因;id:原因)
          var failedList = String(p.failed || '').split(';').filter(String).map(function (x) {
            var k = x.indexOf(':'); return { id: k < 0 ? x : x.slice(0, k), reason: k < 0 ? '' : x.slice(k + 1) };
          });
          signResult_({ done: String(p.done || '').split(',').filter(String), failed: failedList });
        }
        return json_(sres);
      }
      if (p.action === 'signimg_get') return json_(getSignImagePart_(p.id, p.n));
      if (p.action === 'signimg_report') return json_(reportSignImage_(p.id, String(p.state || ''), p.msg, p.n));

      if (p.action === 'pull') return json_({
        ok: true, edits: listPending_(), receipts: listReceipts_('receipt'), deletes: listDeletes_('receipt'),
        returns: listReceipts_('ret'), returnDeletes: listDeletes_('ret'), signImages: claimSignImages_(), signFilesPurged: purgeSignFiles_(), signRequest: readJson_(KINDS.sign.reqKey),
        signProgs: getSignProgs_(), signNotify: readJson_(SIGN_NOTIFY_KEY) || [], signTotal: listSignForms_().length,
        wms: readJson_(WMS_REQ_KEY), schedules: getSchedules_()
      });

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
        [PREFIX, KINDS.receipt.prefix, KINDS.receipt.delPrefix, KINDS.ret.prefix, KINDS.ret.delPrefix].forEach(function (pre) {
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
