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
      materialFilterState[orderNo] = { query: "", status: "", issueStatus: "" };
    }
    return materialFilterState[orderNo];
  }

  function getProjectFilterState(code) {
    if (!projectFilterState[code]) {
      projectFilterState[code] = { query: "", status: "", issueStatus: "" };
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
    return rows.filter(function (r) {
      if (status && r.arrivalStatus !== status) return false;
      if (issueStatus === "未領" && !(r.remainQty > 0)) return false;
      if (issueStatus === "已領" && !(r.remainQty <= 0)) return false;
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

  function loadSession() {
    try {
      var s = JSON.parse(lsGet(SESSION_KEY) || "null");
      return s && s.exp > Date.now() + 60000 && s.key && s.session ? s : null;
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
    if (adminBtn) adminBtn.hidden = !(session && session.isAdmin);
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
        setSession({ email: res.email, name: res.name, isAdmin: !!res.isAdmin, key: res.key, session: res.session, exp: res.exp });
        startApp();
      })
      .catch(function (err) { msgEl.textContent = err.message; });
  }

  function startApp() {
    updateUserUi();
    render();
    loadData().then(render).catch(handleLoadError);
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

  function renderAdmin(app) {
    if (!session || !session.isAdmin) {
      location.hash = "#/";
      return;
    }
    app.innerHTML =
      '<div class="breadcrumb"><a href="#/">首頁</a> / 登入名單管理</div>' +
      '<h1 class="page-title">登入名單管理<span class="sub">只有名單內的 Google 帳號可以登入網站;管理者:' + esc(session.email) + '</span></h1>' +
      '<div class="admin-card">' +
        '<h3>新增帳號</h3>' +
        '<textarea id="adm-new" rows="4" placeholder="每行一個帳號,姓名可省略\n例如:\nsomeone@atk.com.tw 王小明\nother@atk.com.tw"></textarea>' +
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
      api("admin_add", { users: users }).then(function (res) {
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
        enabled: modal.querySelector("#usr-enabled").checked
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

  function renderHome(app) {
    var projects = state.data.projects;
    var totalOrders = projects.reduce(function (s, p) { return s + p.orders.length; }, 0);

    var html = '';
    html += '<h1 class="page-title">在線專案一覽表<span class="sub">共 ' + projects.length + ' 個專案 / ' + totalOrders + ' 筆製令</span></h1>';
    html += '<div class="project-list" id="project-list"></div>';
    app.innerHTML = html;

    var list = document.getElementById("project-list");
    projects.forEach(function (p) {
      var card = el(
        '<div class="project-card">' +
          '<div class="project-card-head">' +
            '<div>' +
              '<a class="project-code-link" href="#/project/' + encodeURIComponent(p.code) + '">' + esc(p.code) + '</a>' +
              '<span class="project-name">' + esc(p.name) + '</span>' +
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
                '<div>' +
                  '<a class="order-link" href="#/order/' + encodeURIComponent(o.orderNo) + '">' + esc(o.orderNo) + '</a>' +
                  '<span class="order-product">' + esc(o.productCode) + (o.productName ? " · " + esc(o.productName) : "") + '</span>' +
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
  }

  // ---------- ERP 頁面(進貨單 / 製令領料單;功能建置中) ----------

  var ERP_PAGES = {
    receipt: { title: "進貨單" },
    issue: { title: "製令領料單" }
  };

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
    var timer = null;

    function refresh() {
      api("wms_status").then(function (res) {
        if (!document.body.contains(btn)) return; // 已離開此頁
        if (!res.ok) { note.textContent = res.error || ""; return; }
        var s = wmsStatusText(res);
        note.textContent = s.text;
        btn.disabled = s.busy;
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

  function renderErp(app, sub) {
    var page = ERP_PAGES[sub];
    if (sub && !page) { location.hash = "#/erp"; return; }

    if (!page) {
      app.innerHTML =
        '<div class="breadcrumb"><a href="#/">首頁</a> / ERP</div>' +
        '<h1 class="page-title">ERP</h1>' +
        '<div class="erp-grid">' +
          '<a class="erp-tile" href="#/erp/receipt"><span class="erp-tile-title">進貨單</span></a>' +
          '<a class="erp-tile" href="#/erp/issue"><span class="erp-tile-title">製令領料單</span></a>' +
          (session && session.isAdmin
            ? '<button type="button" class="erp-tile" id="wms-update-btn"><span class="erp-tile-title">WMS更新</span>' +
              '<span class="erp-tile-note" id="wms-update-note"></span></button>'
            : '') +
        '</div>';
      if (session && session.isAdmin) setupWmsUpdate();
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
    html += '<div class="breadcrumb"><a href="#/">首頁</a> / 物料儲位查詢</div>';
    html += '<h1 class="page-title">物料儲位查詢<span class="sub">材料品號/品名/規格/類別皆可用關鍵字查詢' +
      ';點擊卡片可編輯類別/儲放地點/儲位</span></h1>';
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

    var canEdit = !!session;
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
    if (!session) return "";
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

  function openReceiveDialog(r) {
    var pos = r.poNos || [], vendors = r.vendors || [];
    var pairs = pos.map(function (po, i) { return { po: po, vendor: vendors[i] || vendors[0] || "" }; });
    if (!pairs.length) pairs = [{ po: "", vendor: vendors[0] || "" }];

    var pickHtml;
    if (pairs.length > 1) {
      pickHtml =
        '<div class="field"><span class="field-label">採購單號 / 廠商(此物料有多張採購單,請選擇)</span>' +
        '<select id="recv-pair">' + pairs.map(function (p, i) {
          return '<option value="' + i + '">' + esc(p.po) + ' — ' + esc(p.vendor) + '</option>';
        }).join("") + '</select></div>';
    } else {
      pickHtml =
        '<div class="recv-info-row"><span class="k">廠商</span><span class="v" id="recv-vendor"></span></div>' +
        '<div class="recv-info-row"><span class="k">採購單號</span><span class="v" id="recv-po"></span></div>';
    }

    var modal = el(
      '<div class="modal-backdrop">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="recv-title">' +
          '<h2 id="recv-title">確認收料</h2>' +
          '<div class="modal-info recv-info">' +
            pickHtml +
            '<div class="recv-info-row"><span class="k">品號</span><span class="v" id="recv-code"></span></div>' +
            '<div class="recv-info-row"><span class="k">品名</span><span class="v" id="recv-name"></span></div>' +
          '</div>' +
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

    // 用 textContent 填入,避免任何特殊字元被當成 HTML
    var vEl = modal.querySelector("#recv-vendor"), pEl = modal.querySelector("#recv-po");
    if (vEl) vEl.textContent = pairs[0].vendor || "(無)";
    if (pEl) pEl.textContent = pairs[0].po || "(無採購單)";
    modal.querySelector("#recv-code").textContent = r.materialCode;
    modal.querySelector("#recv-name").textContent = r.materialName;
    var qtyEl = modal.querySelector("#recv-qty");
    qtyEl.value = defaultReceiveQty(r);

    var msg = modal.querySelector("#recv-msg"), okBtn = modal.querySelector("#recv-ok");
    function close() {
      document.removeEventListener("keydown", onKey);
      if (modal.parentNode) modal.parentNode.removeChild(modal);
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    modal.querySelector("#recv-cancel").addEventListener("click", close);

    okBtn.addEventListener("click", function () {
      var qty = Number(qtyEl.value);
      if (!(qty > 0)) { msg.textContent = "數量必須大於 0"; return; }
      var pairEl = modal.querySelector("#recv-pair");
      var pair = pairs[pairEl ? parseInt(pairEl.value, 10) : 0];
      msg.textContent = "送出中…";
      okBtn.disabled = true;
      api("receive", {
        order: orderOfRow(r), vendor: pair.vendor, po: pair.po,
        code: r.materialCode, name: r.materialName, qty: qty
      })
        .then(function (res) {
          if (!res.ok) throw new Error(res.error || "送出失敗");
          close();
          showToast("已送出收料,稍後會寫入 Excel「收料」工作表");
        })
        .catch(function (err) {
          if (!session) { close(); return; } // 登入已失效,已切換到登入畫面
          msg.textContent = err.message;
          okBtn.disabled = false;
        });
    });
  }

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
      '<div class="toolbar">' +
        '<input type="search" id="' + ids.search + '" placeholder="搜尋 (品號 / 品名 / 規格 / 廠商 / 採購單號)" value="' + esc(f.query) + '" />' +
        '<select id="' + ids.status + '">' +
          '<option value="">到料狀態: 全部</option>' +
          '<option value="已到料"' + (f.status === "已到料" ? " selected" : "") + '>已到料</option>' +
          '<option value="未到料"' + (f.status === "未到料" ? " selected" : "") + '>未到料</option>' +
        '</select>' +
        '<select id="' + ids.issueStatus + '">' +
          '<option value=""' + (f.issueStatus === "" ? " selected" : "") + '>領料狀態: 全部</option>' +
          '<option value="未領"' + (f.issueStatus === "未領" ? " selected" : "") + '>未領</option>' +
          '<option value="已領"' + (f.issueStatus === "已領" ? " selected" : "") + '>已領</option>' +
        '</select>' +
        '<button class="btn btn-export" id="' + ids.exportBtn + '" type="button">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>' +
          esc(exportLabel) +
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
    html += toolbarHtml({ search: "project-search", status: "project-status", issueStatus: "project-issue-status", exportBtn: "project-export" }, f, "下載為 Excel (全部製令)");
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
    document.getElementById("project-export").addEventListener("click", function () {
      exportProjectToExcel(project);
    });

    renderProjectMaterials(project);
  }

  function renderProjectMaterials(project) {
    var f = getProjectFilterState(project.code);
    var filtering = !!(f.query.trim() || f.status || f.issueStatus);
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
    html += toolbarHtml({ search: "search-input", status: "status-select", issueStatus: "issue-status-select", exportBtn: "export-btn" }, f, "下載為 Excel");
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
          '<div class="material-card-actions">' + receiveBtnHtml(r) + '</div>' +
        '</div>'
      );
    }).join("") + '</div>';

    // Desktop table view
    var tableHtml = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th>項次</th><th>材料品號</th><th>品名</th><th>規格</th><th>材料型態</th>' +
      '<th>採購單號</th><th>廠商</th>' +
      '<th class="num">需領用量</th><th>預交日</th><th>到料狀態</th>' +
      '<th class="num">已入料量</th><th class="num">已領用量</th><th class="num">未領用量</th><th class="num">庫存數量</th>' +
      '<th>收料</th>' +
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
          '<td>' + receiveBtnHtml(r) + '</td>' +
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
        return res.arrayBuffer();
      })
      .then(function (buf) { return decryptData(buf, session.key); })
      .then(function (data) {
        state.data = data;
        state.orderIndex = buildOrderIndex(data);
        var t = document.getElementById("data-time");
        if (t) {
          var version = data.sourceUpdatedAt ? "(版本 " + data.sourceUpdatedAt + ")" : "";
          t.textContent = "資料來源: WMS.xlsx " + version + " · 頁面載入 " + new Date().toLocaleString("zh-Hant");
        }
      });
  }

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

    var appEl = document.getElementById("app");
    if (appEl) {
      appEl.addEventListener("click", function (e) {
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
