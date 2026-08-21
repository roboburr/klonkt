// Pushmeldingen in beheer (pages/admin-push.ejs) -- verplaatst uit inline script, shaer-bqr.
//
// Inline script in een pagina wordt door de CSP geweigerd zodra je die pagina via
// een link BINNEN de site opent: de nonce rouleert per verzoek (shaer-0i6). Dit
// bestand wordt door de bootstrap in shell.ejs geladen en heeft dat probleem niet.
//
// Alles hier hoort GEDELEGEERD te luisteren (op document, niet op een element dat
// er nu staat) en tegen een tweede aanroep te kunnen.

// Element-bedrading leeft zo lang als de pagina; de bootstrap roept init()
// aan bij elke paginawissel waarop deze module actief is (shaer-5s1).
export function init() { run(); }

function run() {
(function () {
  var cfg = JSON.parse(document.getElementById('np-data').textContent);
  var elState = document.getElementById('np-state');
  var btnOn = document.getElementById('np-on'), btnOff = document.getElementById('np-off'), btnTest = document.getElementById('np-test');
  var alertsBox = document.getElementById('np-alerts'), savedMsg = document.getElementById('np-saved');
  var currentEndpoint = null;

  var isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isIos && !standalone) document.getElementById('np-ios-hint').hidden = false;

  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    document.getElementById('np-unsupported').hidden = false;
    elState.textContent = cfg.i18n.unsupported;
    return;
  }

  function b64ToU8(s) {
    var pad = '='.repeat((4 - (s.length % 4)) % 4);
    var raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }
  function deviceLabel() {
    var ua = navigator.userAgent;
    var browser = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    var os = /Android/.test(ua) ? 'Android' : /iPad|iPhone|iPod/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Win/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
    return (browser + (os ? ' op ' + os : ''));
  }
  function readAlertBoxes() {
    var out = {};
    alertsBox.querySelectorAll('input[data-alert]').forEach(function (cb) { out[cb.getAttribute('data-alert')] = cb.checked ? 1 : 0; });
    return out;
  }
  function setAlertBoxes(alerts) {
    alertsBox.querySelectorAll('input[data-alert]').forEach(function (cb) {
      cb.checked = !!alerts[cb.getAttribute('data-alert')];
    });
  }

  function render(sub) {
    currentEndpoint = sub ? sub.endpoint : null;
    elState.textContent = sub ? cfg.i18n.on : (Notification.permission === 'denied' ? cfg.i18n.denied : cfg.i18n.off);
    btnOn.hidden = !!sub || Notification.permission === 'denied';
    btnOff.hidden = !sub;
    btnTest.hidden = !sub;
    alertsBox.hidden = !sub;
  }

  navigator.serviceWorker.ready.then(function (reg) {
    return reg.pushManager.getSubscription();
  }).then(function (sub) {
    // Show this device's SAVED prefs when we know them, defaults otherwise.
    setAlertBoxes((sub && cfg.saved[sub.endpoint]) ? Object.assign({}, cfg.alerts, cfg.saved[sub.endpoint]) : cfg.alerts);
    render(sub);
  }).catch(function () { elState.textContent = cfg.i18n.unknown; });

  btnOn.addEventListener('click', function () {
    btnOn.disabled = true;
    Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') { btnOn.disabled = false; render(null); return; }
      navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(cfg.vapid) });
      }).then(function (sub) {
        return post('/push/subscribe', { subscription: sub.toJSON(), alerts: readAlertBoxes(), uaLabel: deviceLabel() })
          .then(function (r) { if (!r.ok) throw new Error('subscribe failed'); render(sub); location.reload(); });
      }).catch(function () { btnOn.disabled = false; elState.textContent = cfg.i18n.failed; });
    });
  });

  btnOff.addEventListener('click', function () {
    navigator.serviceWorker.ready.then(function (reg) { return reg.pushManager.getSubscription(); }).then(function (sub) {
      if (!sub) { render(null); return; }
      var ep = sub.endpoint;
      sub.unsubscribe().then(function () { return post('/push/unsubscribe', { endpoint: ep }); })
        .then(function () { location.reload(); });
    });
  });

  btnTest.addEventListener('click', function () {
    btnTest.disabled = true;
    post('/push/test').then(function () { setTimeout(function () { btnTest.disabled = false; }, 2000); });
  });

  alertsBox.addEventListener('change', function () {
    if (!currentEndpoint) return;
    post('/push/alerts', { endpoint: currentEndpoint, alerts: readAlertBoxes() }).then(function (r) {
      if (r.ok) { savedMsg.hidden = false; setTimeout(function () { savedMsg.hidden = true; }, 1500); }
    });
  });

  document.querySelectorAll('.np-remove').forEach(function (btn) {
    btn.addEventListener('click', function () {
      post('/push/unsubscribe', { endpoint: btn.getAttribute('data-endpoint') }).then(function () { location.reload(); });
    });
  });
})();
}
