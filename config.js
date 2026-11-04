// 登入與儲位編輯用的設定(都不是機密,可以公開):
//   editEndpoint   Google Apps Script Web App 的 /exec 網址(驗證登入、名單管理、接收儲位編輯)
//   googleClientId Google Cloud 建立的 OAuth 用戶端 ID(網頁應用程式)
window.WMS_CONFIG = {
  editEndpoint: "https://script.google.com/macros/s/AKfycbwdCXxdS1JdBpRagTnZaXgMpLrimI9RXE3afbC9G3RqRsvXDh1udecblKLg7mLpJjqD_w/exec",
  googleClientId: "381921967328-1vctc0dgvts11qt9kvvjgtk790tkc3f0.apps.googleusercontent.com"
};
