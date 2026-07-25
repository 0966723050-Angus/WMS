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
      materialFilterState[orderNo] = { query: "", status: "" };
    }
    return materialFilterState[orderNo];
  }

  function getProjectFilterState(code) {
    if (!projectFilterState[code]) {
      projectFilterState[code] = { query: "", status: "" };
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
    return rows.filter(function (r) {
      if (status && r.arrivalStatus !== status) return false;
      if (!q) return true;
      var haystack = [
        r.materialCode, r.materialName, r.spec, r.materialType,
        joinLines(r.poNos), joinLines(r.vendors), joinLines(r.etas), r.arrivalStatus
      ].join(" ").toLowerCase();
      return haystack.indexOf(q) !== -1;
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
    return { view: "home" };
  }

  function render() {
    var route = parseHash();
    var app = document.getElementById("app");
    if (!state.data) {
      app.innerHTML = '<div class="skeleton">載入資料中…</div>';
      return;
    }
    if (route.view === "project") {
      renderProject(app, route.code);
    } else if (route.view === "order") {
      renderOrder(app, route.orderNo);
    } else if (route.view === "storage") {
      renderStorage(app);
    } else {
      renderHome(app);
    }
    window.scrollTo(0, 0);
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
            return (
              '<div class="order-row">' +
                '<div>' +
                  '<a class="order-link" href="#/order/' + encodeURIComponent(o.orderNo) + '">' + esc(o.orderNo) + '</a>' +
                  '<span class="order-product">' + esc(o.productCode) + (o.productName ? " · " + esc(o.productName) : "") + '</span>' +
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

  // ---------- Storage location lookup ----------

  var storageQuery = "";

  function parseCodeParts(code) {
    var m = /^(.*?)(\d+)$/.exec(String(code || "").trim());
    if (!m) return null;
    return { prefix: m[1].toLowerCase(), num: parseInt(m[2], 10) };
  }

  function codeInRange(query, from, to) {
    var q = parseCodeParts(query);
    var f = parseCodeParts(from);
    var t = parseCodeParts(to);
    if (!q || !f || !t) return false;
    if (q.prefix !== f.prefix || q.prefix !== t.prefix) return false;
    return q.num >= f.num && q.num <= t.num;
  }

  function renderStorage(app) {
    var html = '';
    html += '<div class="breadcrumb"><a href="#/">首頁</a> / 物料儲位查詢</div>';
    html += '<h1 class="page-title">物料儲位查詢<span class="sub">輸入材料品號或類別關鍵字,查詢物料的儲放地點與儲位</span></h1>';
    html += '<div class="toolbar">' +
      '<input type="search" id="storage-search" placeholder="輸入材料品號(例如 ML-B010050)或類別關鍵字(例如 軸承)" value="' + esc(storageQuery) + '" />' +
    '</div>';
    html += '<p class="result-count" id="storage-result-count"></p>';
    html += '<div id="storage-container"></div>';
    app.innerHTML = html;

    document.getElementById("storage-search").addEventListener("input", function (e) {
      storageQuery = e.target.value;
      renderStorageResults();
    });

    renderStorageResults();
  }

  function renderStorageResults() {
    var rows = state.data.storageLocations || [];
    var q = storageQuery.trim().toLowerCase();

    var countEl = document.getElementById("storage-result-count");
    var container = document.getElementById("storage-container");
    if (!container) return;

    if (!q) {
      if (countEl) countEl.textContent = "";
      container.innerHTML = '<div class="empty-state">請輸入材料品號或類別關鍵字開始查詢</div>';
      return;
    }

    var results = rows.filter(function (r) {
      var haystack = [r.codeFrom, r.codeTo, r.category, r.location, r.bin].join(" ").toLowerCase();
      return haystack.indexOf(q) !== -1 || codeInRange(storageQuery.trim(), r.codeFrom, r.codeTo);
    });

    if (countEl) countEl.textContent = "顯示 " + results.length + " / " + rows.length + " 筆儲位資料";

    if (!results.length) {
      container.innerHTML = '<div class="empty-state">查無此材料品號</div>';
      return;
    }

    container.innerHTML = '<div class="material-list">' + results.map(function (r) {
      return (
        '<div class="material-card">' +
          '<div class="material-card-top">' +
            '<div>' +
              '<div class="material-code">' + esc(r.codeFrom) + ' ~ ' + esc(r.codeTo) + '</div>' +
              '<div class="material-name">' + esc(r.category) + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="material-grid">' +
            '<div class="full"><span class="k">儲放地點:</span> <span class="v">' + esc(r.location) + '</span></div>' +
            '<div class="full"><span class="k">儲位:</span> <span class="v">' + esc(r.bin) + '</span></div>' +
          '</div>' +
        '</div>'
      );
    }).join("") + '</div>';
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
    html += toolbarHtml({ search: "project-search", status: "project-status", exportBtn: "project-export" }, f, "下載為 Excel (全部製令)");
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
    document.getElementById("project-export").addEventListener("click", function () {
      exportProjectToExcel(project);
    });

    renderProjectMaterials(project);
  }

  function renderProjectMaterials(project) {
    var f = getProjectFilterState(project.code);
    var filtering = !!(f.query.trim() || f.status);
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
    html += toolbarHtml({ search: "search-input", status: "status-select", exportBtn: "export-btn" }, f, "下載為 Excel");
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
        '</div>'
      );
    }).join("") + '</div>';

    // Desktop table view
    var tableHtml = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th>項次</th><th>材料品號</th><th>品名</th><th>規格</th><th>材料型態</th>' +
      '<th>採購單號</th><th>廠商</th>' +
      '<th class="num">需領用量</th><th>預交日</th><th>到料狀態</th>' +
      '<th class="num">已入料量</th><th class="num">已領用量</th><th class="num">未領用量</th><th class="num">庫存數量</th>' +
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
    return fetch("data.json?_=" + Date.now(), { cache: "no-store" })
      .then(function (res) { return res.json(); })
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
    var btn = document.getElementById("refresh-btn");
    if (btn) btn.classList.add("spinning");
    loadData()
      .then(render)
      .catch(function (err) {
        document.getElementById("app").innerHTML = '<div class="empty-state">資料載入失敗: ' + esc(err.message) + '</div>';
      })
      .then(function () {
        if (btn) btn.classList.remove("spinning");
      });
  }

  window.addEventListener("hashchange", render);

  document.addEventListener("DOMContentLoaded", function () {
    render();
    loadData().then(render).catch(function (err) {
      document.getElementById("app").innerHTML = '<div class="empty-state">資料載入失敗: ' + esc(err.message) + '</div>';
    });

    var refreshBtn = document.getElementById("refresh-btn");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", refreshData);
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(function () {});
    }
  });
})();
