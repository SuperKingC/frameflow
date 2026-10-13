// FrameFlow - 站点邀请码门禁(首页与直开的工具页共用)
// 同一把码、同一 sessionStorage(ffGenInvite):
// 服务端未设码 → 本机免码直进;已验证 → 静默复验直进;否则显示门禁,输码通过解锁。
// 页面主内容放 #appMain(hidden)时,解锁时一并显示;解锁后置 window.FFGate = { ok, code },
// app.js 给 /api/gen/* 请求附带 Bearer。
(function () {
  'use strict';

  const $ = function (sel) { return document.querySelector(sel); };
  const overlay = document.getElementById('gateOverlay');
  const input = document.getElementById('gateCode');
  const go = document.getElementById('gateGo');
  const err = document.getElementById('gateError');
  const app = document.getElementById('appMain');

  const gate = (window.FFGate = { ok: false, code: '' });

  function unlock(code) {
    gate.ok = true;
    gate.code = code || '';
    overlay.hidden = true;
    input.value = '';
    if (app) app.hidden = false;
  }

  function showGate() {
    overlay.hidden = false;
    input.focus();
  }

  function showErr(text) {
    err.textContent = text;
    err.hidden = false;
  }

  // 走生图工作台的验证入口(错码由服务端记失败次数);resolve true = 验证通过
  function verify(code) {
    go.disabled = true;
    err.hidden = true;
    return fetch('/api/studio/quota', { headers: { authorization: 'Bearer ' + code } })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (payload) {
          return { ok: r.ok, status: r.status, payload: payload };
        });
      })
      .then(function (result) {
        go.disabled = false;
        if (result.status === 403 || result.payload.error === 'invite_locked') {
          showErr('邀请码错误次数过多,今日已锁定,请明天再试');
          return false;
        }
        if (!result.ok) {
          const left = result.payload.attemptsRemaining;
          showErr('邀请码不正确' + (left !== undefined ? ',今天还可尝试 ' + left + ' 次' : ''));
          return false;
        }
        return true;
      })
      .catch(function () {
        go.disabled = false;
        showErr('验证请求失败,请重试');
        return false;
      });
  }

  function enter() {
    const code = input.value.trim();
    if (!code) { showErr('请输入邀请码'); return; }
    verify(code).then(function (ok) {
      if (!ok) return;
      try { sessionStorage.setItem('ffGenInvite', code); } catch (e) { /* 隐私模式忽略 */ }
      unlock(code);
    });
  }

  go.addEventListener('click', enter);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') enter(); });

  (function autoEnter() {
    fetch('/api/studio/models')
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        if (payload.inviteRequired === false) { unlock(''); return; }
        let saved = null;
        try { saved = sessionStorage.getItem('ffGenInvite'); } catch (e) { saved = null; }
        if (!saved) { showGate(); return; }
        verify(saved).then(function (ok) {
          if (ok) { unlock(saved); return; }
          try { sessionStorage.removeItem('ffGenInvite'); } catch (e) { /* 忽略 */ }
          showGate();
        });
      })
      .catch(function () { showGate(); /* 探测失败:按需码兜底 */ });
  })();
})();
