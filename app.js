(function () {
  "use strict";

  var state = {
    data: null,
    orderIndex: null, // orderNo -> { project, order }
  };

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

  // ---------- Routing ----------

  function parseHash() {
    var h = location.hash.replace(/^#\/?/, "");
    var parts = h.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length === 0) return { view: "home" };
    if (parts[0] === "project" && parts[1]) return { view: "project", code: parts[1] };
    if (parts[0] === "order" && parts[1]) return { view: "order", orderNo: parts[1] };
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

  // ---------- Project detail ----------

  function renderProject(app, code) {
    var project = state.data.projects.find(function (p) { return p.code === code; });
    if (!project) {
      app.innerHTML = '<div class="breadcrumb"><a href="#/">首頁</a></div><div class="empty-state">找不到專案 ' + esc(code) + '</div>';
      return;
    }
    var html = '';
    html += '<div class="breadcrumb"><a href="#/">首頁</a> / ' + esc(project.code) + '</div>';
    html += '<h1 class="page-title">' + esc(project.code) + '<span class="sub">' + esc(project.name) + ' · 共 ' + project.orders.length + ' 筆製令</span></h1>';
    html += '<div class="order-table-list">';
    project.orders.forEach(function (o) {
      html +=
        '<div class="order-item">' +
          '<div class="order-item-top">' +
            '<a class="order-link" style="font-weight:700;font-size:15px" href="#/order/' + encodeURIComponent(o.orderNo) + '">' + esc(o.orderNo) + '</a>' +
            '<span class="status-pill ' + statusPillClass(o.status) + '">' + esc(o.status || "-") + '</span>' +
          '</div>' +
          '<div class="order-item-fields">' +
            '<div>產品品號: <b>' + esc(o.productCode) + '</b></div>' +
            '<div>產品品名: <b>' + esc(o.productName) + '</b></div>' +
            '<div class="full">規格: <b>' + esc(o.spec) + '</b></div>' +
            (o.note ? '<div class="full">備註: <b>' + esc(o.note) + '</b></div>' : '') +
          '</div>' +
        '</div>';
    });
    html += '</div>';
    app.innerHTML = html;
  }

  // ---------- Order detail (material list) ----------

  var orderPageState = {
    orderNo: null,
    query: "",
    status: "",
  };

  function getFilteredMaterials(orderNo) {
    var rows = state.data.materials[orderNo] || [];
    var q = orderPageState.query.trim().toLowerCase();
    var status = orderPageState.status;
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

  function renderOrder(app, orderNo) {
    var found = state.orderIndex[orderNo];
    if (!found) {
      app.innerHTML = '<div class="breadcrumb"><a href="#/">首頁</a></div><div class="empty-state">找不到製令 ' + esc(orderNo) + '</div>';
      return;
    }
    if (orderPageState.orderNo !== orderNo) {
      orderPageState.orderNo = orderNo;
      orderPageState.query = "";
      orderPageState.status = "";
    }

    var project = found.project;
    var order = found.order;

    var html = '';
    html += '<div class="breadcrumb"><a href="#/">首頁</a> / <a href="#/project/' + encodeURIComponent(project.code) + '">' + esc(project.code) + '</a> / ' + esc(orderNo) + '</div>';
    html += '<h1 class="page-title">製令 ' + esc(orderNo) + '<span class="sub">物料明細</span></h1>';

    html += '<div class="info-panel">' +
      '<div class="row"><span class="k">專案</span><span class="v">' + esc(project.code) + ' ' + esc(project.name) + '</span></div>' +
      '<div class="row"><span class="k">產品品號</span><span class="v">' + esc(order.productCode) + '</span></div>' +
      '<div class="row"><span class="k">產品品名</span><span class="v">' + esc(order.productName) + '</span></div>' +
      '<div class="row"><span class="k">規格</span><span class="v">' + esc(order.spec) + '</span></div>' +
      '<div class="row"><span class="k">製令狀態</span><span class="v">' + esc(order.status) + '</span></div>' +
    '</div>';

    html += '<div class="toolbar">' +
      '<input type="search" id="search-input" placeholder="全文檢索 (品號 / 品名 / 規格 / 廠商 / 採購單號)" value="' + esc(orderPageState.query) + '" />' +
      '<select id="status-select">' +
        '<option value="">到料狀態: 全部</option>' +
        '<option value="已到料"' + (orderPageState.status === "已到料" ? " selected" : "") + '>已到料</option>' +
        '<option value="未到料"' + (orderPageState.status === "未到料" ? " selected" : "") + '>未到料</option>' +
      '</select>' +
      '<button class="btn" id="export-btn" type="button">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/></svg>' +
        '下載為 Excel' +
      '</button>' +
    '</div>';

    html += '<p class="result-count" id="result-count"></p>';
    html += '<div id="material-container"></div>';

    app.innerHTML = html;

    document.getElementById("search-input").addEventListener("input", function (e) {
      orderPageState.query = e.target.value;
      renderMaterialTable(orderNo, project, order);
    });
    document.getElementById("status-select").addEventListener("change", function (e) {
      orderPageState.status = e.target.value;
      renderMaterialTable(orderNo, project, order);
    });
    document.getElementById("export-btn").addEventListener("click", function () {
      exportToExcel(orderNo, project, order);
    });

    renderMaterialTable(orderNo, project, order);
  }

  function renderMaterialTable(orderNo, project, order) {
    var rows = getFilteredMaterials(orderNo);
    var total = (state.data.materials[orderNo] || []).length;
    document.getElementById("result-count").textContent =
      "顯示 " + rows.length + " / " + total + " 筆物料";

    var container = document.getElementById("material-container");

    if (!rows.length) {
      container.innerHTML = '<div class="empty-state">沒有符合條件的物料資料</div>';
      return;
    }

    // Mobile card view
    var cardsHtml = '<div class="material-list">' + rows.map(function (r) {
      return (
        '<div class="material-card">' +
          '<div class="material-card-top">' +
            '<div>' +
              '<div class="material-code">#' + esc(r.seq) + ' ' + esc(r.materialCode) + '</div>' +
              '<div class="material-name">' + esc(r.materialName) + (r.spec ? " · " + esc(r.spec) : "") + '</div>' +
            '</div>' +
            '<span class="status-pill ' + statusPillClass(r.arrivalStatus) + '">' + esc(r.arrivalStatus || "-") + '</span>' +
          '</div>' +
          '<div class="material-grid">' +
            '<div><span class="k">材料型態:</span> <span class="v">' + esc(r.materialType) + '</span></div>' +
            '<div><span class="k">需領用量:</span> <span class="v">' + fmtNum(r.needQty) + '</span></div>' +
            '<div><span class="k">已入料量:</span> <span class="v">' + fmtNum(r.receivedQty) + '</span></div>' +
            '<div><span class="k">已領用量:</span> <span class="v">' + fmtNum(r.issuedQty) + '</span></div>' +
            '<div><span class="k">未領用量:</span> <span class="v">' + fmtNum(r.remainQty) + '</span></div>' +
            '<div><span class="k">庫存數量:</span> <span class="v">' + fmtNum(r.stockQty) + '</span></div>' +
            (r.poNos.length ? '<div class="full"><span class="k">採購單號:</span> <span class="v">' + esc(joinLines(r.poNos)) + '</span></div>' : '') +
            (r.vendors.length ? '<div class="full"><span class="k">廠商:</span> <span class="v">' + esc(joinLines(r.vendors)) + '</span></div>' : '') +
            (r.etas.length ? '<div class="full"><span class="k">預交日:</span> <span class="v">' + esc(joinLines(r.etas)) + '</span></div>' : '') +
          '</div>' +
        '</div>'
      );
    }).join("") + '</div>';

    // Desktop table view
    var tableHtml = '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      '<th>項次</th><th>材料品號</th><th>品名</th><th>規格</th><th>材料型態</th>' +
      '<th>採購單號</th><th>廠商</th><th>預交日</th>' +
      '<th class="num">需領用量</th><th>到料狀態</th>' +
      '<th class="num">已入料量</th><th class="num">已領用量</th><th class="num">未領用量</th><th class="num">庫存數量</th>' +
      '</tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr>' +
          '<td>' + esc(r.seq) + '</td>' +
          '<td>' + esc(r.materialCode) + '</td>' +
          '<td>' + esc(r.materialName) + '</td>' +
          '<td>' + esc(r.spec) + '</td>' +
          '<td>' + esc(r.materialType) + '</td>' +
          '<td>' + esc(joinLines(r.poNos)) + '</td>' +
          '<td>' + esc(joinLines(r.vendors)) + '</td>' +
          '<td>' + esc(joinLines(r.etas)) + '</td>' +
          '<td class="num">' + fmtNum(r.needQty) + '</td>' +
          '<td><span class="status-pill ' + statusPillClass(r.arrivalStatus) + '">' + esc(r.arrivalStatus || "-") + '</span></td>' +
          '<td class="num">' + fmtNum(r.receivedQty) + '</td>' +
          '<td class="num">' + fmtNum(r.issuedQty) + '</td>' +
          '<td class="num">' + fmtNum(r.remainQty) + '</td>' +
          '<td class="num">' + fmtNum(r.stockQty) + '</td>' +
          '</tr>';
      }).join("") +
      '</tbody></table></div>';

    container.innerHTML = cardsHtml + tableHtml;
  }

  // ---------- Excel export ----------

  function exportToExcel(orderNo, project, order) {
    var rows = getFilteredMaterials(orderNo);
    var sheetRows = rows.map(function (r) {
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
        "預交日": joinLines(r.etas),
        "需領用量": r.needQty,
        "到料狀態": r.arrivalStatus,
        "已入料量": r.receivedQty,
        "已領用量": r.issuedQty,
        "未領用量": r.remainQty,
        "庫存數量": r.stockQty,
      };
    });

    var ws = XLSX.utils.json_to_sheet(sheetRows);
    ws["!cols"] = [
      { wch: 12 }, { wch: 20 }, { wch: 18 }, { wch: 12 }, { wch: 16 },
      { wch: 6 }, { wch: 12 }, { wch: 16 }, { wch: 18 }, { wch: 10 },
      { wch: 16 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 10 },
      { wch: 10 }, { wch: 10 }, { wch: 10 },
    ];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "物料明細");
    var safeOrderNo = orderNo.replace(/[\\/:*?"<>|]/g, "-");
    XLSX.writeFile(wb, "物料明細_" + safeOrderNo + ".xlsx");
  }

  // ---------- Init ----------

  function loadData() {
    return fetch("data.json", { cache: "no-cache" })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        state.data = data;
        state.orderIndex = buildOrderIndex(data);
        var t = document.getElementById("data-time");
        if (t) t.textContent = "資料來源: WMS.xlsx";
      });
  }

  window.addEventListener("hashchange", render);

  document.addEventListener("DOMContentLoaded", function () {
    render();
    loadData().then(render).catch(function (err) {
      document.getElementById("app").innerHTML = '<div class="empty-state">資料載入失敗: ' + esc(err.message) + '</div>';
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(function () {});
    }
  });
})();
