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
let pendingAfterOtp = null;
let otpBusy = false;

function askForOtp(retry) {
  // Several calls can 401 at once - the dashboard fires three on load. They
  // all queue behind one prompt instead of stacking three of them.
  var previous = pendingAfterOtp;
  pendingAfterOtp = previous ? function () { previous(); retry(); } : retry;
  if (otpOverlay.classList.contains('is-open')) return;
  otpError.textContent = '';
  otpInput.value = '';
  otpOverlay.classList.add('is-open');
  otpInput.focus();
}

function submitOtp() {
  if (otpBusy) return;
  var code = otpInput.value.replace(/\D/g, '');
  if (code.length !== 6) {
    otpError.textContent = 'A code is 6 digits.';
    return;
  }
  otpBusy = true;
  otpSubmitBtn.disabled = true;
  otpError.textContent = 'Checking...';

  // Deliberately not through api(): this is the one call that must not carry
  // a session token, and must not recurse into this prompt on a 401.
  fetch('/api/auth/otp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code }),
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
