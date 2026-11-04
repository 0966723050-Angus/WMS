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

// 目前仍在名單內(且啟用)的使用者;管理者永遠有效
function userFor_(email) {
  var admin = normEmail_(props_().getProperty('ADMIN_EMAIL'));
  var raw = props_().getProperty(USER_PREFIX + email);
  var u = null;
  try { u = raw ? JSON.parse(raw) : null; } catch (err) { u = null; }
  if (admin && email === admin) return { email: email, name: (u && u.name) || '管理者', isAdmin: true };
  if (u && u.enabled !== false) return { email: email, name: u.name || '', isAdmin: false };
  return null;
}

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
      out.push({ email: k.slice(USER_PREFIX.length), name: u.name || '', enabled: u.enabled !== false, addedAt: u.addedAt || 0 });
    } catch (err) { /* 略過壞資料 */ }
  });
  out.sort(function (a, b) { return a.email < b.email ? -1 : a.email > b.email ? 1 : 0; });
  return out;
}

function putUser_(email, name, enabled, addedAt) {
  props_().setProperty(USER_PREFIX + email, JSON.stringify({ name: clip_(name, 80), enabled: enabled !== false, addedAt: addedAt || Date.now() }));
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
      putUser_(email, it.name, true);
      have[email] = true;
      added++;
    });
    return { ok: true, added: added, skipped: skipped, users: listUsers_() };
  }

  var email0 = normEmail_(body.email);
  var raw = p.getProperty(USER_PREFIX + email0);
  if (!raw) return { ok: false, error: '名單中找不到此帳號' };
  var old = JSON.parse(raw);

  if (body.action === 'admin_delete') {
    p.deleteProperty(USER_PREFIX + email0);
    return { ok: true, users: listUsers_() };
  }

  if (body.action === 'admin_update') {
    var newEmail = body.newEmail ? normEmail_(body.newEmail) : email0;
    if (!isEmail_(newEmail)) return { ok: false, error: 'Email 格式不正確' };
    if (newEmail !== email0 && p.getProperty(USER_PREFIX + newEmail)) return { ok: false, error: '新的 Email 已在名單中' };
    var enabled = body.enabled === undefined ? old.enabled !== false : !!body.enabled;
    if (newEmail !== email0) p.deleteProperty(USER_PREFIX + email0);
    putUser_(newEmail, body.name === undefined ? old.name : body.name, enabled, old.addedAt);
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
      return json_({ ok: true, email: user.email, name: user.name || info.name, isAdmin: user.isAdmin, key: key, session: s.token, exp: s.exp });
    }

    var me = checkSession_(body.session);
    if (!me) return json_({ ok: false, needLogin: true, error: '登入已失效,請重新登入' });

    if (action === 'pending') return json_({ ok: true, pending: listPending_() });
    if (action === 'save') return json_(saveEdit_(body, me));
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
    if (p.action === 'pull' || p.action === 'ack' || p.action === 'set_data_key') {
      var err = checkSyncKey_(p.key);
      if (err) return json_({ ok: false, error: err });

      if (p.action === 'pull') return json_({ ok: true, edits: listPending_() });

      if (p.action === 'set_data_key') {
        if (!/^[A-Za-z0-9+\/]{43}=$/.test(String(p.dataKey || ''))) return json_({ ok: false, error: '金鑰格式不正確' });
        props_().setProperty('DATA_KEY', p.dataKey);
        return json_({ ok: true });
      }

      var removed = 0;
      String(p.ids || '').split(',').forEach(function (id) {
        id = id.trim();
        if (id && props_().getProperty(PREFIX + id) !== null) {
          props_().deleteProperty(PREFIX + id);
          removed++;
        }
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
