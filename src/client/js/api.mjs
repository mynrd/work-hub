// The API layer, and the one-time-code prompt that backs it.
//
// The stored value is a session token the server handed out in exchange for a
// 6 digit code, not a secret the user knows. It expires, and a server restart
// invalidates it, so a 401 means "prove it again" rather than "you typed it
// wrong": the prompt asks for the current code and swaps it for a fresh session
// before replaying the request that failed.

const TOKEN_KEY = 'work-hub-session'; // a server-issued session, not a user secret

function getToken() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
function setToken(t) { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) { /* storage blocked */ } }
function clearToken() { try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* storage blocked */ } }

const otpOverlay = document.getElementById('otpOverlay');
const otpInput = document.getElementById('otpInput');
const otpError = document.getElementById('otpError');
const otpSubmitBtn = document.getElementById('otpSubmitBtn');
const otpTitle = document.getElementById('otpTitle');
const otpDesc = document.getElementById('otpDesc');
const otpModeLink = document.getElementById('otpModeLink');
let pendingAfterOtp = null;
let otpBusy = false;
let otpOpening = false;

// The last /api/auth/status answer, and which way in the prompt is asking for.
// A PIN, when one is set, is the default because it is the cheap daily unlock;
// the authenticator code is always one link away.
let authStatus = null;
let promptMode = 'otp'; // 'otp' | 'pin'

/** Ungated read of /api/auth/status. Carries the token so `via` comes back. */
function fetchAuthStatus() {
  var headers = {};
  var token = getToken();
  if (token) headers['X-Hub-Token'] = token;
  return fetch('/api/auth/status', { headers: headers })
    .then(function (res) { return res.json(); })
    .then(function (status) { authStatus = status; return status; })
    .catch(function () { return authStatus; });
}

function setPromptMode(mode) {
  promptMode = mode;
  var pinSet = Boolean(authStatus && authStatus.pinSet);
  if (mode === 'pin') {
    otpTitle.textContent = 'Enter your PIN';
    otpDesc.textContent = 'Type the 6 digit PIN you set in Settings. Or open your authenticator and use the code it shows instead.';
    otpSubmitBtn.textContent = 'Unlock';
    otpModeLink.textContent = 'Use authenticator code';
    otpInput.setAttribute('autocomplete', 'off');
  } else {
    otpTitle.textContent = 'Enter your code';
    otpDesc.textContent = 'Open your authenticator and type the 6 digit code it shows for Work Hub. A correct code signs this browser in for 12 hours.';
    otpSubmitBtn.textContent = 'Sign in';
    otpModeLink.textContent = 'Use PIN';
    otpInput.setAttribute('autocomplete', 'one-time-code');
  }
  otpModeLink.hidden = !pinSet;
  otpError.textContent = '';
  otpInput.value = '';
  otpInput.focus();
}

otpModeLink.addEventListener('click', function (e) {
  e.preventDefault();
  if (otpBusy) return;
  setPromptMode(promptMode === 'pin' ? 'otp' : 'pin');
});

function askForOtp(retry) {
  // Several calls can 401 at once - the dashboard fires three on load. They
  // all queue behind one prompt instead of stacking three of them.
  var previous = pendingAfterOtp;
  pendingAfterOtp = previous ? function () { previous(); retry(); } : retry;
  if (otpOverlay.classList.contains('is-open') || otpOpening) return;
  otpOpening = true;
  // Which mode to open in depends on whether a PIN exists, and that can change
  // between prompts (Settings sets one), so it is asked every time.
  fetchAuthStatus().then(function () {
    otpOpening = false;
    otpOverlay.classList.add('is-open');
    setPromptMode(authStatus && authStatus.pinSet ? 'pin' : 'otp');
  });
}

function submitOtp() {
  if (otpBusy) return;
  var code = otpInput.value.replace(/\D/g, '');
  if (code.length !== 6) {
    otpError.textContent = promptMode === 'pin' ? 'A PIN is 6 digits.' : 'A code is 6 digits.';
    return;
  }
  otpBusy = true;
  otpSubmitBtn.disabled = true;
  otpError.textContent = 'Checking...';

  // Deliberately not through api(): these are the calls that must not carry
  // a session token, and must not recurse into this prompt on a 401.
  fetch(promptMode === 'pin' ? '/api/auth/pin' : '/api/auth/otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(promptMode === 'pin' ? { pin: code } : { code: code }),
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (payload) {
      return { status: res.status, payload: payload };
    });
  }).then(function (result) {
    otpBusy = false;
    otpSubmitBtn.disabled = false;
    if (result.status !== 200 || !result.payload.token) {
      otpError.textContent = result.payload.error || ('Sign in failed (' + result.status + ').');
      otpInput.value = '';
      otpInput.focus();
      return;
    }
    setToken(result.payload.token);
    otpOverlay.classList.remove('is-open');
    otpError.textContent = '';
    var retry = pendingAfterOtp;
    pendingAfterOtp = null;
    if (retry) retry();
  }, function (err) {
    otpBusy = false;
    otpSubmitBtn.disabled = false;
    otpError.textContent = 'Cannot reach the server: ' + err.message;
  });
}

otpSubmitBtn.addEventListener('click', submitOtp);
otpInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') submitOtp();
});
otpInput.addEventListener('input', function () {
  // Authy copies the code to the clipboard, so a paste lands all six at once.
  var digits = otpInput.value.replace(/\D/g, '').slice(0, 6);
  if (otpInput.value !== digits) otpInput.value = digits;
  if (digits.length === 6) submitOtp();
});

// ---- Idle lock --------------------------------------------------------------
// After `idleMinutes` (from /api/auth/status) with no keyboard, pointer or
// touch activity the session is revoked on the server, the token is dropped,
// and the prompt opens. Time-based rather than setTimeout-based: background
// tabs throttle timers, and the check on becoming visible again is what
// catches a tab that sat hidden for an hour. Nothing runs on an ungated server.

let lastActivity = Date.now();
function noteActivity() { lastActivity = Date.now(); }

function lock() {
  if (otpOverlay.classList.contains('is-open') || otpOpening) return;
  var token = getToken();
  if (!token) return;
  noteActivity(); // so the next check does not fire again while the prompt opens
  // Revoke server-side; a failure here (offline, restarted) still locks locally.
  fetch('/api/auth/lock', { method: 'POST', headers: { 'X-Hub-Token': token } }).catch(function () {});
  clearToken();
  askForOtp(function () {});
}

function startIdleLock(status) {
  if (!status || !status.required) return;
  var idleMs = Math.max(1000, Number(status.idleMinutes || 10) * 60000);
  ['pointerdown', 'keydown', 'mousemove', 'touchstart', 'scroll'].forEach(function (name) {
    window.addEventListener(name, noteActivity, { passive: true, capture: true });
  });
  function check() { if (Date.now() - lastActivity >= idleMs) lock(); }
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { check(); noteActivity(); }
  });
  // Frequent enough that a short test window locks promptly, never busier
  // than every 250ms, never lazier than every 30s.
  setInterval(check, Math.max(250, Math.min(30000, idleMs / 3)));
}

fetchAuthStatus().then(startIdleLock);

export function api(path, options) {
  var opts = options || {};
  var headers = Object.assign({}, opts.headers || {});
  var token = getToken();
  if (token) headers['X-Hub-Token'] = token;
  if (opts.body) headers['Content-Type'] = 'application/json';
  return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (res) {
    if (res.status === 401) {
      clearToken(); // it is expired or from a previous run of the server
      return new Promise(function (resolve, reject) {
        askForOtp(function () { api(path, options).then(resolve, reject); });
      });
    }
    var isJson = (res.headers.get('content-type') || '').indexOf('json') !== -1;
    if (!res.ok) {
      return (isJson ? res.json() : res.text()).then(function (payload) {
        var message = payload && payload.error ? payload.error : String(payload || res.status);
        var err = new Error(message);
        err.status = res.status;
        throw err;
      });
    }
    return isJson ? res.json() : res.text();
  });
}
