(function () {
  "use strict";

  var state = {
    data: null,
    orderIndex: null, // orderNo -> { project, order }
  };

  // per-order search / status-filter state, keyed by orderNo (used by the standalone order page)
  var materialFilterState = {};
  // per-project search / status-filter state, keyed by project code (used by the project page)
  var projectFilterState = {};

  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function fmtNum(v) {
    if (v === null || v === undefined || v === "") return "";
    var n = Number(v);
    if (isNaN(n)) return esc(v);
    return n.toLocaleString("zh-Hant");
  }

  function joinLines(arr) {
    if (!arr || !arr.length) return "";
    return arr.join("\n");
  }

  function statusPillClass(status) {
    if (status === "已到料") return "status-arrived";
    if (status === "未到料") return "status-pending";
    return "status-neutral";
  }

  // 某製令下物料的到料狀況:已到料項數 / 未到料項數
  function arrivalCounts(orderNo) {
    var arrived = 0, pending = 0;
    (state.data.materials[orderNo] || []).forEach(function (r) {
      if (r.arrivalStatus === "已到料") arrived++; else pending++;
    });
    return { arrived: arrived, pending: pending };
  }

  function buildOrderIndex(data) {
    var idx = {};
    data.projects.forEach(function (p) {
      p.orders.forEach(function (o) {
        idx[o.orderNo] = { project: p, order: o };
      });
    });
    return idx;
  }

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function getFilterState(orderNo) {
    if (!materialFilterState[orderNo]) {
      materialFilterState[orderNo] = { query: "", status: "", issueStatus: "", poStatus: "" };
    }
    return materialFilterState[orderNo];
  }

  function getProjectFilterState(code) {
    if (!projectFilterState[code]) {
      projectFilterState[code] = { query: "", status: "", issueStatus: "", poStatus: "" };
    }
    return projectFilterState[code];
  }

  function sectionIds(orderNo) {
    return {
      count: "count-" + orderNo,
      container: "container-" + orderNo,
    };
  }

  function filterRows(rows, f) {
    var q = f.query.trim().toLowerCase();
    var status = f.status;
    var issueStatus = f.issueStatus;
    var poStatus = f.poStatus || "";
    return rows.filter(function (r) {
      if (status && r.arrivalStatus !== status) return false;
      if (issueStatus === "未領" && !(r.remainQty > 0)) return false;
      if (issueStatus === "已領" && !(r.remainQty <= 0)) return false;
      if (poStatus) {
        // 已下單 = 採購單號欄位有值;未下單 = 庫存量 < 需求量,且採購單號欄位是空白
        var hasPo = (r.poNos || []).some(function (x) { return String(x).trim() !== ""; });
        if (poStatus === "已下單" && !hasPo) return false;
        if (poStatus === "未下單" && !(!hasPo && Number(r.stockQty || 0) < Number(r.needQty || 0))) return false;
      }
      if (!q) return true;
      var haystack = [
        r.materialCode, r.materialName, r.spec, r.materialType,
        joinLines(r.poNos), joinLines(r.vendors), joinLines(r.etas), r.arrivalStatus
      ].join(" ").toLowerCase();
      return haystack.indexOf(q) !== -1;
    });
  }

  // ---------- Login (Google) / session / encrypted data ----------

  var SESSION_KEY = "wms_session";
  var session = null; // { email, name, isAdmin, key, session, exp }

  function cfg() { return window.WMS_CONFIG || {}; }

  function editEndpoint() { return cfg().editEndpoint || ""; }

  // 權限項目(帳號設定的勾選項目;伺服器端也會逐項檢查)
  var PERM_DEFS = [
    { key: "admin", label: "名單管理" },
    { key: "edit", label: "儲位編輯" },
    { key: "receive", label: "收料" },
    { key: "ret", label: "退料" },
    { key: "erp_receipt", label: "ERP:進貨單簽核" },
    { key: "erp_return", label: "ERP:退貨單簽核" },
    { key: "erp_sign", label: "ERP:待簽核表單確認" },
    { key: "erp_wms", label: "ERP:WMS更新" }
  ];
  var PERM_DEFAULT_NEW = { admin: false, edit: true, receive: true, ret: false, erp_receipt: false, erp_return: false, erp_sign: false, erp_wms: false };

  function can(perm) { return !!(session && session.perms && session.perms[perm]); }

  // 「待簽核表單」頁所有登入同仁都能進(權限 erp_sign 只管該頁的「確認」鍵),所以 ERP 頁一律可進
  function canSeeErp() { return !!session; }

  // 舊版登入資料沒有 perms:管理者視為全部權限,其他人視為只有儲位編輯
  function withPerms(s) {
    if (s && !s.perms) {
      s.perms = {};
      PERM_DEFS.forEach(function (d) { s.perms[d.key] = s.isAdmin ? true : !!PERM_DEFAULT_NEW[d.key]; });
    }
    return s;
  }

  function loadSession() {
    try {
      var s = JSON.parse(lsGet(SESSION_KEY) || "null");
      return s && s.exp > Date.now() + 60000 && s.key && s.session ? withPerms(s) : null;
    } catch (e) { return null; }
  }

  function setSession(s) {
    session = s;
    lsSet(SESSION_KEY, s ? JSON.stringify(s) : null);
  }

  function b64ToBytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // data.enc = nonce(12) + AES-256-GCM 密文+tag;解密後是 zlib 壓縮的 JSON
  function decryptData(buf, keyB64) {
    var bytes = new Uint8Array(buf);
    return crypto.subtle.importKey("raw", b64ToBytes(keyB64), { name: "AES-GCM" }, false, ["decrypt"])
      .then(function (key) {
        return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
      })
      .then(function (plain) {
        return JSON.parse(pako.inflate(new Uint8Array(plain), { to: "string" }));
      });
  }

  // 呼叫 Apps Script;服務偶爾回傳 HTML 而不是 JSON,自動重試一次
  function api(action, payload) {
    var body = JSON.stringify(Object.assign({ action: action, session: session && session.session }, payload || {}));
    function once() {
      return fetch(editEndpoint(), { method: "POST", body: body })
        .then(function (res) { return res.json(); });
    }
    return once()
      .catch(function (err) {
        if (err instanceof TypeError) throw err; // 網路問題不重試
        return once();
      })
      .catch(function (err) {
        if (err instanceof TypeError) throw new Error("無法連線到服務,請檢查網路");
        throw new Error("服務暫時無回應,請再試一次");
      })
      .then(function (res) {
        if (res.needLogin) {
          sessionExpired();
          throw new Error(res.error || "登入已失效,請重新登入");
        }
        return res;
      });
  }

  function sessionExpired() {
    setSession(null);
    state.data = null;
    showLogin("登入已失效,請重新登入");
  }

  function logout() {
    setSession(null);
    state.data = null;
    try { window.google && google.accounts.id.disableAutoSelect(); } catch (e) { /* 略過 */ }
    showLogin("");
  }

  function updateUserUi() {
    var info = document.getElementById("user-info");
    var adminBtn = document.getElementById("admin-btn");
    document.body.classList.toggle("logged-out", !session);
    var erpBtn = document.getElementById("erp-btn");
    if (adminBtn) adminBtn.hidden = !can("admin");
    if (erpBtn) erpBtn.hidden = !canSeeErp();
    var scanBtn = document.getElementById("scan-btn");
    if (scanBtn) scanBtn.hidden = !(session && can("receive") && isMobileDevice());
    if (!info) return;
    if (!session) { info.innerHTML = ""; return; }
    info.innerHTML = '已登入:' + esc(session.name || session.email) + ' (' + esc(session.email) + ') · <a href="#" id="logout-link">登出</a>';
    document.getElementById("logout-link").addEventListener("click", function (e) {
      e.preventDefault();
      logout();
    });
  }

  function loadGis(onReady, onFail) {
    if (window.google && google.accounts && google.accounts.id) return onReady();
    var s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = onReady;
    s.onerror = onFail;
    document.head.appendChild(s);
  }

  function showLogin(message) {
    updateUserUi();
    var app = document.getElementById("app");
    app.innerHTML =
      '<div class="login-card">' +
        '<img class="login-logo" src="icons/atk-logo.png" alt="ATK" />' +
        '<h1>Warehouse Management System</h1>' +
        '<p class="login-sub">僅限授權的 ATK 同仁使用<br>請以公司 Google 帳號登入</p>' +
        '<div id="g-btn" class="g-btn"></div>' +
        '<p class="login-msg" id="login-msg">' + esc(message || "") + '</p>' +
      '</div>';
    var msg = document.getElementById("login-msg");

    if (!cfg().googleClientId || !editEndpoint()) {
      msg.textContent = "登入功能尚未設定,請聯絡管理者";
      return;
    }

    loadGis(function () {
      google.accounts.id.initialize({
        client_id: cfg().googleClientId,
        auto_select: true,
        cancel_on_tap_outside: false,
        callback: function (resp) { onGoogleCredential(resp, msg); }
      });
      google.accounts.id.renderButton(document.getElementById("g-btn"), {
        theme: "outline", size: "large", shape: "pill", text: "signin_with", locale: "zh-TW"
      });
      google.accounts.id.prompt();
    }, function () {
      msg.textContent = "無法載入 Google 登入元件,請檢查網路後重新整理";
    });
  }

  function onGoogleCredential(resp, msgEl) {
    msgEl.textContent = "驗證中…";
    api("auth", { idToken: resp.credential })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || "登入失敗");
        setSession(withPerms({ email: res.email, name: res.name, isAdmin: !!res.isAdmin, perms: res.perms, key: res.key, session: res.session, exp: res.exp }));
        startApp();
      })
      .catch(function (err) { msgEl.textContent = err.message; });
  }

  function startApp() {
    updateUserUi();
    render();
    loadData().then(render).catch(handleLoadError);
    refreshMe();
    startFailureWatch();
  }

  // 管理者可能在登入後才調整權限:開啟時向伺服器取得最新權限,有變動就更新畫面
  function refreshMe() {
    if (!session) return;
    api("me").then(function (res) {
      if (!res || !res.ok || !res.perms || !session) return;
      var changed = JSON.stringify(res.perms) !== JSON.stringify(session.perms);
      session.perms = res.perms;
      session.isAdmin = !!res.isAdmin;
      if (res.name) session.name = res.name;
      setSession(session);
      updateUserUi();
      if (changed && state.data) render();
    }).catch(function () { /* 讀不到就沿用目前權限;伺服器端仍會逐項檢查 */ });
  }

  function handleLoadError(err) {
    if (err && err.name === "OperationError") { // 解密失敗:資料金鑰已更換
      setSession(null);
      showLogin("資料金鑰已更新,請重新登入");
      return;
    }
    document.getElementById("app").innerHTML = '<div class="empty-state">資料載入失敗: ' + esc(err && err.message) + '</div>';
  }

  // ---------- Admin: 登入名單管理 ----------

  // 權限勾選方塊(新增帳號 / 編輯帳號共用)
  function permBoxesHtml(prefix, perms) {
    return '<div class="perm-grid">' + PERM_DEFS.map(function (d) {
      return '<label class="check perm-item"><input type="checkbox" data-perm="' + d.key + '" id="' + prefix + d.key + '"' +
        (perms && perms[d.key] ? ' checked' : '') + ' /> ' + esc(d.label) + '</label>';
    }).join("") + '</div>';
  }

  function readPerms(root) {
    var out = {};
    PERM_DEFS.forEach(function (d) {
      var box = root.querySelector('input[data-perm="' + d.key + '"]');
      out[d.key] = !!(box && box.checked);
    });
    return out;
  }

  function permSummaryHtml(perms) {
    var on = PERM_DEFS.filter(function (d) { return perms && perms[d.key]; });
    if (!on.length) return '<span class="perm-none">沒有任何功能權限(只能查詢)</span>';
    return on.map(function (d) { return '<span class="perm-chip">' + esc(d.label) + '</span>'; }).join("");
  }

  function renderAdmin(app) {
    if (!can("admin")) {
      location.hash = "#/";
      return;
    }
    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">首頁</a> / 登入名單管理</div>' +
      '<h1 class="page-title">登入名單管理<span class="sub">只有名單內的 Google 帳號可以登入網站;管理者:' + esc(session.email) + '</span></h1>' +
      '<div class="admin-card">' +
        '<h3>新增帳號</h3>' +
        '<textarea id="adm-new" rows="4" placeholder="每行一個帳號,姓名可省略\n例如:\nsomeone@atk.com.tw 王小明\nother@atk.com.tw"></textarea>' +
        '<div class="perm-title">這些帳號的權限(可之後再個別修改)</div>' +
        permBoxesHtml("new-", PERM_DEFAULT_NEW) +
        '<div class="admin-actions"><button type="button" class="btn" id="adm-add">新增</button></div>' +
        '<p class="modal-msg" id="adm-msg"></p>' +
      '</div>' +
      '<p class="result-count" id="adm-count"></p>' +
      '<div id="adm-list" class="admin-list"><div class="skeleton">載入中…</div></div>' +
      '<p class="admin-note">停用或刪除帳號後,該帳號立即不能再使用編輯與管理功能,下次登入就無法取得資料(已登入的裝置最長 24 小時後失效)。若要立即失效,請在電腦執行 <code>python scripts\\setup_auth.py --rotate</code> 更換資料金鑰。</p>';

    var msg = document.getElementById("adm-msg");

    document.getElementById("adm-add").addEventListener("click", function () {
      var users = document.getElementById("adm-new").value.split(/\r?\n/).map(function (line) {
        var m = line.trim().match(/^(\S+)\s*(.*)$/);
        return m ? { email: m[1], name: m[2] } : null;
      }).filter(Boolean);
      if (!users.length) { msg.textContent = "請輸入要新增的帳號"; return; }
      msg.textContent = "新增中…";
      api("admin_add", { users: users, perms: readPerms(app.querySelector(".admin-card")) }).then(function (res) {
        if (!res.ok) throw new Error(res.error || "新增失敗");
        document.getElementById("adm-new").value = "";
        msg.textContent = "已新增 " + res.added + " 個" + (res.skipped.length ? ";略過:" + res.skipped.join("、") : "");
        renderAdminList(res.users);
      }).catch(function (err) { msg.textContent = err.message; });
    });

    document.getElementById("adm-list").addEventListener("click", function (e) {
      var btn = e.target.closest ? e.target.closest("button[data-act]") : null;
      if (!btn) return;
      var email = btn.getAttribute("data-email");
      var act = btn.getAttribute("data-act");
      var user = adminUsers.filter(function (u) { return u.email === email; })[0];
      if (!user) return;
      if (act === "edit") return openUserDialog(user);
      if (act === "toggle") return adminCall("admin_update", { email: email, enabled: !user.enabled }).catch(function () {});
      if (act === "delete" && window.confirm("確定要刪除 " + email + " ?\n刪除後此帳號將無法再登入。")) {
        adminCall("admin_delete", { email: email }).catch(function () {});
      }
    });

    api("admin_list").then(function (res) {
      if (!res.ok) throw new Error(res.error || "讀取名單失敗");
      renderAdminList(res.users);
    }).catch(function (err) {
      document.getElementById("adm-list").innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
    });
  }

  var adminUsers = [];

  function adminCall(action, payload) {
    return api(action, payload).then(function (res) {
      if (!res.ok) throw new Error(res.error || "操作失敗");
      renderAdminList(res.users);
      return res;
    }).catch(function (err) { showToast(err.message); throw err; });
  }

  function renderAdminList(users) {
    adminUsers = users || [];
    var countEl = document.getElementById("adm-count");
    var list = document.getElementById("adm-list");
    if (!list) return;
    if (countEl) countEl.textContent = "共 " + adminUsers.length + " 個授權帳號(不含管理者)";
    if (!adminUsers.length) {
      list.innerHTML = '<div class="empty-state">名單是空的,目前只有管理者可以登入</div>';
      return;
    }
    list.innerHTML = adminUsers.map(function (u) {
      return (
        '<div class="material-card admin-user' + (u.enabled ? '' : ' disabled') + '">' +
          '<div class="material-card-top">' +
            '<div><div class="material-code">' + esc(u.email) + '</div>' +
            '<div class="material-spec">' + esc(u.name || "(未填姓名)") + '</div></div>' +
            '<span class="status-pill ' + (u.enabled ? 'status-arrived' : 'status-neutral') + '">' + (u.enabled ? '啟用' : '停用') + '</span>' +
          '</div>' +
          '<div class="perm-summary">' + permSummaryHtml(u.perms) + '</div>' +
          '<div class="admin-actions">' +
            '<button type="button" class="btn btn-secondary btn-sm" data-act="edit" data-email="' + esc(u.email) + '">編輯</button>' +
            '<button type="button" class="btn btn-secondary btn-sm" data-act="toggle" data-email="' + esc(u.email) + '">' + (u.enabled ? '停用' : '啟用') + '</button>' +
            '<button type="button" class="btn btn-secondary btn-sm btn-danger" data-act="delete" data-email="' + esc(u.email) + '">刪除</button>' +
          '</div>' +
        '</div>'
      );
    }).join("");
  }

  function openUserDialog(user) {
    var modal = el(
      '<div class="modal-backdrop">' +
        '<div class="modal" role="dialog" aria-modal="true">' +
          '<h2>編輯帳號</h2>' +
          '<label>Google 帳號(Email)<input type="text" id="usr-email" maxlength="48" value="' + esc(user.email) + '" /></label>' +
          '<label>姓名/備註<input type="text" id="usr-name" maxlength="80" value="' + esc(user.name) + '" /></label>' +
          '<label class="check"><input type="checkbox" id="usr-enabled"' + (user.enabled ? ' checked' : '') + ' /> 啟用(取消勾選即停用)</label>' +
          '<div class="perm-title">權限</div>' +
          permBoxesHtml("usr-", user.perms) +
          '<p class="modal-msg" id="usr-msg"></p>' +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn-secondary" id="usr-cancel">取消</button>' +
            '<button type="button" class="btn" id="usr-save">儲存</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
    document.body.appendChild(modal);
    function close() { if (modal.parentNode) modal.parentNode.removeChild(modal); }
    modal.querySelector("#usr-cancel").addEventListener("click", close);
    modal.querySelector("#usr-save").addEventListener("click", function () {
      var newEmail = modal.querySelector("#usr-email").value.trim();
      var btn = modal.querySelector("#usr-save");
      btn.disabled = true;
      adminCall("admin_update", {
        email: user.email,
        newEmail: newEmail,
        name: modal.querySelector("#usr-name").value.trim(),
        enabled: modal.querySelector("#usr-enabled").checked,
        perms: readPerms(modal)
      }).then(close).catch(function (err) {
        modal.querySelector("#usr-msg").textContent = err.message;
        btn.disabled = false;
      });
    });
  }

  // ---------- Routing ----------

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, "");
    var parts = h.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 0) return { view: "home" };
    if (parts[0] === "project" && parts[1]) return { view: "project", code: parts[1] };
    if (parts[0] === "order" && parts[1]) return { view: "order", orderNo: parts[1] };
    if (parts[0] === "storage") return { view: "storage" };
    if (parts[0] === "admin") return { view: "admin" };
    if (parts[0] === "erp") return { view: "erp", sub: parts[1] || "" };
    return { view: "home" };
  }

  function render() {
    signPage = null;      // 離開(或重新畫)待簽核表單頁就不再接收貼上的截圖
    if (!session) return; // 尚未登入時只顯示登入畫面
    var route = parseHash();
    var app = document.getElementById("app");
    if (!state.data) {
      app.innerHTML = '<div class="skeleton">載入資料中…</div>';
      return;
    }
    recvRows = [];      // 每次重畫重新編號收料鈕
    recvOrderOf = null; // 資料可能重新載入,製令對照表重建
    // 含物料表格的頁面(專案/製令)在寬螢幕上用較寬的版面,避免出現左右捲軸
    app.classList.toggle("app-wide", route.view === "project" || route.view === "order");
    // 功能列:目前所在頁面的按鍵反白
    var navOf = { storage: "storage-btn", erp: "erp-btn", admin: "admin-btn" };
    var activeNav = navOf[route.view] || "home-btn";
    ["home-btn", "storage-btn", "erp-btn", "admin-btn"].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.classList.toggle("active", id === activeNav);
    });
    if (route.view === "project") {
      renderProject(app, route.code);
    } else if (route.view === "order") {
      renderOrder(app, route.orderNo);
    } else if (route.view === "storage") {
      renderStorage(app);
    } else if (route.view === "admin") {
      renderAdmin(app);
    } else if (route.view === "erp") {
      renderErp(app, route.sub);
    } else {
      renderHome(app);
    }
    window.scrollTo(0, 0);
    updateHeaderHeightVar();
  }

  function updateHeaderHeightVar() {
    var header = document.querySelector(".sticky-head");
    if (header) {
      document.documentElement.style.setProperty("--header-height", header.offsetHeight + "px");
    }
    // 搜尋列固定在標題下方,表格欄位標題要再固定在搜尋列下方
    var toolbar = document.querySelector(".toolbar");
    document.documentElement.style.setProperty("--toolbar-height", (toolbar ? toolbar.offsetHeight : 0) + "px");

    // 表格放得下(不需要左右捲動)時,取消表格外框的捲動容器,欄位標題才能跟著頁面上下捲動固定
    var wraps = document.querySelectorAll(".table-wrap");
    for (var i = 0; i < wraps.length; i++) {
      wraps[i].classList.remove("fits");
      if (wraps[i].scrollWidth <= wraps[i].clientWidth + 1) wraps[i].classList.add("fits");
    }
  }

  // 篩選後表格內容會重新產生,內容變動時重新計算
  var stickyTimer = null;
  function scheduleStickyUpdate() {
    if (stickyTimer) return;
    stickyTimer = requestAnimationFrame(function () { stickyTimer = null; updateHeaderHeightVar(); });
  }

  // ---------- Home ----------

  var homeQuery = "";            // 首頁「物料搜尋」的關鍵字(離開再回來仍保留)
  var HOME_MAX_ROWS = 300;       // 關鍵字太短時結果可能上千筆,最多顯示 300 筆

  // 首頁搜尋結果:跨所有製令找出符合的物料,依製令分組,格式與「物料明細」相同(含收料鍵)
  function renderHomeResults() {
    var app = document.getElementById("app");
    var list = document.getElementById("project-list");
    var box = document.getElementById("home-results");
    var countEl = document.getElementById("home-result-count");
    if (!app || !list || !box) return;

    var q = homeQuery.trim();
    app.classList.toggle("app-wide", !!q); // 物料表格需要較寬的版面
    if (!q) {
      list.hidden = false;
      box.innerHTML = "";
      countEl.textContent = "";
      return;
    }
    list.hidden = true;

    var f = { query: q, status: "", issueStatus: "" };
    var total = 0, shown = 0, orders = 0, html = "";
    state.data.projects.forEach(function (p) {
      p.orders.forEach(function (o) {
        var rows = filterRows(state.data.materials[o.orderNo] || [], f);
        if (!rows.length) return;
        total += rows.length;
        orders++;
        if (shown >= HOME_MAX_ROWS) return;
        var take = rows.slice(0, HOME_MAX_ROWS - shown);
        shown += take.length;
        html +=
          '<section class="order-section">' +
            '<div class="order-section-head">' +
              '<div>' +
                '<a class="order-link" href="#/order/' + encodeURIComponent(o.orderNo) + '">' + esc(o.orderNo) + '</a>' +
                '<div class="hit-sub">' + esc(p.code) + ' · ' + esc(p.name) + '</div>' +
                '<div class="hit-sub hit-product">' + esc(o.productCode) + (o.productName ? ' · ' + esc(o.productName) : '') + '</div>' +
              '</div>' +
              '<span class="status-pill ' + statusPillClass(o.status) + '">' + esc(o.status || "-") + '</span>' +
            '</div>' +
            buildMaterialListHtml(take) +
          '</section>';
      });
    });

    if (!total) {
      countEl.textContent = "";
      box.innerHTML = '<div class="empty-state">查無符合的物料</div>';
      return;
    }
    countEl.textContent = "共 " + total + " 筆物料,分布在 " + orders + " 筆製令" +
      (total > shown ? ",僅顯示前 " + shown + " 筆,請輸入更完整的關鍵字縮小範圍" : "");
    box.innerHTML = html;
  }

  function renderHome(app) {
    var projects = state.data.projects;
    var totalOrders = projects.reduce(function (s, p) { return s + p.orders.length; }, 0);

    var html = '';
    html += '<h1 class="page-title">在線專案一覽表<span class="sub">共 ' + projects.length + ' 個專案 / ' + totalOrders + ' 筆製令</span></h1>';
    html += '<div class="toolbar">' +
      '<div class="search-wrap">' +
        '<input type="search" id="home-search" placeholder="搜尋所有製令的物料 (品號 / 規格 / 採購單號 / 廠商)" autocomplete="off" value="' + esc(homeQuery) + '" />' +
        '<button type="button" class="search-clear" id="home-clear" aria-label="清除搜尋"' + (homeQuery ? '' : ' hidden') + '>' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' +
      '</div>' +
    '</div>';
    html += '<p class="result-count" id="home-result-count"></p>';
    html += '<div id="home-results"></div>';
    html += '<div class="project-list" id="project-list"></div>';
    app.innerHTML = html;

    var homeInput = document.getElementById("home-search");
    var homeClear = document.getElementById("home-clear");
    homeInput.addEventListener("input", function (e) {
      homeQuery = e.target.value;
      homeClear.hidden = !homeQuery;
      renderHomeResults();
    });
    homeClear.addEventListener("click", function () {
      homeQuery = "";
      homeInput.value = "";
      homeClear.hidden = true;
      renderHomeResults();
      homeInput.focus();
    });

    var list = document.getElementById("project-list");
    projects.forEach(function (p) {
      var card = el(
        '<div class="project-card">' +
          '<div class="project-card-head">' +
            '<div class="project-card-main">' +
              '<a class="project-code-link" href="#/project/' + encodeURIComponent(p.code) + '">' + esc(p.code) + '</a>' +
              '<span class="project-name" title="' + esc(p.name) + '">' + esc(p.name) + '</span>' +
            '</div>' +
            '<div class="project-meta">' +
              '<span class="badge-count">' + p.orders.length + ' 筆製令</span>' +
              '<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg>' +
            '</div>' +
          '</div>' +
          '<div class="order-list"></div>' +
        '</div>'
      );

      var head = card.querySelector(".project-card-head");
      var codeLink = card.querySelector(".project-code-link");
      var orderList = card.querySelector(".order-list");

      // prevent the collapse toggle from firing when the code link itself is clicked
      codeLink.addEventListener("click", function (e) { e.stopPropagation(); });

      head.addEventListener("click", function () {
        var isOpen = card.classList.contains("open");
        if (!isOpen && !orderList.dataset.filled) {
          orderList.innerHTML = p.orders.map(function (o) {
            var c = arrivalCounts(o.orderNo);
            return (
              '<div class="order-row">' +
                '<div class="order-main">' +
                  '<a class="order-link" href="#/order/' + encodeURIComponent(o.orderNo) + '">' + esc(o.orderNo) + '</a>' +
                  '<span class="order-product" title="' + esc(o.productCode) + (o.productName ? " · " + esc(o.productName) : "") + '">' + esc(o.productCode) + (o.productName ? " · " + esc(o.productName) : "") + '</span>' +
                  '<span class="order-counts"><span class="cnt-ok">已到料:' + c.arrived + '項</span>' +
                    '<span class="cnt-pending">未到料:' + c.pending + '項</span></span>' +
                '</div>' +
                '<div class="order-right"><span class="status-pill ' + statusPillClass(o.status) + '">' + esc(o.status || "-") + '</span></div>' +
              '</div>'
            );
          }).join("");
          orderList.dataset.filled = "1";
        }
        card.classList.toggle("open");
      });

      list.appendChild(card);
    });

    renderHomeResults(); // 回到首頁時若還有搜尋關鍵字,直接顯示結果
  }

  // ---------- ERP 頁面(進貨單 / 製令領料單;功能建置中) ----------

  var ERP_ICONS = {
    // 進貨:箱子 + 向下箭頭
    receipt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/></svg>',
    // 領料:清單
    issue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v2h6V3M9 10h6M9 14h6M9 18h3"/></svg>',
    // 退貨:回復箭頭
    ret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/></svg>',
    // 待簽核表單:打勾的清單
    sign: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v2h6V3M9 13l2 2 4-4"/></svg>',
    // 更新:循環箭頭
    wms: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 01-14.3 4.9M4 12a8 8 0 0114.3-4.9"/><path d="M18.5 3v4.2h-4.2M5.5 21v-4.2h4.2"/></svg>'
  };

  var ERP_PAGES = {};   // 目前沒有「建置中」的空白頁

  // 「進貨單簽核」「退貨單簽核」:列出清單、確認後送出請求,由電腦上的 Claude 啟動對應的 skill 在鼎新 ERP 建立並確認單據。
  // 狀態(排隊中 / 執行中 / 完成 / 失敗)由電腦端回報,顯示在按鈕下方。兩者共用同一套畫面,依 kind 切換文字與 API。
  var PUR_KINDS = {
    receipt: {
      title: "進貨單簽核", sheet: "收料", what: "收料", doneWord: "已收料", doc: "進貨單", perm: "erp_receipt",
      listApi: "receipt_list", delApi: "receipt_delete", statusApi: "puri09_status", reqApi: "puri09_request",
      btnId: "puri09-btn", noteId: "puri09-note", failKey: "wms_fail_ack",
      intro: "已收料清單明細(WMS.xlsx「收料」工作表)。按「確認」後,會依這份清單在鼎新 ERP 進貨單建立作業(PURI09)逐張建立並確認,執行期間該電腦的畫面會被自動操作。"
    },
    ret: {
      title: "退貨單簽核", sheet: "退料", what: "退料", doneWord: "已退料", doc: "退貨單", perm: "erp_return",
      listApi: "return_list", delApi: "return_delete", statusApi: "ret_status", reqApi: "ret_request",
      btnId: "ret-btn", noteId: "ret-note", failKey: "wms_fail_ack_ret",
      intro: "已退料清單明細(WMS.xlsx「退料」工作表)。按「確認」後,會依這份清單在鼎新 ERP 逐張建立並確認退貨單,執行期間該電腦的畫面會被自動操作。"
    }
  };

  function puriStatusText(res) {
    var st = res.status, when = st && st.ts ? new Date(st.ts).toLocaleString("zh-TW", { hour12: false }) : "";
    if (res.queued) return { text: "已送出,等待電腦上的 Claude 排程啟動", busy: true };
    if (!st) return { text: "", busy: false };
    if (st.state === "running") return { text: "執行中(" + when + " 起)", busy: true };
    if (st.state === "done") return { text: "上次完成(" + when + ")" + (st.msg ? ":" + st.msg : ""), busy: false };
    return { text: "上次失敗(" + when + "):" + (st.msg || ""), busy: false };
  }

  function setupPuri09(kindKey) {
    var K = PUR_KINDS[kindKey || "receipt"];
    var btn = document.getElementById(K.btnId);
    var note = document.getElementById(K.noteId);
    if (!btn || !note) return;
    var timer = null;

    function refresh() {
      api(K.statusApi).then(function (res) {
        if (!document.body.contains(btn)) return; // 已離開此頁
        if (!res.ok) { note.textContent = res.error || ""; return; }
        var s = puriStatusText(res);
        note.textContent = s.text;
        btn.disabled = s.busy;
        btn.classList.toggle("is-busy", s.busy);
        clearTimeout(timer);
        if (s.busy) timer = setTimeout(refresh, 20000); // 進行中才持續更新狀態
      }).catch(function () { /* 讀不到狀態不影響使用 */ });
    }

    // 按下「進貨單簽核」/「退貨單簽核」:先列出已收料/已退料清單明細,按「確認」才送出請求
    btn.addEventListener("click", function () {
      openPuriListDialog(kindKey || "receipt", function () { refresh(); });
    });

    refresh();
  }

  function openPuriListDialog(kindKey, onSent) {
    kindKey = kindKey || "receipt";
    var K = PUR_KINDS[kindKey], isRet = kindKey === "ret";
    var modal = el(
      '<div class="modal-backdrop">' +
        '<div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="rcv-title">' +
          '<h2 id="rcv-title">' + esc(K.title) + '</h2>' +
          '<p class="rcv-intro">' + esc(K.intro) + '</p>' +
          '<div class="rcv-box" id="rcv-box"><div class="skeleton">載入清單中…</div></div>' +
          '<p class="modal-msg" id="rcv-msg"></p>' +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn-secondary" id="rcv-cancel">取消</button>' +
            '<button type="button" class="btn" id="rcv-ok" disabled>確認</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
    document.body.appendChild(modal);

    var box = modal.querySelector("#rcv-box"), msg = modal.querySelector("#rcv-msg"), okBtn = modal.querySelector("#rcv-ok");
    function close() {
      document.removeEventListener("keydown", onKey);
      if (modal.parentNode) modal.parentNode.removeChild(modal);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    modal.querySelector("#rcv-cancel").addEventListener("click", close);

    var curRows = [], curPend = [];

    function docText(r) { return isRet && r.dn ? ' · 進貨單 ' + esc((r.dt || "") + "-" + r.dn) : ""; }

    // kind: "sheet"(已寫入 Excel)/ "pending"(排隊中)/ "deleting"(已送出刪除,等電腦同步)
    function itemHtml(r, kind, idx) {
      var del = kind === "deleting";
      var failed = kind !== "pending" && isFailMark(r.f);
      return '<div class="rcv-item' + (kind === "pending" ? ' pending' : '') + (del ? ' deleting' : '') + (failed ? ' failed' : '') + '">' +
        '<div class="rcv-top"><span class="rcv-code">' + esc(r.c) + '</span>' +
          '<span class="rcv-qty">數量 ' + esc(fmtNum(r.q)) + '</span></div>' +
        (r.n ? '<div class="rcv-name">' + esc(r.n) + '</div>' : '') +
        '<div class="rcv-sub">' + esc(r.v) + ' · ' + esc(r.p) + docText(r) +
          (kind === "pending" ? ' <span class="pending-chip">待寫入 Excel</span>' : '') +
          (del ? ' <span class="pending-chip">刪除中,約 5 分鐘內同步到 Excel</span>' : '') + '</div>' +
        (failed ? '<div class="rcv-fail">' + esc(r.f) + '</div>' : '') +
        (del ? '' : '<button type="button" class="rcv-del" data-kind="' + kind + '" data-i="' + idx + '" aria-label="刪除這一筆">刪除</button>') +
      '</div>';
    }

    function load() {
      return api(K.listApi).then(function (res) {
        if (!res.ok) throw new Error(res.error || "讀取清單失敗");
        var snap = res.snapshot;
        curRows = (snap && snap.rows) || [];
        curPend = res.pending || [];
        var html = "";
        if (!snap) {
          html = '<div class="empty-state">尚無清單資料,電腦約每 5 分鐘同步一次,請稍後再試</div>';
        } else {
          var when = new Date(snap.ts).toLocaleString("zh-TW", { hour12: false });
          html += '<div class="rcv-count">共 ' + (snap.total || curRows.length) + ' 筆' + K.doneWord + '(清單更新:' + esc(when) + ')' +
            (snap.total > curRows.length ? ',僅列出前 ' + curRows.length + ' 筆' : '') + '</div>';
          html += curRows.length ? curRows.map(function (r, i) { return itemHtml(r, r.del ? "deleting" : "sheet", i); }).join("")
            : '<div class="empty-state">「' + esc(K.sheet) + '」工作表目前沒有資料</div>';
        }
        if (curPend.length) {
          html += '<div class="rcv-count rcv-warn">另有 ' + curPend.length + ' 筆剛送出、尚未寫入 Excel(約 5 分鐘內寫入),不會包含在這次' + esc(K.doc) + ':</div>' +
            curPend.map(function (r, i) { return itemHtml(r, "pending", i); }).join("");
        }
        box.innerHTML = html;
        var deleting = curRows.filter(function (r) { return r.del; }).length;
        var usable = curRows.length - deleting;
        okBtn.disabled = usable < 1 || deleting > 0;   // 有刪除還沒同步到 Excel 時,先不能確認(否則會把已刪除的列也建成單據)
        if (deleting) msg.textContent = "有 " + deleting + " 筆刪除正在同步到 Excel,同步完成後才能按「確認」(約 5 分鐘內,可重新開啟清單查看)";
        else if (msg.textContent.indexOf("正在同步") !== -1) msg.textContent = "";
      }).catch(function (err) {
        if (!session) { close(); return; }
        box.innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
      });
    }
    load();

    // 刪除清單中的一筆:已寫入 Excel 的由電腦端同步刪除 WMS.xlsx 對應列;排隊中的直接移除
    box.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".rcv-del") : null;
      if (!b || b.disabled) return;
      var kind = b.getAttribute("data-kind"), r = (kind === "pending" ? curPend : curRows)[parseInt(b.getAttribute("data-i"), 10)];
      if (!r) return;
      var what = r.c + (r.n ? " " + r.n : "") + "\n數量 " + fmtNum(r.q) + " · " + r.v + " · " + r.p +
        (isRet && r.dn ? "\n進貨單 " + (r.dt || "") + "-" + r.dn : "");
      if (!window.confirm("確定要刪除這一筆" + K.what + "嗎?\n\n" + what + "\n\n" + (kind === "pending"
        ? "這筆還沒寫入 Excel,刪除後就不會寫入。"
        : "將從 WMS.xlsx「" + K.sheet + "」工作表移除(電腦約 5 分鐘內同步,同時更新雲端硬碟),此動作無法復原。"))) return;
      b.disabled = true;
      msg.textContent = "刪除中…";
      var payload = kind === "pending"
        ? { kind: "pending", id: r.id }
        : { kind: "sheet", vendor: r.v, po: r.p, code: r.c, qty: r.q };
      if (isRet && kind !== "pending") { payload.docType = r.dt; payload.docNo = r.dn; }
      api(K.delApi, payload).then(function (res) {
        if (!res.ok) throw new Error(res.error || "刪除失敗");
        msg.textContent = "";
        showToast(kind === "pending" ? "已刪除" : "已送出刪除,稍後同步到 Excel");
        return load();
      }).catch(function (err) {
        if (!session) { close(); return; }
        msg.textContent = err.message;
        b.disabled = false;
        load();
      });
    });

    okBtn.addEventListener("click", function () {
      okBtn.disabled = true;
      msg.textContent = "送出中…";
      api(K.reqApi).then(function (res) {
        if (!res.ok) throw new Error(res.error || "送出失敗");
        close();
        showToast("已送出" + K.title + "請求");
        if (onSent) onSent();
      }).catch(function (err) {
        if (!session) { close(); return; }
        msg.textContent = err.message;
        okBtn.disabled = false;
      });
    });
  }

  // ---- 簽核失敗通知 ----
  // puri09 / 退貨單流程在 ERP 作業失敗時,會在 WMS.xlsx「收料」「退料」的「狀態」欄寫「⚠ 失敗:原因」;電腦端把它回報上來後,
  // 這裡每分鐘檢查一次,出現(新的)失敗項目就跳出回報視窗通知使用者。按「知道了」後同一批不再重複彈出。
  var failTimer = null;

  function isFailMark(s) { return !!s && /⚠|失敗/.test(String(s)); }

  function failSignature(rows) {
    return rows.map(function (r) { return [r.p, r.c, r.f, r.dn || ""].join("|"); }).sort().join(";");
  }

  function openFailureDialog(kindKey, rows, sig) {
    var K = PUR_KINDS[kindKey], isRet = kindKey === "ret";
    var modal = el(
      '<div class="modal-backdrop">' +
        '<div class="modal modal-wide" role="alertdialog" aria-modal="true" aria-labelledby="fail-title">' +
          '<h2 id="fail-title" class="fail-title">⚠ ' + esc(K.title) + '有 ' + rows.length + ' 筆失敗</h2>' +
          '<p class="rcv-intro">以下項目在 ERP 作業時失敗,資料仍留在 WMS.xlsx「' + esc(K.sheet) + '」工作表,並標記了失敗原因,請確認處理:</p>' +
          '<div class="rcv-box">' + rows.map(function (r) {
            return '<div class="rcv-item failed">' +
              '<div class="rcv-top"><span class="rcv-code">' + esc(r.c) + '</span><span class="rcv-qty">數量 ' + esc(fmtNum(r.q)) + '</span></div>' +
              (r.n ? '<div class="rcv-name">' + esc(r.n) + '</div>' : '') +
              '<div class="rcv-sub">' + esc(r.v) + ' · ' + esc(r.p) + (isRet && r.dn ? ' · 進貨單 ' + esc((r.dt || "") + "-" + r.dn) : "") + '</div>' +
              '<div class="rcv-fail">' + esc(r.f) + '</div>' +
            '</div>';
          }).join("") + '</div>' +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn-secondary" id="fail-view">查看簽核清單</button>' +
            '<button type="button" class="btn" id="fail-ok">知道了</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
    document.body.appendChild(modal);
    function close() { if (modal.parentNode) modal.parentNode.removeChild(modal); }
    modal.querySelector("#fail-ok").addEventListener("click", function () { lsSet(K.failKey, sig); close(); });
    modal.querySelector("#fail-view").addEventListener("click", function () {
      lsSet(K.failKey, sig);
      close();
      openPuriListDialog(kindKey, null);
    });
  }

  function busyForNotice() { return !!document.querySelector(".modal-backdrop") || !!scanner; }

  function checkFailures() {
    if (!session || document.hidden || busyForNotice()) return; // 正在操作其他視窗或掃描時先不打擾,下一輪再檢查
    var kinds = Object.keys(PUR_KINDS).filter(function (k) { return can(PUR_KINDS[k].perm); });
    (function next(i) {
      if (i >= kinds.length) return;
      var kindKey = kinds[i], K = PUR_KINDS[kindKey];
      api(K.listApi).then(function (res) {
        if (!res || !res.ok) return next(i + 1);
        var rows = ((res.snapshot && res.snapshot.rows) || []).filter(function (r) { return isFailMark(r.f); });
        if (!rows.length) { lsSet(K.failKey, null); return next(i + 1); } // 失敗項目都處理掉了,下次再失敗才會重新通知
        var sig = failSignature(rows);
        if (lsGet(K.failKey) === sig) return next(i + 1);
        if (busyForNotice()) return;
        openFailureDialog(kindKey, rows, sig);
      }).catch(function () { /* 讀不到就下一輪再試 */ });
    })(0);
  }

  function startFailureWatch() {
    if (failTimer) return;
    setTimeout(checkFailures, 3000);
    failTimer = setInterval(checkFailures, 60000);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") checkFailures();
    });
  }

  // 「WMS更新」:僅管理者。送出請求後由電腦端約每 5 分鐘檢查一次並啟動排程「WMS 自動更新」,
  // 狀態(排隊中 / 執行中 / 完成 / 失敗)由電腦端回報,這裡顯示在按鈕下方。
  function wmsStatusText(res) {
    var st = res.status, when = st && st.ts ? new Date(st.ts).toLocaleString("zh-TW", { hour12: false }) : "";
    if (res.queued) return { text: "已送出,等待電腦啟動(約 5 分鐘內)", busy: true };
    if (!st) return { text: "", busy: false };
    if (st.state === "running") return { text: "執行中(" + when + " 起),完成約需 5~15 分鐘", busy: true };
    if (st.state === "done") return { text: "上次完成:" + when, busy: false };
    return { text: "上次失敗(" + when + "):" + (st.msg || ""), busy: false };
  }

  function setupWmsUpdate() {
    var btn = document.getElementById("wms-update-btn");
    var note = document.getElementById("wms-update-note");
    if (!btn || !note) return;
    var timer = null, wasBusy = false;

    function refresh() {
      api("wms_status").then(function (res) {
        if (!document.body.contains(btn)) return; // 已離開此頁
        if (!res.ok) { note.textContent = res.error || ""; return; }
        var s = wmsStatusText(res);
        note.textContent = s.text;
        // 剛跑完:加快檢查網站上的新資料,發布後自動重新整理
        if (wasBusy && !s.busy && res.status && res.status.state === "done") boostDataCheck();
        wasBusy = s.busy;
        btn.disabled = s.busy;
        btn.classList.toggle("is-busy", s.busy);
        clearTimeout(timer);
        if (s.busy) timer = setTimeout(refresh, 20000); // 進行中才持續更新狀態
      }).catch(function () { /* 讀不到狀態不影響使用 */ });
    }

    btn.addEventListener("click", function () {
      if (!window.confirm("確定要執行 WMS 更新嗎?\n\n電腦會清空 C:\\My Documents、重新從 ERP 匯出報表並更新 WMS 資料,約需 5~15 分鐘。")) return;
      btn.disabled = true;
      note.textContent = "送出中…";
      api("wms_update").then(function (res) {
        if (!res.ok) throw new Error(res.error || "送出失敗");
        showToast("已送出 WMS 更新請求");
        refresh();
      }).catch(function (err) {
        note.textContent = err.message;
        if (session) btn.disabled = false;
      });
    });

    refresh();
  }

  // ---------- ERP「設定」:各執行鍵的自動執行時間區間 / 間隔(僅管理者) ----------
  // 設定存在 Apps Script;電腦端每 5 分鐘檢查一次,到了時段就啟動對應的流程。

  var SCHED_JOBS = [
    { key: "wms", title: "WMS更新", desc: "清空 C:\\My Documents、從 ERP 匯出報表並更新 WMS 資料(每次約 5~15 分鐘)" }
  ];
  var SCHED_INTERVALS = [30, 60, 90, 120, 180, 240, 360, 480, 720, 1440];

  function intervalLabel(min) {
    if (min < 60) return min + " 分鐘";
    return (min % 60 ? (min / 60).toFixed(1) : min / 60) + " 小時";
  }

  function hmToMin(hm) {
    var p = String(hm || "").split(":");
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  function skipsDay(cfg, date) {
    return (date.getDay() === 6 && cfg.skipSat) || (date.getDay() === 0 && cfg.skipSun);
  }

  // 下一次執行時間(與電腦端判斷方式相同:每天 start 起每 interval 分鐘,到 end 為止;略過勾選不執行的週六/週日)
  function nextScheduledRun(cfg, now) {
    var start = hmToMin(cfg.start), end = hmToMin(cfg.end), step = cfg.interval;
    for (var d = 0; d < 8; d++) {
      var day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
      if (skipsDay(cfg, day)) continue;
      for (var m = start; m <= end; m += step) {
        var t = new Date(day.getTime() + m * 60000);
        if (t > now && t.getTime() >= (cfg.updatedAt || 0)) return t;
      }
    }
    return null;
  }

  var WEEKDAY_NAMES = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

  function scheduleSummary(cfg) {
    if (!cfg) return "自動執行:未設定";
    var skip = [cfg.skipSat ? "週六" : "", cfg.skipSun ? "週日" : ""].filter(Boolean);
    var s = "自動執行:每天" + (skip.length ? "(" + skip.join("、") + "除外)" : "") + " " +
      cfg.start + "–" + cfg.end + ",每 " + intervalLabel(cfg.interval);
    if (!cfg.enabled) return s + "(已暫停)";
    var now = new Date(), next = nextScheduledRun(cfg, now);
    if (!next) return s;
    var days = Math.round((new Date(next.getFullYear(), next.getMonth(), next.getDate()) -
      new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    var dayLabel = days === 0 ? "" : days === 1 ? "明天 " : WEEKDAY_NAMES[next.getDay()] + " ";
    return s + ";下次 " + dayLabel + pad2(next.getHours()) + ":" + pad2(next.getMinutes());
  }

  function renderErpSettings(app) {
    if (!session || !session.isAdmin) { location.hash = "#/erp"; return; }
    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">首頁</a> / <a href="#/erp">ERP</a> / 設定</div>' +
      '<h1 class="page-title">自動執行設定<span class="sub">設定 ERP 頁各執行鍵每天自動執行的時間區間與間隔</span></h1>' +
      '<div id="sched-list"><div class="skeleton">載入中…</div></div>' +
      '<p class="admin-note">電腦約每 5 分鐘檢查一次,實際啟動時間可能比設定晚幾分鐘;電腦需開機並保持登入。' +
      '儲存後,已經過去的時段不會補跑,從下一個時段開始生效。</p>';

    var list = document.getElementById("sched-list");

    function draw(schedules) {
      list.innerHTML = "";
      SCHED_JOBS.forEach(function (job) {
        var cfg = schedules[job.key];
        var cur = cfg || { enabled: true, start: "08:00", end: "18:00", interval: 240 };
        var card = el(
          '<div class="admin-card sched-card">' +
            '<h3>' + esc(job.title) + '</h3>' +
            '<p class="sched-desc">' + esc(job.desc) + '</p>' +
            '<p class="sched-current">' + esc(scheduleSummary(cfg)) + '</p>' +
            '<div class="sched-form">' +
              '<label class="sched-check"><input type="checkbox" class="s-enabled"' + (cur.enabled ? " checked" : "") + ' /> 啟用自動執行</label>' +
              '<label>開始時間<input type="time" class="s-start" value="' + esc(cur.start) + '" /></label>' +
              '<label>結束時間<input type="time" class="s-end" value="' + esc(cur.end) + '" /></label>' +
              '<label>間隔<select class="s-interval">' + SCHED_INTERVALS.map(function (m) {
                return '<option value="' + m + '"' + (m === cur.interval ? " selected" : "") + '>每 ' + intervalLabel(m) + '</option>';
              }).join("") + '</select></label>' +
              '<div class="sched-days">' +
                '<label class="sched-check"><input type="checkbox" class="s-skip-sun"' + (cur.skipSun ? " checked" : "") + ' /> 週日不執行</label>' +
                '<label class="sched-check"><input type="checkbox" class="s-skip-sat"' + (cur.skipSat ? " checked" : "") + ' /> 週六不執行</label>' +
              '</div>' +
            '</div>' +
            '<div class="admin-actions">' +
              '<button type="button" class="btn s-save">儲存</button>' +
              (cfg ? '<button type="button" class="btn btn-secondary btn-danger s-cancel">取消自動執行</button>' : '') +
            '</div>' +
            '<p class="modal-msg s-msg"></p>' +
          '</div>'
        );
        list.appendChild(card);

        var msg = card.querySelector(".s-msg");
        function send(action, payload, okText) {
          card.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
          msg.textContent = "儲存中…";
          api(action, Object.assign({ job: job.key }, payload || {}))
            .then(function (res) {
              if (!res.ok) throw new Error(res.error || "儲存失敗");
              showToast(okText);
              draw(res.schedules || {});
            })
            .catch(function (err) {
              msg.textContent = err.message;
              card.querySelectorAll("button").forEach(function (b) { b.disabled = false; });
            });
        }

        card.querySelector(".s-save").addEventListener("click", function () {
          var start = card.querySelector(".s-start").value, end = card.querySelector(".s-end").value;
          if (!start || !end) { msg.textContent = "請輸入開始與結束時間"; return; }
          if (start >= end) { msg.textContent = "結束時間必須晚於開始時間"; return; }
          send("sched_set", {
            enabled: card.querySelector(".s-enabled").checked,
            start: start, end: end,
            interval: parseInt(card.querySelector(".s-interval").value, 10),
            skipSun: card.querySelector(".s-skip-sun").checked,
            skipSat: card.querySelector(".s-skip-sat").checked
          }, "已儲存「" + job.title + "」的自動執行設定");
        });

        var cancelBtn = card.querySelector(".s-cancel");
        if (cancelBtn) cancelBtn.addEventListener("click", function () {
          if (!window.confirm("確定要取消「" + job.title + "」的自動執行嗎?\n(手動按鈕仍可使用)")) return;
          send("sched_delete", null, "已取消「" + job.title + "」的自動執行");
        });
      });
    }

    api("sched_get")
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || "讀取失敗");
        draw(res.schedules || {});
      })
      .catch(function (err) {
        list.innerHTML = '<div class="empty-state">讀取設定失敗:' + esc(err.message) + '</div>';
      });
  }

  // ---------- 待簽核表單 ----------
  // 來源:(1) 同事把截圖貼到這一頁上傳,電腦端辨識後自動錄入;(2) 在這一頁手動輸入 / 修改。
  // 每一列:核取方塊、表單名稱(下拉選單,連動程式代碼)、程式代碼、單別、單號;勾選後按「確認」送出簽核請求(作業方式同進貨單簽核)。
  var signPage = null;   // 目前開著的待簽核表單頁(貼上截圖用);離開這一頁就清掉
  var SIGN_IMG_MAX = 1600000;   // 圖片大小上限(Apps Script 端也會檢查)

  // 表單名稱 <-> 程式代碼對照表(來自 ERP 資料夾的「表單與程式碼對照表.xlsx」,隨網站資料發布)
  // 表單名稱 / 程式代碼對照:網頁上編輯過的清單(存在伺服器,所有人共用)優先,沒編輯過就用對照表 Excel 的預設清單
  var signProgs = null;
  function signFormList() { return signProgs || (state.data && state.data.signForms) || []; }
  function canEditProgs() { return can("admin") || can("erp_sign"); }
  function signCodeOfName(name) {
    var f = signFormList().filter(function (x) { return x.name === name; })[0];
    return f ? f.code : "";
  }
  function signNameOfCode(code) {
    var f = signFormList().filter(function (x) { return x.code === code; })[0];
    return f ? f.name : "";
  }
  function signNameOptions(selected) {
    var names = [], seen = {};
    signFormList().forEach(function (x) { if (!seen[x.name]) { seen[x.name] = true; names.push(x.name); } });
    if (selected && !seen[selected]) names.push(selected);   // 辨識出來但不在對照表的名稱也要能顯示
    return '<option value="">(請選擇)</option>' + names.map(function (n) {
      return '<option value="' + esc(n) + '"' + (n === selected ? ' selected' : '') + '>' + esc(n) + '</option>';
    }).join("");
  }

  function renderErpSign(app) {
    var canConfirm = can("erp_sign");   // 只有「確認」鍵需要權限
    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">首頁</a> / <a href="#/erp">ERP</a> / 待簽核表單</div>' +
      '<h1 class="page-title page-title-row"><span>待簽核表單</span>' +
        '<button type="button" class="btn btn-sm btn-secondary" id="sign-refresh">重新整理</button></h1>' +

      '<section class="sign-card">' +
        '<h2 class="sign-h">上傳截圖辨識</h2>' +
        '<p class="rcv-intro">用截圖工具截下 ERP 畫面(要簽核的表單請用紅框框起來;沒有紅框就讀畫面上方藍綠色的單別/單號),在這一頁按 <b>Ctrl+V</b> 貼上,或選擇圖片檔,再按「上傳辨識」。辨識出的表單約 1~2 分鐘內會出現在下面的清單。</p>' +
        '<div class="sign-drop" id="sign-drop" tabindex="0">' +
          '<div id="sign-drop-text">在這裡按 Ctrl+V 貼上截圖,或把圖片拖進來</div>' +
          '<div class="sign-preview-wrap" id="sign-preview-wrap" hidden>' +
            '<img id="sign-preview" alt="貼上的截圖預覽" />' +
            '<button type="button" class="sign-preview-clear" id="sign-preview-clear" title="移除這張圖片(可重新貼上別張)" aria-label="移除這張圖片">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="sign-up-actions">' +
          '<label class="btn btn-sm btn-secondary sign-file">選擇圖片<input type="file" id="sign-file" accept="image/*" hidden /></label>' +
          '<button type="button" class="btn btn-sm" id="sign-upload" disabled>上傳辨識</button>' +
        '</div>' +
        '<div class="sign-imgs" id="sign-imgs"></div>' +
      '</section>' +

      '<section class="sign-card">' +
        '<h2 class="sign-h sign-h-row"><span>手動新增</span>' +
          (canEditProgs() ? '<button type="button" class="btn btn-sm btn-secondary" id="prog-edit" title="新增、修改、刪除下拉選單裡的表單名稱與程式代碼">編輯表單清單</button>' : '') +
        '</h2>' +
        '<div class="sign-row sign-add">' +
          '<span class="sign-chk"></span>' +
          '<select id="add-name" class="sign-name" aria-label="表單名稱">' + signNameOptions("") + '</select>' +
          '<input id="add-prog" class="sign-prog" placeholder="程式代碼" maxlength="10" autocomplete="off" autocapitalize="characters" spellcheck="false" />' +
          '<input id="add-dt" class="sign-dt" placeholder="單別" inputmode="numeric" maxlength="6" autocomplete="off" />' +
          '<input id="add-dn" class="sign-dn" placeholder="單號" inputmode="numeric" maxlength="16" autocomplete="off" />' +
          '<input id="add-vendor" class="sign-vendor" placeholder="廠商" maxlength="30" autocomplete="off" />' +
          '<div class="sign-add-btns">' +
            '<button type="button" class="btn btn-sm btn-secondary" id="add-clear" title="清空這一區所有欄位">清除</button>' +
            '<button type="button" class="btn btn-sm" id="add-ok">新增</button>' +
          '</div>' +
        '</div>' +
      '</section>' +

      '<section class="sign-card">' +
        '<h2 class="sign-h">待簽核清單 <span class="sign-count" id="sign-count"></span></h2>' +
        '<div class="sign-row sign-headrow"><label class="sign-chk"><input type="checkbox" id="sign-all" aria-label="全選" /></label>' +
          '<span>表單名稱</span><span>程式代碼</span><span>單別</span><span>單號</span><span>廠商</span><span>上傳者</span><span>圖片</span><span></span></div>' +
        '<div id="sign-list"><div class="skeleton">載入中…</div></div>' +
        '<div class="sign-foot">' +
          '<button type="button" class="btn btn-secondary btn-sm" id="sign-clear">全部清除</button>' +
          '<button type="button" class="btn" id="sign-ok" disabled>確認</button>' +
        '</div>' +
        '<p class="sign-note" id="sign-note"></p>' +
        '<p class="modal-msg" id="sign-msg"></p>' +
      '</section>';

    function $(id) { return document.getElementById(id); }
    var forms = [], imgs = [], picked = {}, pendingBlob = null, previewUrl = "", busy = false, lastSig = "";
    var tickTimer = null;
    var alive = function () { return document.body.contains($("sign-list")); };
    function msg(t) { $("sign-msg").textContent = t || ""; }

    // ---- 清單 ----
    function metaHtml(f) {
      var m = [];
      if (f.docName) m.push(esc(f.docName));
      if (f.src) m.push(esc(f.src));
      if (f.ts) m.push(esc(new Date(f.ts).toLocaleString("zh-TW", { hour12: false })));
      var html = m.join(" · ");
      if (f.f) html += ' <span class="sign-bad">' + esc(f.f) + '</span>';
      else if (f.conf === "low") html += ' <span class="sign-bad">⚠ 辨識把握度不高,請對照 ERP 核對</span>';
      return html;
    }

    function rowHtml(f, i) {
      return '<div class="sign-row' + (f.f ? ' failed' : f.conf === "low" ? ' low' : '') + '" data-i="' + i + '">' +
        '<label class="sign-chk"><input type="checkbox" class="sign-pick" aria-label="勾選"' + (picked[f.id] ? ' checked' : '') + ' /></label>' +
        '<select class="sign-name" aria-label="表單名稱">' + signNameOptions(f.name) + '</select>' +
        '<input class="sign-prog" value="' + esc(f.prog) + '" maxlength="10" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="程式代碼" />' +
        '<input class="sign-dt" value="' + esc(f.docType) + '" inputmode="numeric" maxlength="6" autocomplete="off" aria-label="單別" />' +
        '<input class="sign-dn" value="' + esc(f.docNo) + '" inputmode="numeric" maxlength="16" autocomplete="off" aria-label="單號" />' +
        '<input class="sign-vendor" value="' + esc(f.vendor) + '" maxlength="30" autocomplete="off" placeholder="廠商" aria-label="廠商" />' +
        '<span class="sign-by" title="' + esc(f.by || "") + '"><i class="sign-by-l">上傳者:</i>' + esc(f.by || "—") + '</span>' +
        '<span class="sign-img">' + (f.imgUrl && /^https:\/\//.test(f.imgUrl) ? '<a href="' + esc(f.imgUrl) + '" target="_blank" rel="noopener noreferrer" title="開啟這張表單的來源截圖"><i class="sign-img-l">圖片:</i>查看</a>' : '') + '</span>' +
        '<button type="button" class="rcv-del sign-del" aria-label="刪除這一張">刪除</button>' +
        '<div class="sign-meta">' + metaHtml(f) + '</div>' +
      '</div>';
    }

    function updateButtons() {
      var n = forms.filter(function (f) { return picked[f.id]; }).length;
      $("sign-ok").disabled = busy || n < 1 || !canConfirm;
      $("sign-ok").title = canConfirm ? "" : "需要「ERP:待簽核表單確認」權限,請聯絡管理者";
      $("sign-ok").textContent = n ? "確認(" + n + " 張)" : "確認";
      $("sign-clear").disabled = !forms.length;
      $("sign-all").checked = forms.length > 0 && n === forms.length;
      $("sign-count").textContent = forms.length ? "共 " + forms.length + " 張" : "";
    }

    function formsSig(list) {
      return JSON.stringify(list.map(function (f) { return [f.id, f.name, f.prog, f.docType, f.docNo, f.vendor, f.conf, f.f]; }));
    }
    function editingInList() {
      var a = document.activeElement;
      return !!(a && $("sign-list").contains(a) && /^(INPUT|SELECT)$/.test(a.tagName) && a.type !== "checkbox");
    }

    // silent=true:背景自動更新。內容沒變就不重畫;使用者正在編輯欄位時先不重畫(下一輪再更新),避免打字被打斷
    function loadForms(silent) {
      return api("signforms_list").then(function (res) {
        if (!res.ok) throw new Error(res.error || "讀取失敗");
        // 同一張截圖辨識出的幾筆建立時間相同,伺服器回傳的先後不固定 -> 每 10 秒更新時順序會跳動。
        // 這裡固定排序:新的在前,同時間的依單別、單號,最後用 id
        var list = (res.forms || []).slice().sort(function (a, b) {
          return (b.ts || 0) - (a.ts || 0) ||
            String(a.docType).localeCompare(String(b.docType)) ||
            String(a.docNo).localeCompare(String(b.docNo)) ||
            String(a.id).localeCompare(String(b.id));
        });
        var sig = formsSig(list);
        if (silent === true && (sig === lastSig || editingInList())) return;
        lastSig = sig;
        forms = list;
        var ids = {};
        forms.forEach(function (f) { ids[f.id] = true; });
        Object.keys(picked).forEach(function (k) { if (!ids[k]) delete picked[k]; });
        $("sign-list").innerHTML = forms.length ? forms.map(rowHtml).join("") : '<div class="empty-state">目前沒有待簽核表單</div>';
        updateButtons();
      }).catch(function (err) {
        if (silent === true) return;   // 背景更新失敗就等下一輪,不要把清單換成錯誤訊息
        if (session && alive()) $("sign-list").innerHTML = '<div class="empty-state">' + esc(err.message) + '</div>';
      });
    }

    function readRow(row) {
      return {
        name: row.querySelector(".sign-name").value,
        prog: row.querySelector(".sign-prog").value.trim().toUpperCase(),
        docType: row.querySelector(".sign-dt").value.trim(),
        docNo: row.querySelector(".sign-dn").value.trim(),
        vendor: row.querySelector(".sign-vendor").value.trim()
      };
    }
    function checkFields(v) {
      if (!v.prog) return "請選擇表單名稱或填入程式代碼";
      if (!/^\d{3,6}$/.test(v.docType)) return "單別必須是 3~6 位數字";
      if (!/^\d{6,16}$/.test(v.docNo)) return "單號必須是 6~16 位數字(一般是 11 碼)";
      return "";
    }

    // 欄位修改後自動儲存(離開欄位 / 選了下拉選單時);表單名稱與程式代碼互相連動
    $("sign-list").addEventListener("change", function (e) {
      var t = e.target, row = t.closest ? t.closest(".sign-row") : null;
      if (!row || row.classList.contains("sign-headrow")) return;
      var f = forms[parseInt(row.getAttribute("data-i"), 10)];
      if (!f) return;
      if (t.classList.contains("sign-pick")) {
        if (t.checked) picked[f.id] = true; else delete picked[f.id];
        updateButtons();
        return;
      }
      linkNameAndCode(row, t);
      var v = readRow(row), bad = checkFields(v);
      row.classList.toggle("invalid", !!bad);
      if (bad) { msg(bad); return; }
      msg("");
      api("signforms_save", { id: f.id, name: v.name, prog: v.prog, docType: v.docType, docNo: v.docNo, vendor: v.vendor }).then(function (res) {
        if (!res.ok) throw new Error(res.error || "儲存失敗");
        forms[forms.indexOf(f)] = res.form;
        row.classList.remove("failed", "low", "invalid");
        row.querySelector(".sign-meta").innerHTML = metaHtml(res.form);
      }).catch(function (err) {
        if (!session) return;
        msg(err.message);
        loadForms();   // 存不進去(例如重複)就還原成伺服器上的內容
      });
    });

    function linkNameAndCode(row, changed) {
      var sel = row.querySelector(".sign-name, #add-name"), prog = row.querySelector(".sign-prog, #add-prog");
      if (changed === sel) {
        var code = signCodeOfName(sel.value);
        if (code) prog.value = code;
      } else if (changed === prog) {
        prog.value = prog.value.trim().toUpperCase();
        var nm = signNameOfCode(prog.value);
        if (nm && sel.value !== nm) {
          // 一個代碼可能對應多個表單名稱(例如 INVI05):目前選的名稱本來就屬於這個代碼就不動
          if (signCodeOfName(sel.value) !== prog.value) sel.value = nm;
        } else if (!nm) {
          sel.value = "";
        }
      }
    }

    $("sign-list").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest(".sign-del") : null;
      if (!b) return;
      var row = b.closest(".sign-row"), f = forms[parseInt(row.getAttribute("data-i"), 10)];
      if (!f) return;
      if (!window.confirm("確定要刪除這張待簽核表單嗎?\n\n" + (f.name || f.prog) + " " + f.docType + "-" + f.docNo)) return;
      b.disabled = true;
      api("signforms_delete", { id: f.id }).then(function (res) {
        if (!res.ok) throw new Error(res.error || "刪除失敗");
        delete picked[f.id];
        msg("");
        return loadForms();
      }).catch(function (err) { if (session) { msg(err.message); loadForms(); } });
    });

    $("sign-all").addEventListener("change", function () {
      picked = {};
      if ($("sign-all").checked) forms.forEach(function (f) { picked[f.id] = true; });
      Array.prototype.forEach.call(document.querySelectorAll("#sign-list .sign-pick"), function (c) { c.checked = $("sign-all").checked; });
      updateButtons();
    });

    $("sign-clear").addEventListener("click", function () {
      if (!forms.length || !window.confirm("確定要清除全部 " + forms.length + " 張待簽核表單嗎?\n\n此動作無法復原。")) return;
      api("signforms_delete", { all: true }).then(function (res) {
        if (!res.ok) throw new Error(res.error || "清除失敗");
        picked = {};
        showToast("已清除");
        return loadForms();
      }).catch(function (err) { if (session) msg(err.message); });
    });

    // ---- 編輯表單清單(下拉選單的表單名稱 + 程式代碼) ----
    function refreshNameOptions() {
      var cur = $("add-name").value;
      if (!signFormList().some(function (x) { return x.name === cur; })) cur = "";   // 手動新增的下拉選單不保留已被刪掉的名稱
      $("add-name").innerHTML = signNameOptions(cur);
      Array.prototype.forEach.call(document.querySelectorAll("#sign-list .sign-name"), function (s) {
        var v = s.value;
        s.innerHTML = signNameOptions(v);
      });
    }

    function loadProgs() {
      api("signprogs_get").then(function (res) {
        if (!res.ok || !alive()) return;
        signProgs = Array.isArray(res.progs) ? res.progs : null;
        refreshNameOptions();
      }).catch(function () { /* 讀不到就用預設清單 */ });
    }

    function openProgDialog() {
      var base = signFormList().map(function (x) { return { name: x.name, code: x.code }; });
      var modal = el(
        '<div class="modal-backdrop">' +
          '<div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="prog-title">' +
            '<h2 id="prog-title">編輯表單清單</h2>' +
            '<p class="rcv-intro">這份清單是「手動新增」與清單裡「表單名稱」下拉選單的選項,所有同仁共用;截圖辨識也會用它校正程式代碼。同一個程式代碼可以對應多個表單名稱。</p>' +
            '<div class="prog-head"><span>表單名稱</span><span>程式代碼</span><span></span></div>' +
            '<div class="prog-box" id="prog-box"></div>' +
            '<button type="button" class="btn btn-sm btn-secondary" id="prog-add">＋ 新增一列</button>' +
            '<p class="modal-msg" id="prog-msg"></p>' +
            '<div class="modal-actions">' +
              '<button type="button" class="btn btn-secondary" id="prog-reset">還原預設</button>' +
              '<button type="button" class="btn btn-secondary" id="prog-cancel">取消</button>' +
              '<button type="button" class="btn" id="prog-save">儲存</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      );
      document.body.appendChild(modal);
      var box = modal.querySelector("#prog-box"), pmsg = modal.querySelector("#prog-msg");
      function rowEl(x) {
        var r = el('<div class="prog-row"><input class="prog-name" maxlength="30" placeholder="表單名稱" autocomplete="off" />' +
          '<input class="prog-code" maxlength="10" placeholder="程式代碼" autocomplete="off" autocapitalize="characters" spellcheck="false" />' +
          '<button type="button" class="rcv-del" aria-label="刪除這一列">刪除</button></div>');
        r.querySelector(".prog-name").value = x.name || "";
        r.querySelector(".prog-code").value = x.code || "";
        r.querySelector(".prog-code").addEventListener("input", function (e) { e.target.value = e.target.value.toUpperCase(); });
        r.querySelector(".rcv-del").addEventListener("click", function () { r.parentNode.removeChild(r); });
        return r;
      }
      base.forEach(function (x) { box.appendChild(rowEl(x)); });
      modal.querySelector("#prog-add").addEventListener("click", function () {
        var r = rowEl({}); box.appendChild(r); r.querySelector(".prog-name").focus(); box.scrollTop = box.scrollHeight;
      });
      function close() { if (modal.parentNode) modal.parentNode.removeChild(modal); }
      modal.querySelector("#prog-cancel").addEventListener("click", close);
      modal.addEventListener("click", function (e) { if (e.target === modal) close(); });
      function busyBtns(b) { ["prog-save", "prog-reset", "prog-cancel", "prog-add"].forEach(function (id) { modal.querySelector("#" + id).disabled = b; }); }
      modal.querySelector("#prog-save").addEventListener("click", function () {
        var progs = Array.prototype.map.call(box.querySelectorAll(".prog-row"), function (r) {
          return { name: r.querySelector(".prog-name").value.trim(), code: r.querySelector(".prog-code").value.trim().toUpperCase() };
        });
        busyBtns(true); pmsg.textContent = "儲存中…";
        api("signprogs_save", { progs: progs }).then(function (res) {
          if (!res.ok) throw new Error(res.error || "儲存失敗");
          signProgs = res.progs;
          refreshNameOptions();
          close();
          showToast("已儲存表單清單");
        }).catch(function (err) { busyBtns(false); pmsg.textContent = err.message; });
      });
      modal.querySelector("#prog-reset").addEventListener("click", function () {
        if (!window.confirm("要還原成預設清單嗎?\n(預設清單來自「表單與程式碼對照表.xlsx」,你在網頁上做的修改會被清掉)")) return;
        busyBtns(true); pmsg.textContent = "還原中…";
        api("signprogs_reset").then(function (res) {
          if (!res.ok) throw new Error(res.error || "還原失敗");
          signProgs = null;
          refreshNameOptions();
          close();
          showToast("已還原預設清單");
        }).catch(function (err) { busyBtns(false); pmsg.textContent = err.message; });
      });
    }
    if ($("prog-edit")) $("prog-edit").addEventListener("click", openProgDialog);
    loadProgs();

    // ---- 手動新增 ----
    $("add-name").addEventListener("change", function () { linkNameAndCode($("add-name").closest(".sign-row"), $("add-name")); });
    $("add-prog").addEventListener("change", function () { linkNameAndCode($("add-prog").closest(".sign-row"), $("add-prog")); });
    // 一鍵清除這一區所有欄位(表單名稱、程式代碼、單別、單號、廠商)
    $("add-clear").addEventListener("click", function () {
      $("add-name").value = "";
      ["add-prog", "add-dt", "add-dn", "add-vendor"].forEach(function (id) { $(id).value = ""; });
      $("add-name").closest(".sign-row").classList.remove("invalid");
      msg("");
      $("add-name").focus();
    });
    $("add-ok").addEventListener("click", function () {
      var v = { name: $("add-name").value, prog: $("add-prog").value.trim().toUpperCase(), docType: $("add-dt").value.trim(), docNo: $("add-dn").value.trim(), vendor: $("add-vendor").value.trim() };
      var bad = checkFields(v);
      if (bad) { msg(bad); return; }
      $("add-ok").disabled = true;
      api("signforms_save", v).then(function (res) {
        if (!res.ok) throw new Error(res.error || "新增失敗");
        msg("");
        $("add-dn").value = "";   // 表單名稱 / 單別留著,方便連續輸入同一種表單
        $("add-vendor").value = "";
        showToast("已新增");
        return loadForms();
      }).catch(function (err) { if (session) msg(err.message); }).then(function () { $("add-ok").disabled = false; });
    });

    // ---- 截圖上傳 ----
    function setImage(blob) {
      if (!blob) return;
      if (!/^image\//.test(blob.type || "")) { msg("這不是圖片檔"); return; }
      if (blob.size > SIGN_IMG_MAX) { msg("圖片太大(" + Math.round(blob.size / 1024) + " KB,上限約 1.6 MB),請只截取 ERP 視窗,不要截整個螢幕"); return; }
      msg("");
      pendingBlob = blob;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = URL.createObjectURL(blob);
      $("sign-preview").src = previewUrl;
      $("sign-preview-wrap").hidden = false;
      $("sign-drop-text").textContent = "已選擇圖片(" + Math.round(blob.size / 1024) + " KB),按「上傳辨識」送出;要換圖請按圖片右上角的 X 移除,或直接再貼上一次";
      $("sign-upload").disabled = false;
    }
    // 移除貼上的圖片(還沒上傳的),回到可以重新貼上的狀態
    function clearImage() {
      pendingBlob = null;
      if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
      $("sign-preview").removeAttribute("src");
      $("sign-preview-wrap").hidden = true;
      $("sign-drop-text").textContent = "在這裡按 Ctrl+V 貼上截圖,或把圖片拖進來";
      $("sign-upload").disabled = true;
    }
    $("sign-preview-clear").addEventListener("click", function (e) {
      e.stopPropagation();
      clearImage();
      msg("");
      $("sign-drop").focus();   // 游標回到貼上區,直接按 Ctrl+V 就能貼新的
    });
    signPage = { setImage: setImage };

    $("sign-file").addEventListener("change", function () { setImage($("sign-file").files[0]); $("sign-file").value = ""; });
    $("sign-drop").addEventListener("dragover", function (e) { e.preventDefault(); });
    $("sign-drop").addEventListener("drop", function (e) {
      e.preventDefault();
      var fl = e.dataTransfer && e.dataTransfer.files;
      if (fl && fl.length) setImage(fl[0]);
    });
    $("sign-upload").addEventListener("click", function () {
      if (!pendingBlob) return;
      var blob = pendingBlob;
      $("sign-upload").disabled = true;
      msg("上傳中…");
      var reader = new FileReader();
      reader.onload = function () {
        api("signimg_upload", { name: blob.name || "貼上的截圖", data: reader.result }).then(function (res) {
          if (!res.ok) throw new Error(res.error || "上傳失敗");
          msg("");
          showToast("已上傳,約 1~2 分鐘內辨識完成");
          clearImage();
          return loadImgs();
        }).catch(function (err) {
          if (!session) return;
          msg(err.message);
          $("sign-upload").disabled = false;
        });
      };
      reader.onerror = function () { msg("讀取圖片失敗"); $("sign-upload").disabled = false; };
      reader.readAsDataURL(blob);
    });

    function whoShort(by) { return String(by || "").split("@")[0]; }
    function imgText(r) {
      if (r.state === "queued") return "等待電腦取圖…";
      if (r.state === "processing") return "辨識中…";
      if (r.state === "done") return "✓ " + (r.msg || "完成");
      return "⚠ " + (r.msg || "失敗");
    }
    function loadImgs() {
      return api("signimg_list").then(function (res) {
        if (!res.ok || !alive()) return;
        var prevBusy = {};
        imgs.forEach(function (r) { if (r.state === "queued" || r.state === "processing") prevBusy[r.id] = true; });
        imgs = res.images || [];
        $("sign-imgs").innerHTML = imgs.slice(0, 6).map(function (r) {
          var cls = r.state === "error" ? " bad" : r.state === "done" ? " ok" : "";
          return '<div class="sign-img-row' + cls + '"><span class="t">' + esc(new Date(r.ts).toLocaleTimeString("zh-TW", { hour12: false })) +
            ' · ' + esc(whoShort(r.by)) + '</span><span>' + esc(imgText(r)) + '</span></div>';
        }).join("");
        var finished = imgs.some(function (r) { return prevBusy[r.id] && (r.state === "done" || r.state === "error"); });
        if (finished) loadForms(true);   // 剛辨識完:清單馬上更新
      }).catch(function () { /* 讀不到不影響使用,下一輪背景更新再試 */ });
    }

    // ---- 確認:送出簽核請求(同進貨單簽核) ----
    function loadStatus() {
      return api("sign_status").then(function (res) {
        if (!res.ok || !alive()) return;
        var s = puriStatusText(res);
        if (res.queued) s.text = "已送出,約 1 分鐘內寫入待簽核清單";
        $("sign-note").textContent = s.text;
        var wasBusy = busy;
        busy = s.busy;
        updateButtons();
        if (!s.busy && wasBusy) loadForms(true);   // 簽核剛結束:成功的已從清單移除,失敗的有標示
      }).catch(function () { /* 讀不到狀態不影響使用 */ });
    }

    $("sign-ok").addEventListener("click", function () {
      var sel = forms.filter(function (f) { return picked[f.id]; });
      if (!sel.length) return;
      var lines = sel.slice(0, 12).map(function (f) { return (f.name || f.prog) + " " + f.docType + "-" + f.docNo + (f.vendor ? " · " + f.vendor : ""); }).join("\n");
      if (!window.confirm("確定要把勾選的 " + sel.length + " 張表單送去簽核嗎?\n\n" + lines + (sel.length > 12 ? "\n…" : "") +
        "\n\n按確認後會寫入 WMS.xlsx「待簽核清單」,並從這個清單移除。")) return;
      $("sign-ok").disabled = true;
      msg("送出中…");
      api("sign_request", { ids: sel.map(function (f) { return f.id; }) }).then(function (res) {
        if (!res.ok) throw new Error(res.error || "送出失敗");
        msg("");
        showToast("已送出,稍後寫入待簽核清單");
        return loadStatus();
      }).catch(function (err) { if (session) { msg(err.message); updateButtons(); } });
    });

    $("sign-refresh").addEventListener("click", function () { msg(""); loadForms(); loadImgs(); loadStatus(); });

    // 背景自動更新:每 10 秒更新一次(辨識完成的表單、簽核結果會自動出現,不用按重新整理)。
    // 任何一次連線失敗都不會讓它停掉;離開這一頁就停止。回到分頁時馬上更新一次。
    function tick() {
      clearTimeout(tickTimer);
      if (!alive()) return;
      if (!document.hidden) { loadImgs(); loadForms(true); loadStatus(); }
      tickTimer = setTimeout(tick, 10000);
    }
    document.addEventListener("visibilitychange", function () {
      if (alive() && document.visibilityState === "visible") tick();
    });

    if (!canConfirm) msg("您沒有「確認」的權限(其他功能都可以使用),需要送出簽核請管理者開通「ERP:待簽核表單確認」。");
    loadForms();
    loadImgs();
    loadStatus();
    tickTimer = setTimeout(tick, 10000);
  }

  function renderErp(app, sub) {
    if (!canSeeErp()) { location.hash = "#/"; return; } // 沒有任何 ERP 權限
    if (sub === "settings") { renderErpSettings(app); return; }
    if (sub === "sign") { renderErpSign(app); return; }
    var page = ERP_PAGES[sub];
    if (sub && !page) { location.hash = "#/erp"; return; }
    if (page && !can(page.perm)) { location.hash = "#/erp"; return; } // 沒有這個按鍵的權限

    if (!page) {
      var isAdmin = can("admin");
      app.innerHTML =
        '<div class="breadcrumb"><a href="#/">首頁</a> / ERP</div>' +
        '<h1 class="page-title page-title-row"><span>ERP</span>' +
          (isAdmin ? '<a class="btn btn-sm btn-secondary" href="#/erp/settings">⚙ 設定</a>' : '') +
        '</h1>' +
        '<div class="erp-grid">' +
          (can("erp_receipt")
            ? '<button type="button" class="erp-tile erp-tile-wms" id="puri09-btn">' +
              '<span class="erp-tile-icon">' + ERP_ICONS.receipt + '</span><span class="erp-tile-title">進貨單簽核</span>' +
              '<span class="erp-tile-note" id="puri09-note"></span></button>'
            : '') +
          (can("erp_return")
            ? '<button type="button" class="erp-tile erp-tile-wms" id="ret-btn">' +
              '<span class="erp-tile-icon">' + ERP_ICONS.ret + '</span><span class="erp-tile-title">退貨單簽核</span>' +
              '<span class="erp-tile-note" id="ret-note"></span></button>'
            : '') +
          '<a class="erp-tile" href="#/erp/sign">' +
            '<span class="erp-tile-icon">' + ERP_ICONS.sign + '</span><span class="erp-tile-title">待簽核表單</span>' +
            '<span class="erp-tile-note" id="sign-note"></span></a>' +
          (can("erp_wms")
            ? '<button type="button" class="erp-tile erp-tile-wms" id="wms-update-btn">' +
              '<span class="erp-tile-icon">' + ERP_ICONS.wms + '</span><span class="erp-tile-title">WMS更新</span>' +
              '<span class="erp-tile-note" id="wms-update-note"></span>' +
              '<span class="erp-tile-note" id="wms-sched-note"></span></button>'
            : '') +
        '</div>';
      if (can("erp_receipt")) setupPuri09("receipt");
      if (can("erp_return")) setupPuri09("ret");
      api("signforms_list").then(function (res) {
        var n = document.getElementById("sign-note");
        if (n && res.ok && res.forms && res.forms.length) n.textContent = res.forms.length + " 張待簽核";
      }).catch(function () { /* 讀不到不影響使用 */ });
      if (can("erp_wms")) setupWmsUpdate();
      if (isAdmin && can("erp_wms")) {
        api("sched_get").then(function (res) {
          var n = document.getElementById("wms-sched-note");
          if (n && res.ok) n.textContent = scheduleSummary((res.schedules || {}).wms);
        }).catch(function () { /* 讀不到排程不影響使用 */ });
      }
      return;
    }

    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">首頁</a> / <a href="#/erp">ERP</a> / ' + esc(page.title) + '</div>' +
      '<h1 class="page-title">' + esc(page.title) + '</h1>' +
      '<div class="empty-state">此功能建置中</div>';
  }

  // ---------- Storage / inventory lookup (with edit) ----------

  var storageQuery = "";
  var STORAGE_MAX_SHOW = 100; // 關鍵字太短時結果可能上千筆,只顯示前 100 筆
  var PENDING_KEY = "wms_pending_edits";
  var PENDING_TTL_MS = 24 * 60 * 60 * 1000;
  var serverPending = {}; // row -> 尚未寫入 Excel 的修改(來自 Apps Script 中繼)

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function lsSet(key, value) {
    try {
      if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    } catch (e) { /* 無痕模式等情況略過 */ }
  }

  function loadLocalPending() {
    try { return JSON.parse(lsGet(PENDING_KEY) || "{}"); } catch (e) { return {}; }
  }

  // 已寫入 Excel 並發布(data.json 內容與修改相同)或超過 24 小時的暫存修改就移除
  function pruneLocalPending() {
    var pending = loadLocalPending();
    var byRow = {};
    (state.data.storageItems || []).forEach(function (it) { byRow[it.row] = it; });
    var changed = false;
    Object.keys(pending).forEach(function (row) {
      var p = pending[row], it = byRow[row];
      var synced = it && it.code === p.code && it.category === p.category && it.location === p.location && it.bin === p.bin;
      if (synced || Date.now() - p.ts > PENDING_TTL_MS) { delete pending[row]; changed = true; }
    });
    if (changed) lsSet(PENDING_KEY, JSON.stringify(pending));
  }

  function pendingFor(item) {
    var l = loadLocalPending()[item.row], s = serverPending[item.row];
    var p = l && (!s || l.ts >= s.ts) ? l : s;
    return p && p.code === item.code ? p : null;
  }

  function effectiveItem(item) {
    var p = pendingFor(item);
    if (!p) return item;
    return Object.assign({}, item, { category: p.category, location: p.location, bin: p.bin, pending: true });
  }

  function fetchServerPending() {
    if (!session) return Promise.resolve();
    return api("pending")
      .then(function (res) {
        var m = {};
        (res.pending || []).forEach(function (e) {
          if (!m[e.row] || m[e.row].ts < e.ts) m[e.row] = e;
        });
        serverPending = m;
      })
      .catch(function () { /* 讀不到待處理清單不影響查詢 */ });
  }

  function showToast(text) {
    var t = el('<div class="toast">' + esc(text) + '</div>');
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 4000);
  }

  function renderStorage(app) {
    var html = '';
    html += '<div class="breadcrumb"><a href="#/">首頁</a> / 庫存查詢</div>';
    html += '<h1 class="page-title">庫存查詢<span class="sub">材料品號/品名/規格/類別皆可用關鍵字查詢' +
      (can("edit") ? ';點擊卡片可編輯類別/儲放地點/儲位' : '') + '</span></h1>';
    html += '<div class="toolbar">' +
      '<div class="search-wrap">' +
        '<input type="search" id="storage-search" placeholder="輸入材料品號、品名、規格或類別關鍵字" autocomplete="off" value="' + esc(storageQuery) + '" />' +
        '<button type="button" class="search-clear" id="storage-clear" aria-label="清除搜尋"' + (storageQuery ? '' : ' hidden') + '>' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' +
        '</button>' +
      '</div>' +
    '</div>';
    html += '<p class="result-count" id="storage-result-count"></p>';
    html += '<div id="storage-container"></div>';
    app.innerHTML = html;

    var searchInput = document.getElementById("storage-search");
    var clearBtn = document.getElementById("storage-clear");
    searchInput.addEventListener("input", function (e) {
      storageQuery = e.target.value;
      clearBtn.hidden = !storageQuery;
      renderStorageResults();
    });
    clearBtn.addEventListener("click", function () {
      storageQuery = "";
      searchInput.value = "";
      clearBtn.hidden = true;
      renderStorageResults();
      searchInput.focus();
    });
    document.getElementById("storage-container").addEventListener("click", function (e) {
      var card = e.target.closest ? e.target.closest(".material-card[data-row]") : null;
      if (!card) return;
      var row = parseInt(card.getAttribute("data-row"), 10);
      var item = (state.data.storageItems || []).filter(function (it) { return it.row === row; })[0];
      if (item) openEditDialog(item);
    });

    pruneLocalPending();
    renderStorageResults();
    fetchServerPending().then(function () {
      if (document.getElementById("storage-container")) renderStorageResults();
    });
  }

  function renderStorageResults() {
    var rows = state.data.storageItems || [];
    var q = storageQuery.trim().toLowerCase();

    var countEl = document.getElementById("storage-result-count");
    var container = document.getElementById("storage-container");
    if (!container) return;

    if (!q) {
      if (countEl) countEl.textContent = "";
      container.innerHTML = '<div class="empty-state">請輸入關鍵字開始查詢</div>';
      return;
    }

    var results = rows.map(effectiveItem).filter(function (r) {
      return r.code.toLowerCase().indexOf(q) !== -1 ||
        r.name.toLowerCase().indexOf(q) !== -1 ||
        r.spec.toLowerCase().indexOf(q) !== -1 ||
        r.category.toLowerCase().indexOf(q) !== -1;
    });
    results.sort(function (a, b) {
      return a.code < b.code ? -1 : a.code > b.code ? 1 : (a.row || 0) - (b.row || 0);
    });

    var total = results.length;
    var truncated = total > STORAGE_MAX_SHOW;
    if (truncated) results = results.slice(0, STORAGE_MAX_SHOW);

    if (countEl) {
      countEl.textContent = truncated
        ? "符合 " + total + " 筆,僅顯示前 " + STORAGE_MAX_SHOW + " 筆,請輸入更完整的關鍵字縮小範圍"
        : "顯示 " + total + " / " + rows.length + " 筆物料";
    }

    if (!results.length) {
      container.innerHTML = '<div class="empty-state">查無符合的物料</div>';
      return;
    }

    var canEdit = can("edit");
    container.innerHTML = '<div class="storage-list">' + results.map(function (r) {
      var editable = canEdit && r.row;
      return (
        '<div class="material-card' + (editable ? ' editable' : '') + '"' + (editable ? ' data-row="' + r.row + '"' : '') + '>' +
          '<div class="material-card-top">' +
            '<div>' +
              '<div class="material-code">' + esc(r.code) + '</div>' +
              '<div class="material-name">' + esc(r.name) + '</div>' +
              (r.spec ? '<div class="material-spec">' + esc(r.spec) + '</div>' : '') +
            '</div>' +
            '<div class="chip-col">' +
              (r.pending ? '<span class="pending-chip">待寫入 Excel</span>' : '') +
              (editable ? '<span class="edit-chip">編輯</span>' : '') +
            '</div>' +
          '</div>' +
          '<div class="material-grid">' +
            '<div><span class="k">庫存數量:</span> <span class="v">' + fmtNum(r.stockQty) + '</span></div>' +
            '<div><span class="k">類別:</span> <span class="v">' + esc(r.category) + '</span></div>' +
            '<div class="full"><span class="k">儲放地點:</span> <span class="v">' + esc(r.location) + '</span></div>' +
            '<div class="full"><span class="k">儲位:</span> <span class="v">' + esc(r.bin) + '</span></div>' +
          '</div>' +
        '</div>'
      );
    }).join("") + '</div>';
  }

  function distinctValues(field) {
    var seen = {}, out = [];
    (state.data.storageItems || []).forEach(function (it) {
      var v = it[field];
      if (v && !seen[v]) { seen[v] = true; out.push(v); }
    });
    return out.sort();
  }

  // ---- 下拉選單項目(類別 / 儲放地點):存在雲端,所有登入者共用,可新增/刪除 ----
  var optionsCache = null; // { category: [...], location: [...] };欄位沒有時用現有資料的值當初始選項

  function loadOptions() {
    return api("options_get")
      .then(function (res) { if (res && res.ok) optionsCache = res.options || {}; })
      .catch(function () { /* 讀不到就用現有資料的值 */ });
  }

  function optionList(field) {
    return optionsCache && Array.isArray(optionsCache[field]) ? optionsCache[field] : distinctValues(field);
  }

  function changeOption(field, op, value) {
    return api("options_change", { field: field, op: op, value: value, seed: distinctValues(field) })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || "更新選單失敗");
        optionsCache = res.options || {};
      });
  }

  // 可輸入也可下拉選擇的欄位;選單內每個項目可刪除,輸入的新文字可加入選單
  function setupCombo(modal, field, msgEl) {
    var combo = modal.querySelector('.combo[data-field="' + field + '"]');
    var input = combo.querySelector("input");
    var toggle = combo.querySelector(".combo-toggle");
    var listEl = combo.querySelector(".combo-list");
    var busy = false;

    function isOpen() { return !listEl.hidden; }
    function close() { listEl.hidden = true; combo.classList.remove("open"); }

    function renderList(filtering) {
      var typed = input.value.trim();
      var q = typed.toLowerCase();
      var all = optionList(field);
      var shown = filtering && q ? all.filter(function (v) { return v.toLowerCase().indexOf(q) !== -1; }) : all;
      var html = shown.map(function (v) {
        return '<div class="combo-item" data-v="' + esc(v) + '">' +
          '<span class="combo-text">' + esc(v) + '</span>' +
          '<button type="button" class="combo-del" data-del="' + esc(v) + '" aria-label="從選單刪除 ' + esc(v) + '">✕</button>' +
        '</div>';
      }).join("");
      if (typed && all.indexOf(typed) === -1) {
        html += '<div class="combo-add" data-add="' + esc(typed) + '">＋ 新增「' + esc(typed) + '」到選單</div>';
      }
      if (!html) html = '<div class="combo-empty">選單目前是空的,輸入文字後可新增</div>';
      listEl.innerHTML = html;
      listEl.hidden = false;
      combo.classList.add("open");
    }

    toggle.addEventListener("click", function () {
      if (isOpen()) close(); else renderList(false);
    });
    input.addEventListener("input", function () {
      if (isOpen()) renderList(true);
    });

    listEl.addEventListener("click", function (e) {
      if (busy) return;
      var t = e.target;
      var del = t.closest ? t.closest("[data-del]") : null;
      var add = t.closest ? t.closest("[data-add]") : null;
      var item = t.closest ? t.closest(".combo-item") : null;

      if (del) {
        var v = del.getAttribute("data-del");
        if (!window.confirm("確定要從選單刪除「" + v + "」嗎?\n(已設定此值的物料不受影響)")) return;
        busy = true;
        changeOption(field, "remove", v)
          .then(function () { msgEl.textContent = ""; renderList(false); })
          .catch(function (err) { msgEl.textContent = err.message; })
          .then(function () { busy = false; });
      } else if (add) {
        busy = true;
        changeOption(field, "add", add.getAttribute("data-add"))
          .then(function () { msgEl.textContent = ""; renderList(false); })
          .catch(function (err) { msgEl.textContent = err.message; })
          .then(function () { busy = false; });
      } else if (item) {
        input.value = item.getAttribute("data-v");
        close();
      }
    });

    // 點選單以外的地方就收起來
    modal.addEventListener("click", function (e) {
      if (isOpen() && !(e.target.closest && e.target.closest('.combo[data-field="' + field + '"]'))) close();
    });

    return { refresh: function () { if (isOpen()) renderList(false); } };
  }

  function comboHtml(field, label, value) {
    return (
      '<div class="field">' +
        '<span class="field-label">' + label + '</span>' +
        '<div class="combo" data-field="' + field + '">' +
          '<input type="text" id="edit-' + field + '" maxlength="100" autocomplete="off" value="' + esc(value) + '" />' +
          '<button type="button" class="combo-toggle" aria-label="展開' + label + '選單">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>' +
          '</button>' +
          '<div class="combo-list" hidden></div>' +
        '</div>' +
      '</div>'
    );
  }

  function openEditDialog(rawItem) {
    var item = effectiveItem(rawItem);
    var modal = el(
      '<div class="modal-backdrop">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="edit-title">' +
          '<h2 id="edit-title">編輯儲位資料</h2>' +
          '<div class="modal-info">' +
            '<div class="material-code">' + esc(item.code) + '</div>' +
            '<div class="material-name">' + esc(item.name) + '</div>' +
            (item.spec ? '<div class="material-spec">' + esc(item.spec) + '</div>' : '') +
            '<div class="material-spec">庫存數量: ' + fmtNum(item.stockQty) + '</div>' +
          '</div>' +
          comboHtml("category", "類別", item.category) +
          comboHtml("location", "儲放地點", item.location) +
          '<label>儲位<input type="text" id="edit-bin" maxlength="100" value="' + esc(item.bin) + '" /></label>' +
          '<p class="modal-msg" id="edit-msg"></p>' +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn-secondary" id="edit-cancel">取消</button>' +
            '<button type="button" class="btn" id="edit-save">儲存</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
    document.body.appendChild(modal);

    var msg = modal.querySelector("#edit-msg");
    var saveBtn = modal.querySelector("#edit-save");

    var combos = [setupCombo(modal, "category", msg), setupCombo(modal, "location", msg)];
    loadOptions().then(function () { combos.forEach(function (c) { c.refresh(); }); });

    function close() {
      document.removeEventListener("keydown", onKey);
      if (modal.parentNode) modal.parentNode.removeChild(modal);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    modal.querySelector("#edit-cancel").addEventListener("click", close);

    saveBtn.addEventListener("click", function () {
      var vals = {
        category: modal.querySelector("#edit-category").value.trim(),
        location: modal.querySelector("#edit-location").value.trim(),
        bin: modal.querySelector("#edit-bin").value.trim()
      };
      if (vals.category === item.category && vals.location === item.location && vals.bin === item.bin) {
        msg.textContent = "內容沒有變更";
        return;
      }
      msg.textContent = "儲存中…";
      saveBtn.disabled = true;

      api("save", {
        row: item.row, code: item.code, name: item.name, spec: item.spec,
        stock: item.stockQty, category: vals.category, location: vals.location, bin: vals.bin
      })
        .then(function (res) {
          if (!res.ok) throw new Error(res.error || "儲存失敗");
          var pending = loadLocalPending();
          pending[item.row] = { row: item.row, code: item.code, category: vals.category, location: vals.location, bin: vals.bin, ts: Date.now() };
          lsSet(PENDING_KEY, JSON.stringify(pending));
          close();
          renderStorageResults();
          showToast("已送出,稍後會寫入 Excel 並更新網站");
        })
        .catch(function (err) {
          if (!session) { close(); return; } // 登入已失效,已切換到登入畫面
          msg.textContent = err.message;
          saveBtn.disabled = false;
        });
    });
  }

  // ---------- 收料:確認視窗 + 送出(本機排程寫入 WMS.xlsx 的「收料」工作表) ----------

  var recvRows = [];       // 目前畫面上有收料鈕的物料列(按鈕用索引找回資料)
  var recvOrderOf = null;  // 物料列 -> 製令編號

  function recvIndex(r) {
    var i = recvRows.indexOf(r);
    if (i === -1) { recvRows.push(r); i = recvRows.length - 1; }
    return i;
  }

  function receiveBtnHtml(r) {
    if (!can("receive")) return "";
    // 沒有採購單號、且庫存已經夠用(庫存數量 ≥ 需求數量):不需要收料,收料鍵反白(停用)
    var hasPo = (r.poNos || []).some(function (p) { return String(p || "").trim() !== ""; });
    var noNeed = !hasPo && (Number(r.stockQty) || 0) >= (Number(r.needQty) || 0);
    if (noNeed) {
      return '<button type="button" class="recv-btn" disabled title="無採購單且庫存已足夠,不需收料">收料</button>';
    }
    return '<button type="button" class="recv-btn" data-recv="' + recvIndex(r) + '">收料</button>';
  }

  function orderOfRow(r) {
    if (!recvOrderOf) {
      recvOrderOf = new Map();
      var m = state.data.materials || {};
      Object.keys(m).forEach(function (o) { m[o].forEach(function (row) { recvOrderOf.set(row, o); }); });
    }
    return recvOrderOf.get(r) || "";
  }

  function defaultReceiveQty(r) {
    var d = (Number(r.needQty) || 0) - (Number(r.receivedQty) || 0); // 預設:還沒收的數量
    if (!(d > 0)) d = Number(r.needQty) || 0;
    return d > 0 ? d : 1;
  }

  // ---------- 退料:查「進退貨履歷」找出已進貨的單據 ----------
  // 履歷來自 WMS.xlsx「進退貨履歷」工作表(進貨單簽核成功時由電腦端寫入),隨網站資料一起發布(state.data.history)。
  // 一列物料能退料的條件:履歷裡有這個物料的「進貨」紀錄,且(進貨合計 − 退貨合計)> 0。

  function historyIndex() {
    var d = state.data;
    if (!d) return {};
    if (d.__hidx) return d.__hidx;
    var idx = {};
    (d.history || []).forEach(function (h) { (idx[h.code] = idx[h.code] || []).push(h); });
    d.__hidx = idx;
    return idx;
  }

  // 回傳 { cands: [進貨紀錄(新的在前)], net: 可退數量 } 或 null(沒有進貨紀錄 / 已全數退料)
  // 比對方式:物料列有採購單號、而且履歷有同一採購單序號的紀錄,就只看那些採購單;
  // 否則(例如採購單已收完、WMS 更新後物料列不再帶採購單號)改看這個品號所有的進貨 / 退貨紀錄。
  function returnInfo(r) {
    var rows = historyIndex()[String(r.materialCode || "").trim()];
    if (!rows || !rows.length) return null;
    var pos = {}, hasPo = false;
    (r.poNos || []).forEach(function (p) { p = String(p || "").trim(); if (p) { pos[p] = true; hasPo = true; } });
    var byPo = hasPo ? rows.filter(function (h) { return pos[h.po]; }) : [];
    var use = byPo.length ? byPo : rows;
    var cands = [], net = 0;
    use.forEach(function (h) {
      if (h.kind === "進貨") { cands.push(h); net += Number(h.qty) || 0; } else { net -= Number(h.qty) || 0; }
    });
    if (!cands.length || !(net > 0)) return null;
    return { cands: cands.slice().reverse(), net: net };
  }

  function returnBtnHtml(r) {
    if (!can("ret")) return "";
    // 尚未收料(履歷沒有進貨紀錄)或已全數退料:退料鍵反白(停用)
    if (!returnInfo(r)) {
      return '<button type="button" class="ret-btn" disabled title="尚未收料(進退貨履歷沒有進貨紀錄)或已全數退料,不能退料">退料</button>';
    }
    return '<button type="button" class="ret-btn" data-ret="' + recvIndex(r) + '">退料</button>';
  }

  function openReturnDialog(r) {
    var info = returnInfo(r);
    if (!info) { showToast("進退貨履歷找不到這項物料的進貨紀錄(或已全數退料),無法退料"); return; }
    var vendors = r.vendors || [], vendorOf = {};
    (r.poNos || []).forEach(function (p, i) { vendorOf[String(p || "").trim()] = vendors[i] || vendors[0] || ""; });
    var pairs = info.cands.map(function (h) {
      var q = Number(h.qty) || 0;
      return { po: h.po, vendor: h.vendor || vendorOf[h.po] || "", docType: h.docType, docNo: h.docNo, qty: q, defQty: Math.min(q, info.net) };
    });
    openReceiveDialog(r, { mode: "return", pairs: pairs, qty: pairs[0].defQty });
  }

  // opts(可省略): { mode: "return"(退料,多進貨單別/單號欄位), pairs: [{po, vendor, order, docType, docNo, qty, defQty}], qty, warn, onSent, onClose }
  function openReceiveDialog(r, opts) {
    opts = opts || {};
    var isRet = opts.mode === "return";
    var pos = r.poNos || [], vendors = r.vendors || [];
    var pairs = opts.pairs || pos.map(function (po, i) { return { po: po, vendor: vendors[i] || vendors[0] || "" }; });
    if (!pairs.length) pairs = [{ po: "", vendor: vendors[0] || "" }];

    // 此物料有多張採購單(退料:多張進貨單)時,先用下拉選單挑一組(會帶入下面的欄位);欄位一律可以直接修改
    var pickHtml = "";
    if (pairs.length > 1) {
      pickHtml =
        '<div class="field"><span class="field-label">' + (isRet ? '此物料有多張進貨單,請選擇' : '此物料有多張採購單,請選擇') + '</span>' +
        '<select id="recv-pair">' + pairs.map(function (p, i) {
          return '<option value="' + i + '">' + (isRet
            ? esc((p.docType || "") + "-" + (p.docNo || "")) + ' · ' + esc(p.po) + ' · 數量 ' + esc(fmtNum(p.qty))
            : esc(p.po) + ' — ' + esc(p.vendor)) + '</option>';
        }).join("") + '</select></div>';
    }
    var docHtml = isRet
      ? '<div class="field"><span class="field-label">進貨單別(可修改)</span>' +
          '<input type="text" id="recv-doctype" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" /></div>' +
        '<div class="field"><span class="field-label">進貨單號(可修改)</span>' +
          '<input type="text" id="recv-docno" maxlength="40" autocomplete="off" autocapitalize="off" spellcheck="false" /></div>'
      : '';

    var modal = el(
      '<div class="modal-backdrop">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="recv-title">' +
          '<h2 id="recv-title">' + (isRet ? '確認退料' : '確認收料') + '</h2>' +
          '<div class="modal-info recv-info">' +
            '<div class="recv-info-row"><span class="k">品號</span><span class="v" id="recv-code"></span></div>' +
            '<div class="recv-info-row"><span class="k">品名</span><span class="v" id="recv-name"></span></div>' +
          '</div>' +
          pickHtml +
          '<div class="field"><span class="field-label">廠商(可修改)</span>' +
            '<input type="text" id="recv-vendor" maxlength="100" autocomplete="off" /></div>' +
          '<div class="field"><span class="field-label">採購單號(可修改)</span>' +
            '<input type="text" id="recv-po" maxlength="100" autocomplete="off" autocapitalize="off" spellcheck="false" /></div>' +
          docHtml +
          '<div class="field"><span class="field-label">數量(可修改)</span>' +
            '<input type="number" id="recv-qty" inputmode="decimal" min="0" step="any" /></div>' +
          '<p class="modal-msg" id="recv-msg"></p>' +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn-secondary" id="recv-cancel">取消</button>' +
            '<button type="button" class="btn" id="recv-ok">確認</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
    document.body.appendChild(modal);

    // 用 textContent / value 填入,避免任何特殊字元被當成 HTML
    var vEl = modal.querySelector("#recv-vendor"), pEl = modal.querySelector("#recv-po");
    var dtEl = modal.querySelector("#recv-doctype"), dnEl = modal.querySelector("#recv-docno");
    var qtyEl = modal.querySelector("#recv-qty");
    var pairSel = modal.querySelector("#recv-pair");
    function curPair() { return pairs[pairSel ? parseInt(pairSel.value, 10) : 0] || pairs[0]; }
    function fillPair(changed) {
      var p = curPair();
      vEl.value = p.vendor || "";
      pEl.value = p.po || "";
      if (isRet) {
        dtEl.value = p.docType || "";
        dnEl.value = p.docNo || "";
        if (changed && p.defQty > 0) qtyEl.value = p.defQty;   // 換一張進貨單,數量預設改成那張的可退數量
      }
    }
    fillPair(false);
    if (pairSel) pairSel.addEventListener("change", function () { fillPair(true); });
    modal.querySelector("#recv-code").textContent = r.materialCode;
    modal.querySelector("#recv-name").textContent = r.materialName;
    qtyEl.value = opts.qty > 0 ? opts.qty : defaultReceiveQty(r);

    var msg = modal.querySelector("#recv-msg"), okBtn = modal.querySelector("#recv-ok");
    if (opts.warn) msg.textContent = opts.warn;
    function close() {
      document.removeEventListener("keydown", onKey);
      if (modal.parentNode) modal.parentNode.removeChild(modal);
      if (opts.onClose) { var f = opts.onClose; opts.onClose = null; f(); }
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    modal.querySelector("#recv-cancel").addEventListener("click", close);

    okBtn.addEventListener("click", function () {
      var qty = Number(qtyEl.value);
      if (!(qty > 0)) { msg.textContent = "數量必須大於 0"; return; }
      var pair = curPair();
      var payload = {
        order: pair.order || orderOfRow(r), vendor: vEl.value.trim(), po: pEl.value.trim(),
        code: r.materialCode, name: r.materialName, qty: qty
      };
      if (isRet) {
        payload.docType = dtEl.value.trim();
        payload.docNo = dnEl.value.trim();
        if (!payload.docType || !payload.docNo) { msg.textContent = "請填入進貨單別與進貨單號"; return; }
      }
      msg.textContent = "送出中…";
      okBtn.disabled = true;
      api(isRet ? "return" : "receive", payload)
        .then(function (res) {
          if (!res.ok) throw new Error(res.error || "送出失敗");
          if (opts.onSent) opts.onSent();
          close();
          showToast(isRet ? "已送出退料,稍後會寫入 Excel「退料」工作表" : "已送出收料,稍後會寫入 Excel「收料」工作表");
        })
        .catch(function (err) {
          if (!session) { close(); return; } // 登入已失效,已切換到登入畫面
          msg.textContent = err.message;
          okBtn.disabled = false;
        });
    });
  }

  // ---------- 掃描 QR code 收料(手機限定;iOS / Android 共用) ----------
  // QR 內容: 系列號碼#廠商#採購單別-單號#材料品號#品名#規格#數量
  // 掃到後依「採購單別-單號 + 材料品號」在資料庫找出物料,開啟收料確認視窗;按下確認(或取消)後回到掃描。

  var SCAN_SN_KEY = "wms_scan_sn";
  var scanner = null; // 掃描中的狀態;沒在掃描時為 null

  function isMobileDevice() {
    var ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
    return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1; // iPadOS 會偽裝成 Mac
  }

  function parseScanText(text) {
    var p = String(text || "").trim().split("#");
    if (p.length < 7) return null;
    var qty = Number(p[p.length - 1]);
    return {
      sn: p[0].trim(), vendor: p[1].trim(), po: p[2].trim(), code: p[3].trim(),
      name: p[4].trim(), spec: p.slice(5, -1).join("#").trim(), qty: qty
    };
  }

  // 在資料庫找出符合的物料。回傳 { row, pairs } 或 { error }
  function findScanMatch(q) {
    var mats = state.data && state.data.materials;
    if (!mats) return { error: "資料尚未載入完成,請稍候再掃" };
    var code = q.code.toLowerCase(), po = q.po;
    var codeHit = false, seen = {}, pairs = [], first = null;
    Object.keys(mats).forEach(function (order) {
      mats[order].forEach(function (row) {
        if (String(row.materialCode || "").trim().toLowerCase() !== code) return;
        codeHit = true;
        (row.poNos || []).forEach(function (p, i) {
          p = String(p || "").trim();
          if (!p || !(p === po || p.indexOf(po + "-") === 0)) return;
          if (seen[p]) return; // 同一張採購單序號只留一筆
          seen[p] = true;
          if (!first) first = row;
          pairs.push({ po: p, vendor: (row.vendors || [])[i] || (row.vendors || [])[0] || q.vendor, order: order });
        });
      });
    });
    if (first) return { row: first, pairs: pairs };
    if (codeHit) return { error: "找到品號 " + q.code + ",但沒有採購單 " + q.po };
    return { error: "資料庫找不到品號 " + q.code + "(採購單 " + q.po + ");新資料可能還沒更新,請按重新整理" };
  }

  function scanSnSeen(sn) {
    try { var m = JSON.parse(lsGet(SCAN_SN_KEY) || "{}"); return m[sn] || 0; } catch (e) { return 0; }
  }

  function scanSnMark(sn) {
    var m = {};
    try { m = JSON.parse(lsGet(SCAN_SN_KEY) || "{}"); } catch (e) { m = {}; }
    m[sn] = Date.now();
    var keys = Object.keys(m).sort(function (a, b) { return m[b] - m[a]; });
    keys.slice(300).forEach(function (k) { delete m[k]; });
    lsSet(SCAN_SN_KEY, JSON.stringify(m));
  }

  function fmtScanTime(ts) {
    var d = new Date(ts), p = function (n) { return n < 10 ? "0" + n : "" + n; };
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function loadJsQr() {
    if (window.jsQR) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "vendor/jsQR.min.js";
      s.onload = function () { window.jsQR ? resolve() : reject(new Error("QR 解碼程式載入失敗")); };
      s.onerror = function () { reject(new Error("QR 解碼程式載入失敗")); };
      document.head.appendChild(s);
    });
  }

  // 回傳 function(video) -> Promise<string|null>:Android 等有內建辨識的用內建,其餘(iOS)用 jsQR
  function makeQrReader() {
    function viaJsQr() {
      return loadJsQr().then(function () {
        var canvas = document.createElement("canvas");
        var ctx = canvas.getContext("2d", { willReadFrequently: true });
        return function (video) {
          var vw = video.videoWidth, vh = video.videoHeight;
          if (!vw || !vh) return Promise.resolve(null);
          var scale = Math.min(1, 720 / Math.max(vw, vh));
          canvas.width = Math.round(vw * scale);
          canvas.height = Math.round(vh * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          var res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          return Promise.resolve(res ? res.data : null);
        };
      });
    }
    if (!("BarcodeDetector" in window)) return viaJsQr();
    return Promise.resolve()
      .then(function () { return BarcodeDetector.getSupportedFormats ? BarcodeDetector.getSupportedFormats() : ["qr_code"]; })
      .then(function (formats) {
        if (formats.indexOf("qr_code") === -1) return viaJsQr();
        var det = new BarcodeDetector({ formats: ["qr_code"] });
        return function (video) {
          return det.detect(video).then(function (codes) { return codes.length ? codes[0].rawValue : null; });
        };
      })
      .catch(viaJsQr);
  }

  function setScanStatus(text, kind) {
    if (!scanner) return;
    scanner.statusEl.textContent = text;
    scanner.statusEl.className = "scan-status" + (kind ? " " + kind : "");
  }

  function closeScanner() {
    var s = scanner;
    if (!s) return;
    scanner = null;
    s.stopped = true;
    if (s.timer) clearTimeout(s.timer);
    if (s.raf) cancelAnimationFrame(s.raf);
    try { s.stream && s.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 略過 */ }
    try { s.wake && s.wake.release(); } catch (e) { /* 略過 */ }
    if (s.root.parentNode) s.root.parentNode.removeChild(s.root);
    document.body.classList.remove("scan-open");
  }

  function handleScanned(raw) {
    var s = scanner;
    if (!s) return;
    var now = Date.now();
    // 同一張標籤還在鏡頭前時不重複處理;離開鏡頭 1.5 秒後再掃到才算新的一次
    if (raw === s.lastRaw && now - s.lastSeen < 1500) { s.lastSeen = now; return; }
    s.lastRaw = raw; s.lastSeen = now;
    if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) { /* 略過 */ } }

    var q = parseScanText(raw);
    if (!q) { setScanStatus("不是收料用的 QR code(格式不符)", "err"); return; }
    var m = findScanMatch(q);
    if (m.error) { setScanStatus(m.error, "err"); return; }

    var warn = "";
    var seenAt = q.sn ? scanSnSeen(q.sn) : 0;
    if (seenAt) warn = "⚠ 序號 " + q.sn + " 已在 " + fmtScanTime(seenAt) + " 送出過收料,請確認是否重複";
    s.busy = true;
    setScanStatus("確認收料中…");
    openReceiveDialog(m.row, {
      pairs: m.pairs,
      qty: q.qty,
      warn: warn,
      onSent: function () { if (q.sn) scanSnMark(q.sn); },
      onClose: function () {
        if (!scanner) return;
        scanner.busy = false;
        scanner.lastSeen = Date.now(); // 標籤多半還在鏡頭前,從現在起算
        setScanStatus("請對準下一個 QR code");
      }
    });
  }

  function playScanVideo(s) {
    if (!s || s.stopped || !s.video || !s.video.srcObject || !s.video.paused) return;
    var p = s.video.play();
    if (p && p.catch) p.catch(function () { /* 被瀏覽器擋下時,下一輪迴圈或點一下畫面會再試 */ });
  }

  // 預覽畫面改畫在 canvas 上(把 video 的每一格影像畫上去,滿版裁切)。
  // iPhone 上 <video> 本身可能顯示全黑,但影格讀得到(能掃出資料),所以不直接顯示 video。
  function paintScan(s) {
    if (!s || s.stopped) return;
    var now = Date.now();
    if (now - s.lastPaint >= 30) {
      s.lastPaint = now;
      var c = s.view, v = s.video;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var cw = Math.round(c.clientWidth * dpr), ch = Math.round(c.clientHeight * dpr);
      if (cw && ch && (c.width !== cw || c.height !== ch)) { c.width = cw; c.height = ch; }
      if (v.videoWidth && v.videoHeight && v.readyState >= 2 && c.width && c.height) {
        var k = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
        var dw = v.videoWidth * k, dh = v.videoHeight * k;
        try { s.vctx.drawImage(v, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh); } catch (e) { /* 這一格略過 */ }
      }
    }
    s.raf = requestAnimationFrame(function () { paintScan(s); });
  }

  function scanLoop() {
    var s = scanner;
    if (!s || s.stopped) return;
    if (!session) { closeScanner(); return; }
    // 小字顯示相機狀態,方便回報問題(解析度/播放中)
    s.infoEl.textContent = "相機 " + (s.video.videoWidth || 0) + "×" + (s.video.videoHeight || 0) + (s.video.paused ? " · 暫停" : " · 播放中");
    playScanVideo(s); // 影片被系統暫停(例如 iOS)時自動恢復播放,畫面才看得到實物
    var next = function () { if (scanner === s && !s.stopped) s.timer = setTimeout(scanLoop, 140); };
    if (s.busy || !s.read || s.video.readyState < 2) { next(); return; }
    s.read(s.video).then(function (raw) { if (raw && scanner === s && !s.busy) handleScanned(raw); })
      .catch(function () { /* 單張影像辨識失敗,略過 */ })
      .then(next);
  }

  function openScanner() {
    if (scanner || !session) return;
    if (!can("receive")) { showToast("你的帳號沒有收料權限"); return; }
    var root = el(
      '<div class="scan-overlay" role="dialog" aria-label="掃描 QR code 收料">' +
        '<video class="scan-video" playsinline muted autoplay></video>' +
        '<canvas class="scan-view"></canvas>' +
        '<div class="scan-frame"><i></i></div>' +
        '<div class="scan-top"><span class="scan-title">掃描 QR code 收料</span>' +
          '<button type="button" class="scan-exit">退出</button></div>' +
        '<div class="scan-info"></div>' +
        '<div class="scan-status">啟動相機中…</div>' +
      '</div>'
    );
    document.body.appendChild(root);
    document.body.classList.add("scan-open");
    var view = root.querySelector(".scan-view");
    scanner = {
      root: root, video: root.querySelector("video"), statusEl: root.querySelector(".scan-status"),
      view: view, vctx: view.getContext("2d"), infoEl: root.querySelector(".scan-info"), raf: 0, lastPaint: 0,
      stream: null, read: null, busy: false, stopped: false, lastRaw: "", lastSeen: 0, timer: null, wake: null
    };
    var s = scanner;
    // iOS Safari:用 HTML 字串建立的 video,muted 屬性不會生效,影片不會播放(畫面全黑但仍抓得到影格),要用程式明確設定
    s.video.muted = true;
    s.video.defaultMuted = true;
    s.video.playsInline = true;
    s.video.setAttribute("playsinline", "");
    s.video.setAttribute("webkit-playsinline", "");
    root.querySelector(".scan-exit").addEventListener("click", closeScanner);
    root.addEventListener("click", function () { playScanVideo(s); }); // 保底:點一下畫面也會重新嘗試播放

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setScanStatus("這個瀏覽器無法使用相機(需要 https 網址)", "err");
      return;
    }
    Promise.all([
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      }),
      makeQrReader()
    ]).then(function (res) {
      if (scanner !== s) { res[0].getTracks().forEach(function (t) { t.stop(); }); return; } // 載入期間已退出
      s.stream = res[0];
      s.read = res[1];
      s.video.srcObject = s.stream;
      s.video.addEventListener("loadedmetadata", function () { playScanVideo(s); });
      playScanVideo(s);
      paintScan(s);
      setScanStatus("對準物品上的 QR code");
      try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then(function (w) { s.wake = w; }, function () {}); } catch (e) { /* 略過 */ }
      scanLoop();
    }).catch(function (err) {
      if (scanner !== s) return;
      var name = err && err.name;
      var text = (name === "NotAllowedError" || name === "SecurityError")
        ? "相機權限被拒絕,請到手機設定允許本網站使用相機後再試"
        : (name === "NotFoundError" || name === "OverconstrainedError") ? "找不到可用的相機"
        : (err && err.message) || "相機啟動失敗";
      setScanStatus(text, "err");
    });
  }

  // 從背景回到前景時,相機可能已被系統停止:停止中的畫面直接退出,避免卡在黑畫面
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || !scanner || !scanner.stream) return;
    var live = scanner.stream.getTracks().some(function (t) { return t.readyState === "live"; });
    if (!live) { closeScanner(); showToast("相機已中斷,請重新按「掃描」"); }
  });

  // ---------- Shared markup helpers ----------

  function orderInfoPanelHtml(order, orderNo) {
    var dashIdx = orderNo.indexOf("-");
    var orderPrefix = dashIdx > -1 ? orderNo.slice(0, dashIdx) : orderNo;
    var orderSuffix = dashIdx > -1 ? orderNo.slice(dashIdx + 1) : "";
    return (
      '<div class="info-panel">' +
        '<div class="row"><span class="k">母製令號</span><span class="v">' + esc(orderNo) + '</span></div>' +
        '<div class="row"><span class="k">製令單別</span><span class="v">' + esc(orderPrefix) + '</span></div>' +
        (orderSuffix ? '<div class="row"><span class="k">製令單號</span><span class="v">' + esc(orderSuffix) + '</span></div>' : '') +
        '<div class="row"><span class="k">產品品號</span><span class="v v-strong">' + esc(order.productCode) + '</span></div>' +
        '<div class="row"><span class="k">產品品名</span><span class="v v-strong">' + esc(order.productName) + '</span></div>' +
        '<div class="row"><span class="k">規格</span><span class="v">' + esc(order.spec) + '</span></div>' +
        '<div class="row"><span class="k">製令狀態</span><span class="v">' + esc(order.status) + '</span></div>' +
        (order.note ? '<div class="row"><span class="k">備註</span><span class="v">' + esc(order.note) + '</span></div>' : '') +
      '</div>'
    );
  }

  function toolbarHtml(ids, f, exportLabel) {
    return (
      '<div class="toolbar toolbar-material">' +
        '<input type="search" id="' + ids.search + '" placeholder="搜尋 (品號 / 品名 / 規格 / 廠商 / 採購單號)" value="' + esc(f.query) + '" />' +
        '<select id="' + ids.status + '">' +
          '<option value="">到料:全部</option>' +
          '<option value="已到料"' + (f.status === "已到料" ? " selected" : "") + '>已到料</option>' +
          '<option value="未到料"' + (f.status === "未到料" ? " selected" : "") + '>未到料</option>' +
        '</select>' +
        '<select id="' + ids.issueStatus + '">' +
          '<option value=""' + (f.issueStatus === "" ? " selected" : "") + '>領料:全部</option>' +
          '<option value="未領"' + (f.issueStatus === "未領" ? " selected" : "") + '>未領</option>' +
          '<option value="已領"' + (f.issueStatus === "已領" ? " selected" : "") + '>已領</option>' +
        '</select>' +
        '<select id="' + ids.poStatus + '">' +
          '<option value=""' + (!f.poStatus ? " selected" : "") + '>採購單:全部</option>' +
          '<option value="已下單"' + (f.poStatus === "已下單" ? " selected" : "") + '>已下單</option>' +
          '<option value="未下單"' + (f.poStatus === "未下單" ? " selected" : "") + '>未下單</option>' +
        '</select>' +
        '<button class="btn btn-export" id="' + ids.exportBtn + '" type="button">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>' +
          '<span class="lbl-long">' + esc(exportLabel) + '</span><span class="lbl-short">Excel</span>' +
        '</button>' +
      '</div>'
    );
  }

  // ---------- Project detail (shared toolbar + all orders' full material tables inline) ----------

  function renderProject(app, code) {
    var project = state.data.projects.find(function (p) { return p.code === code; });
    if (!project) {
      app.innerHTML = '<div class="breadcrumb"><a href="#/">首頁</a></div><div class="empty-state">找不到專案 ' + esc(code) + '</div>';
      return;
    }

    var f = getProjectFilterState(code);

    var html = '';
    html += '<div class="breadcrumb"><a href="#/">首頁</a> / ' + esc(project.code) + '</div>';
    html += '<h1 class="page-title">' + esc(project.code) + '<span class="sub">' + esc(project.name) + ' · 共 ' + project.orders.length + ' 筆製令</span></h1>';
    html += toolbarHtml({ search: "project-search", status: "project-status", issueStatus: "project-issue-status", poStatus: "project-po-status", exportBtn: "project-export" }, f, "下載為 Excel (全部製令)");
    html += '<p class="result-count" id="project-result-count"></p>';

    project.orders.forEach(function (o) {
      html +=
        '<section class="order-section" id="order-' + esc(o.orderNo) + '">' +
          '<div class="order-section-head">' +
            '<a class="order-link" href="#/order/' + encodeURIComponent(o.orderNo) + '">' + esc(o.orderNo) + '</a>' +
            '<span class="status-pill ' + statusPillClass(o.status) + '">' + esc(o.status || "-") + '</span>' +
          '</div>' +
          orderInfoPanelHtml(o, o.orderNo) +
          '<p class="result-count" id="' + sectionIds(o.orderNo).count + '"></p>' +
          '<div id="' + sectionIds(o.orderNo).container + '"></div>' +
        '</section>';
    });

    app.innerHTML = html;

    document.getElementById("project-search").addEventListener("input", function (e) {
      getProjectFilterState(code).query = e.target.value;
      renderProjectMaterials(project);
    });
    document.getElementById("project-status").addEventListener("change", function (e) {
      getProjectFilterState(code).status = e.target.value;
      renderProjectMaterials(project);
    });
    document.getElementById("project-issue-status").addEventListener("change", function (e) {
      getProjectFilterState(code).issueStatus = e.target.value;
      renderProjectMaterials(project);
    });
    document.getElementById("project-po-status").addEventListener("change", function (e) {
      getProjectFilterState(code).poStatus = e.target.value;
      renderProjectMaterials(project);
    });
    document.getElementById("project-export").addEventListener("click", function () {
      exportProjectToExcel(project);
    });

    renderProjectMaterials(project);
  }

  function renderProjectMaterials(project) {
    var f = getProjectFilterState(project.code);
    var filtering = !!(f.query.trim() || f.status || f.issueStatus || f.poStatus);
    var totalAll = 0, totalMatched = 0, sectionsWithResults = 0;

    project.orders.forEach(function (o) {
      var allRows = state.data.materials[o.orderNo] || [];
      var rows = filterRows(allRows, f);
      totalAll += allRows.length;
      totalMatched += rows.length;

      var sectionEl = document.getElementById("order-" + o.orderNo);
      if (filtering && rows.length === 0) {
        if (sectionEl) sectionEl.style.display = "none";
        return;
      }
      if (sectionEl) sectionEl.style.display = "";
      sectionsWithResults++;
      renderRowsIntoIds(sectionIds(o.orderNo), rows, allRows.length);
    });

    var countEl = document.getElementById("project-result-count");
    if (countEl) {
      countEl.textContent = "顯示 " + totalMatched + " / " + totalAll + " 筆物料" +
        (filtering ? "(符合條件的製令: " + sectionsWithResults + " / " + project.orders.length + ")" : "");
    }
  }

  // ---------- Order detail (single material list, deep-link target) ----------

  function renderOrder(app, orderNo) {
    var found = state.orderIndex[orderNo];
    if (!found) {
      app.innerHTML = '<div class="breadcrumb"><a href="#/">首頁</a></div><div class="empty-state">找不到製令 ' + esc(orderNo) + '</div>';
      return;
    }

    var project = found.project;
    var order = found.order;
    var f = getFilterState(orderNo);

    var html = '';
    html += '<div class="breadcrumb"><a href="#/">首頁</a> / <a href="#/project/' + encodeURIComponent(project.code) + '">' + esc(project.code) + '</a> / ' + esc(orderNo) + '</div>';
    html += '<h1 class="page-title">製令 ' + esc(orderNo) + '<span class="sub">物料明細</span></h1>';
    html += orderInfoPanelHtml(order, orderNo);
    html += toolbarHtml({ search: "search-input", status: "status-select", issueStatus: "issue-status-select", poStatus: "po-status-select", exportBtn: "export-btn" }, f, "下載為 Excel");
    html += '<p class="result-count" id="' + sectionIds(orderNo).count + '"></p>';
    html += '<div id="' + sectionIds(orderNo).container + '"></div>';

    app.innerHTML = html;

    document.getElementById("search-input").addEventListener("input", function (e) {
      getFilterState(orderNo).query = e.target.value;
      renderOrderMaterials(orderNo, project, order);
    });
    document.getElementById("status-select").addEventListener("change", function (e) {
      getFilterState(orderNo).status = e.target.value;
      renderOrderMaterials(orderNo, project, order);
    });
    document.getElementById("issue-status-select").addEventListener("change", function (e) {
      getFilterState(orderNo).issueStatus = e.target.value;
      renderOrderMaterials(orderNo, project, order);
    });
    document.getElementById("po-status-select").addEventListener("change", function (e) {
      getFilterState(orderNo).poStatus = e.target.value;
      renderOrderMaterials(orderNo, project, order);
    });
    document.getElementById("export-btn").addEventListener("click", function () {
      exportOrderToExcel(orderNo, project, order);
    });

    renderOrderMaterials(orderNo, project, order);
  }

  function renderOrderMaterials(orderNo) {
    var allRows = state.data.materials[orderNo] || [];
    var rows = filterRows(allRows, getFilterState(orderNo));
    renderRowsIntoIds(sectionIds(orderNo), rows, allRows.length);
  }

  // ---------- Material table rendering (shared) ----------

  function renderRowsIntoIds(ids, rows, total) {
    var countEl = document.getElementById(ids.count);
    if (countEl) countEl.textContent = "顯示 " + rows.length + " / " + total + " 筆物料";

    var container = document.getElementById(ids.container);
    if (!container) return;
    container.innerHTML = buildMaterialListHtml(rows);
  }

  function buildMaterialListHtml(rows) {
    if (!rows.length) {
      return '<div class="empty-state">沒有符合條件的物料資料</div>';
    }

    // Mobile card view
    var cardsHtml = '<div class="material-list">' + rows.map(function (r) {
      return (
        '<div class="material-card">' +
          '<div class="material-card-top">' +
            '<div>' +
              '<div class="material-code">#' + esc(r.seq) + ' ' + esc(r.materialCode) + '</div>' +
              '<div class="material-name">' + esc(r.materialName) + '</div>' +
              (r.spec ? '<div class="material-spec">' + esc(r.spec) + '</div>' : '') +
            '</div>' +
            '<span class="status-pill ' + statusPillClass(r.arrivalStatus) + '">' + esc(r.arrivalStatus || "-") + '</span>' +
          '</div>' +
          '<div class="material-grid">' +
            '<div><span class="k">材料型態:</span> <span class="v">' + esc(r.materialType) + '</span></div>' +
            (r.poNos.length ? '<div class="full"><span class="k">採購單號:</span> <span class="v">' + esc(joinLines(r.poNos)) + '</span></div>' : '') +
            (r.vendors.length ? '<div class="full"><span class="k">廠商:</span> <span class="v">' + esc(joinLines(r.vendors)) + '</span></div>' : '') +
            '<div><span class="k">需領用量:</span> <span class="v">' + fmtNum(r.needQty) + '</span></div>' +
            (r.etas.length ? '<div class="full"><span class="k">預交日:</span> <span class="v">' + esc(joinLines(r.etas)) + '</span></div>' : '') +
            '<div><span class="k">已入料量:</span> <span class="v">' + fmtNum(r.receivedQty) + '</span></div>' +
            '<div><span class="k">已領用量:</span> <span class="v">' + fmtNum(r.issuedQty) + '</span></div>' +
            '<div><span class="k">未領用量:</span> <span class="v material-remain">' + fmtNum(r.remainQty) + '</span></div>' +
            '<div><span class="k">庫存數量:</span> <span class="v">' + fmtNum(r.stockQty) + '</span></div>' +
          '</div>' +
          ((can("receive") || can("ret")) ? '<div class="material-card-actions">' + receiveBtnHtml(r) + returnBtnHtml(r) + '</div>' : '') +
        '</div>'
      );
    }).join("") + '</div>';

    // Desktop table view
    var tableHtml = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th>項次</th><th>材料品號</th><th>品名</th><th>規格</th><th>材料型態</th>' +
      '<th>採購單號</th><th>廠商</th>' +
      '<th class="num">需領用量</th><th>預交日</th><th>到料狀態</th>' +
      '<th class="num">已入料量</th><th class="num">已領用量</th><th class="num">未領用量</th><th class="num">庫存數量</th>' +
      ((can("receive") || can("ret")) ? '<th>' + (can("receive") && can("ret") ? '收料 / 退料' : can("receive") ? '收料' : '退料') + '</th>' : '') +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' +
          '<td>' + esc(r.seq) + '</td>' +
          '<td>' + esc(r.materialCode) + '</td>' +
          '<td class="material-name-cell">' + esc(r.materialName) + '</td>' +
          '<td>' + esc(r.spec) + '</td>' +
          '<td>' + esc(r.materialType) + '</td>' +
          '<td>' + esc(joinLines(r.poNos)) + '</td>' +
          '<td>' + esc(joinLines(r.vendors)) + '</td>' +
          '<td class="num">' + fmtNum(r.needQty) + '</td>' +
          '<td>' + esc(joinLines(r.etas)) + '</td>' +
          '<td><span class="status-pill ' + statusPillClass(r.arrivalStatus) + '">' + esc(r.arrivalStatus || "-") + '</span></td>' +
          '<td class="num">' + fmtNum(r.receivedQty) + '</td>' +
          '<td class="num">' + fmtNum(r.issuedQty) + '</td>' +
          '<td class="num material-remain">' + fmtNum(r.remainQty) + '</td>' +
          '<td class="num">' + fmtNum(r.stockQty) + '</td>' +
          ((can("receive") || can("ret")) ? '<td><div class="cell-actions">' + receiveBtnHtml(r) + returnBtnHtml(r) + '</div></td>' : '') +
          '</tr>';
      }).join("") +
      '</tbody></table></div>';

    return cardsHtml + tableHtml;
  }

  // ---------- Excel export ----------

  function toSheetRow(r, project, orderNo, order) {
    return {
      "專案代號": project.code,
      "專案名稱": project.name,
      "製令編號": orderNo,
      "產品品號": order.productCode,
      "產品品名": order.productName,
      "項次": r.seq,
      "材料品號": r.materialCode,
      "品名": r.materialName,
      "規格": r.spec,
      "材料型態": r.materialType,
      "採購單號": joinLines(r.poNos),
      "廠商": joinLines(r.vendors),
      "需領用量": r.needQty,
      "預交日": joinLines(r.etas),
      "到料狀態": r.arrivalStatus,
      "已入料量": r.receivedQty,
      "已領用量": r.issuedQty,
      "未領用量": r.remainQty,
      "庫存數量": r.stockQty,
    };
  }

  function exportRowsToExcel(sheetRows, filename) {
    var ws = XLSX.utils.json_to_sheet(sheetRows);
    ws["!cols"] = [
      { wch: 12 }, { wch: 20 }, { wch: 18 }, { wch: 12 }, { wch: 16 },
      { wch: 6 }, { wch: 12 }, { wch: 16 }, { wch: 18 }, { wch: 10 },
      { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 10 },
      { wch: 10 }, { wch: 10 }, { wch: 10 },
    ];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "物料明細");
    XLSX.writeFile(wb, filename);
  }

  function exportOrderToExcel(orderNo, project, order) {
    var rows = filterRows(state.data.materials[orderNo] || [], getFilterState(orderNo));
    var sheetRows = rows.map(function (r) { return toSheetRow(r, project, orderNo, order); });
    var safeOrderNo = orderNo.replace(/[\\/:*?"<>|]/g, "-");
    exportRowsToExcel(sheetRows, "物料明細_" + safeOrderNo + ".xlsx");
  }

  function exportProjectToExcel(project) {
    var f = getProjectFilterState(project.code);
    var sheetRows = [];
    project.orders.forEach(function (o) {
      var rows = filterRows(state.data.materials[o.orderNo] || [], f);
      rows.forEach(function (r) { sheetRows.push(toSheetRow(r, project, o.orderNo, o)); });
    });
    var safeCode = project.code.replace(/[\\/:*?"<>|]/g, "-");
    exportRowsToExcel(sheetRows, "物料明細_" + safeCode + ".xlsx");
  }

  // ---------- Init ----------

  function loadData() {
    return fetch("data.enc?_=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        var tag = dataTagOf(res);
        return res.arrayBuffer().then(function (buf) { return { buf: buf, tag: tag }; });
      })
      .then(function (r) {
        return decryptData(r.buf, session.key).then(function (data) { return { data: data, tag: r.tag }; });
      })
      .then(function (r) {
        var data = r.data;
        dataTag = r.tag;
        scheduleDataCheck();
        state.data = data;
        state.orderIndex = buildOrderIndex(data);
        var t = document.getElementById("data-time");
        if (t) {
          var version = data.sourceUpdatedAt ? "(版本 " + data.sourceUpdatedAt + ")" : "";
          t.textContent = "資料來源: WMS.xlsx " + version + " · 頁面載入 " + new Date().toLocaleString("zh-Hant");
        }
      });
  }

  // ---------- 自動重新整理:WMS 更新把新的 data.enc 發布到網站後,自動載入 ----------
  // 平時每 60 秒用 HEAD 比對 data.enc 的 ETag(很輕量);WMS 更新剛完成時改為每 20 秒,持續 15 分鐘
  // (GitHub Pages 發布約需 1~2 分鐘)。使用者正在編輯(對話框開著/游標在輸入框)時延後,不打斷操作。
  var DATA_CHECK_MS = 60000, DATA_CHECK_FAST_MS = 20000, DATA_FAST_WINDOW_MS = 15 * 60000;
  var dataTag = null, dataCheckTimer = null, dataFastUntil = 0, dataChecking = false, dataPending = false;

  function dataTagOf(res) {
    // 壓縮傳輸時 GitHub Pages 回的是弱 ETag(W/"..."),去掉前綴才能和 HEAD 的結果比對
    var etag = (res.headers.get("ETag") || "").replace(/^W\//, "");
    return etag || res.headers.get("Last-Modified") || null;
  }

  function userIsEditing() {
    if (document.querySelector(".modal-backdrop")) return true;
    var a = document.activeElement;
    return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }

  function scheduleDataCheck() {
    clearTimeout(dataCheckTimer);
    if (!session) return;
    dataCheckTimer = setTimeout(checkDataUpdate, Date.now() < dataFastUntil ? DATA_CHECK_FAST_MS : DATA_CHECK_MS);
  }

  function boostDataCheck() {
    dataFastUntil = Date.now() + DATA_FAST_WINDOW_MS;
    checkDataUpdate();
  }

  function checkDataUpdate() {
    if (!session || !state.data || dataChecking) return;
    if (document.visibilityState === "hidden") { scheduleDataCheck(); return; } // 切回前景時會立刻檢查
    dataChecking = true;
    var changed = dataPending ? Promise.resolve(true) :
      fetch("data.enc?_=" + Date.now(), { method: "HEAD", cache: "no-store" }).then(function (res) {
        var t = res.ok ? dataTagOf(res) : null;
        return !!(t && dataTag && t !== dataTag);
      });
    changed.then(function (isNew) {
      if (!isNew) return;
      if (userIsEditing()) { dataPending = true; return; }
      dataPending = false;
      // 網站每次發布(含只改程式)ETag 都會變,所以載入後再比對內容:沒變就不動畫面
      var old = state.data, oldJson = JSON.stringify(old);
      return loadData().then(function () {
        if (JSON.stringify(state.data) === oldJson) return;
        var y = window.scrollY;
        render();
        window.scrollTo(0, y); // 自動更新不把畫面捲回頂端
        if (state.data.sourceUpdatedAt !== old.sourceUpdatedAt) {
          dataFastUntil = 0;
          showToast("已自動載入最新 WMS 資料(版本 " + state.data.sourceUpdatedAt + ")");
        }
      });
    }).catch(function () { /* 網路暫時失敗,下次再試 */ }).then(function () {
      dataChecking = false;
      scheduleDataCheck();
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") checkDataUpdate();
  });

  function refreshData() {
    if (!session) return;
    var btn = document.getElementById("refresh-btn");
    if (btn) btn.classList.add("spinning");
    loadData()
      .then(render)
      .catch(handleLoadError)
      .then(function () {
        if (btn) btn.classList.remove("spinning");
      });
  }

  window.addEventListener("hashchange", render);
  window.addEventListener("resize", updateHeaderHeightVar);

  document.addEventListener("DOMContentLoaded", function () {
    lsSet("wms_edit_pin", null); // 舊版的儲存密碼不再使用,清掉

    var refreshBtn = document.getElementById("refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", refreshData);
    }

    var scanBtn = document.getElementById("scan-btn");
    if (scanBtn) scanBtn.addEventListener("click", openScanner);

    // 待簽核表單頁:按 Ctrl+V 貼上截圖(只攔截剪貼簿裡的圖片,貼文字照常)
    document.addEventListener("paste", function (e) {
      if (!signPage) return;
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image/") === 0) {
          signPage.setImage(items[i].getAsFile());
          e.preventDefault();
          return;
        }
      }
    });

    var appEl = document.getElementById("app");
    if (appEl) {
      appEl.addEventListener("click", function (e) {
        var rb = e.target.closest ? e.target.closest(".ret-btn") : null;
        if (rb && !rb.disabled) {
          var rr = recvRows[parseInt(rb.getAttribute("data-ret"), 10)];
          if (rr) openReturnDialog(rr);
          return;
        }
        var b = e.target.closest ? e.target.closest(".recv-btn") : null;
        if (!b) return;
        var r = recvRows[parseInt(b.getAttribute("data-recv"), 10)];
        if (r) openReceiveDialog(r);
      });
    }
    if (appEl && window.MutationObserver) {
      new MutationObserver(scheduleStickyUpdate).observe(appEl, { childList: true, subtree: true });
    }

    session = loadSession();
    if (session) startApp(); else showLogin("");

    if ("serviceWorker" in navigator) {
      // 新版 service worker 接手時,自動重新載入一次,馬上換成新版畫面
      var hadController = !!navigator.serviceWorker.controller;
      var reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", function () {
        if (!hadController) { hadController = true; return; } // 第一次安裝不必重載
        if (reloaded) return;
        reloaded = true;
        location.reload();
      });
      navigator.serviceWorker
        .register("service-worker.js", { updateViaCache: "none" })
        .then(function (reg) {
          // 開啟時、以及從背景切回前景時,主動檢查是否有新版
          var check = function () { reg.update().catch(function () {}); };
          check();
          document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "visible") check();
          });
        })
        .catch(function () {});
    }
  });
})();
