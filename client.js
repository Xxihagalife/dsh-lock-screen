/**
 * Client half of the lock-screen bundle.
 *
 * A privacy gate, not a security boundary: it covers the whole page with an
 * opaque frame-wide overlay so nobody walking past can read the conversation,
 * and it asks for a password before the overlay goes away. The password is
 * stored as a salted SHA-256 digest in localStorage (never in the session log
 * and never on the Host), and the locked flag is stored too, so a reload or a
 * new tab comes back locked instead of exposing the session.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-lock-screen',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React;

    const NS = 'dsh-lock-screen';
    const STORAGE_LOCKED = 'dsh.lock-screen.locked';
    const STORAGE_CREDENTIAL = 'dsh.lock-screen.credential';
    const OVERLAY_SELECTOR = '[data-dsh-lock-screen]';
    const MIN_PASSWORD_LENGTH = 4;

    /* ------------------------------------------------------------------ locale */

    const EN = {
      triggerLabel: 'Lock',
      triggerTitle: 'Lock DSH (Shift+click to set a password)',
      lockedTitle: 'DSH is locked',
      lockedSubtitle: 'Your tasks keep running in the background.',
      passwordPlaceholder: 'Password',
      unlock: 'Unlock',
      wrongPassword: 'That password is not correct.',
      cooldown: 'Too many attempts. Try again in {seconds}s.',
      noPasswordHint: 'No password is set — press Unlock to continue.',
      setPasswordLink: 'Set a password…',
      setupCreateTitle: 'Set a lock-screen password',
      setupChangeTitle: 'Change the lock-screen password',
      setupDescription: 'The password unlocks this screen only. Keep the window closed while you are away.',
      currentPasswordPlaceholder: 'Current password',
      newPasswordPlaceholder: 'New password (at least {min} characters)',
      confirmPasswordPlaceholder: 'Repeat the new password',
      passwordTooShort: 'Use at least {min} characters.',
      passwordMismatch: 'The two passwords do not match.',
      saveAndLock: 'Set password and lock',
      savePassword: 'Save password',
      lockWithoutPassword: 'Lock without a password',
      removePassword: 'Remove password',
      cancel: 'Cancel',
      windowTitle: 'DSH — locked',
      triggerAriaLabel: 'Lock DSH',
    };

    const ZH = {
      triggerLabel: '锁定',
      triggerTitle: '锁定 DSH（Shift+点击设置密码）',
      lockedTitle: 'DSH 已锁定',
      lockedSubtitle: '后台任务仍在继续运行。',
      passwordPlaceholder: '输入密码',
      unlock: '解锁',
      wrongPassword: '密码不正确。',
      cooldown: '尝试次数过多，请 {seconds} 秒后再试。',
      noPasswordHint: '未设置密码 — 点击解锁即可继续。',
      setPasswordLink: '设置密码…',
      setupCreateTitle: '设置锁屏密码',
      setupChangeTitle: '修改锁屏密码',
      setupDescription: '该密码只用于解锁此界面。离开时请保持窗口处于锁定状态。',
      currentPasswordPlaceholder: '当前密码',
      newPasswordPlaceholder: '新密码（至少 {min} 个字符）',
      confirmPasswordPlaceholder: '再次输入新密码',
      passwordTooShort: '密码至少需要 {min} 个字符。',
      passwordMismatch: '两次输入的密码不一致。',
      saveAndLock: '设置密码并锁定',
      savePassword: '保存密码',
      lockWithoutPassword: '不使用密码，直接锁定',
      removePassword: '移除密码',
      cancel: '取消',
      windowTitle: 'DSH（已锁定）',
      triggerAriaLabel: '锁定 DSH',
    };

    let locale = null;
    let t = (key) => key;

    function useTranslate() {
      const subscribe = useCallback((fn) => locale.subscribe(fn), []);
      const getSnapshot = useCallback(() => locale.getSnapshot(), []);
      useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
      return t;
    }

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
      );
    }

    /* ------------------------------------------------------------------ storage */

    function readRaw(key) {
      try {
        return window.localStorage.getItem(key);
      } catch (error) {
        return null;
      }
    }

    function writeRaw(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch (error) {
        /* private mode / storage disabled: the lock still works for this page */
      }
    }

    function removeRaw(key) {
      try {
        window.localStorage.removeItem(key);
      } catch (error) {
        /* ignore */
      }
    }

    function parseCredential(raw) {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (
          parsed &&
          typeof parsed.salt === 'string' &&
          typeof parsed.hash === 'string' &&
          parsed.salt &&
          parsed.hash
        ) {
          return parsed;
        }
      } catch (error) {
        /* fall through */
      }
      return null;
    }

    function randomHex(bytes) {
      const buffer = new Uint8Array(bytes);
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        window.crypto.getRandomValues(buffer);
      } else {
        for (let index = 0; index < buffer.length; index += 1) {
          buffer[index] = Math.floor(Math.random() * 256);
        }
      }
      return Array.from(buffer, (value) => value.toString(16).padStart(2, '0')).join('');
    }

    function hexOf(bytes) {
      return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    }

    /** Used only when WebCrypto is unavailable (a non-secure page origin). */
    function weakHash(text) {
      let first = 0x811c9dc5;
      let second = 0x01000193;
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
      }
      return `w${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
    }

    async function digest(text) {
      if (window.crypto && window.crypto.subtle && typeof window.crypto.subtle.digest === 'function') {
        const buffer = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return hexOf(new Uint8Array(buffer));
      }
      return weakHash(text);
    }

    /* -------------------------------------------------------------------- store */

    let state = {
      locked: readRaw(STORAGE_LOCKED) === '1',
      credential: parseCredential(readRaw(STORAGE_CREDENTIAL)),
      setup: null,
    };

    const listeners = new Set();

    function emit() {
      state = Object.assign({}, state);
      listeners.forEach((listener) => {
        try {
          listener();
        } catch (error) {
          /* a broken subscriber must not break the lock */
        }
      });
    }

    function subscribeStore(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    function getSnapshot() {
      return state;
    }

    function setLocked(next) {
      if (state.locked === next) return;
      state = Object.assign({}, state, { locked: next });
      writeRaw(STORAGE_LOCKED, next ? '1' : '0');
      emit();
    }

    function openSetup(mode, lockAfterSave) {
      state = Object.assign({}, state, { setup: { mode, lockAfterSave: lockAfterSave === true } });
      emit();
    }

    function closeSetup() {
      if (!state.setup) return;
      state = Object.assign({}, state, { setup: null });
      emit();
    }

    async function savePassword(password) {
      const salt = randomHex(16);
      const hash = await digest(`${salt}\u0000${password}`);
      const credential = { v: 1, salt, hash };
      writeRaw(STORAGE_CREDENTIAL, JSON.stringify(credential));
      state = Object.assign({}, state, { credential, setup: null });
      emit();
    }

    async function verifyPassword(password) {
      const credential = state.credential;
      if (!credential) return true;
      const hash = await digest(`${credential.salt}\u0000${password}`);
      return hash === credential.hash;
    }

    function clearPassword() {
      removeRaw(STORAGE_CREDENTIAL);
      state = Object.assign({}, state, { credential: null, setup: null });
      emit();
    }

    /* -------------------------------------------------------------------- icons */

    function LockGlyph({ size }) {
      const edge = typeof size === 'number' ? size : 16;
      return h(
        'svg',
        {
          width: edge,
          height: edge,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('rect', { x: 4.5, y: 10.2, width: 15, height: 10.3, rx: 2.4 }),
        h('path', { d: 'M8 10.2V7.9a4 4 0 0 1 8 0v2.3' }),
        h('circle', { cx: 12, cy: 15.2, r: 1.15, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M12 16.3v1.6' }),
      );
    }

    /* ------------------------------------------------------------------- styles */

    const CSS = `
.dsh-lock-trigger{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease}
.dsh-lock-trigger:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 8%,transparent);color:var(--dsw-alias-label-primary,#111)}
.dsh-lock-trigger:active{background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 14%,transparent)}
.dsh-lock-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px}
.dsh-lock-trigger[data-wide="false"]{width:28px;padding:0}
.dsh-lock-trigger-label{display:inline-block;max-width:74px;overflow:hidden;text-overflow:ellipsis}

.dsh-lock-screen{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font-family:inherit;user-select:none;cursor:default}
.dsh-lock-panel{width:min(340px,calc(100vw - 56px));display:flex;flex-direction:column;align-items:center;text-align:center}
.dsh-lock-badge{width:56px;height:56px;border-radius:18px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 12%,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-brand-primary,#247bbf);margin-bottom:18px}
.dsh-lock-title{font-size:17px;font-weight:600;line-height:1.4}
.dsh-lock-subtitle{margin-top:7px;font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#6b7280)}
.dsh-lock-form{width:100%;margin-top:22px;display:flex;flex-direction:column;gap:10px}
.dsh-lock-input{width:100%;box-sizing:border-box;height:38px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 4%,var(--dsw-alias-bg-base,#fff));color:inherit;padding:0 12px;font:inherit;font-size:13px;outline:none;transition:border-color .12s ease,box-shadow .12s ease}
.dsh-lock-input::placeholder{color:var(--dsw-alias-label-secondary,#8a8f98)}
.dsh-lock-input:focus{border-color:var(--dsw-alias-brand-primary,#247bbf);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#247bbf) 18%,transparent)}
.dsh-lock-input:disabled{opacity:.6}
.dsh-lock-primary{height:38px;width:100%;border-radius:10px;border:0;background:var(--dsw-alias-brand-primary,#247bbf);color:var(--dsw-alias-bg-base,#fff);font:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:filter .12s ease}
.dsh-lock-primary:hover{filter:brightness(1.06)}
.dsh-lock-primary:active{filter:brightness(.94)}
.dsh-lock-primary:disabled{opacity:.45;cursor:not-allowed;filter:none}
.dsh-lock-primary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px}
.dsh-lock-message{min-height:17px;font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#d14343)}
.dsh-lock-hint{margin-top:18px;font-size:11px;line-height:1.7;color:var(--dsw-alias-label-secondary,#8a8f98);display:flex;align-items:center;gap:6px;justify-content:center;flex-wrap:wrap}
.dsh-lock-link{border:0;background:none;padding:0;font:inherit;font-size:11px;color:var(--dsw-alias-brand-primary,#247bbf);cursor:pointer;text-decoration:underline;text-underline-offset:2px}
.dsh-lock-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px;border-radius:3px}

.dsh-lock-backdrop{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(12,14,17,.44)}
.dsh-lock-card{width:min(400px,100%);box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:20px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);box-shadow:0 24px 64px rgba(0,0,0,.28)}
.dsh-lock-card-title{font-size:15px;font-weight:600;line-height:1.4}
.dsh-lock-card-desc{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary,#6b7280);margin-bottom:4px}
.dsh-lock-row{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap}
.dsh-lock-ghost{flex:1 1 120px;height:38px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));background:transparent;color:var(--dsw-alias-label-primary,#111);font:inherit;font-size:12px;cursor:pointer;padding:0 10px}
.dsh-lock-ghost:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 6%,transparent)}
.dsh-lock-ghost:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#247bbf);outline-offset:2px}
.dsh-lock-danger{color:var(--dsw-alias-state-error-primary,#d14343)}
`;

    /* ---------------------------------------------------------------- trigger */

    /** Lock right now: with a password the overlay asks for it, without one it
     * opens the password form first so leaving the desk still protects the page. */
    function lockNow() {
      if (state.credential) {
        setLocked(true);
        return;
      }
      openSetup('create', true);
    }

    function handleTriggerClick(event) {
      if (event && (event.shiftKey || event.altKey)) {
        openSetup(state.credential ? 'change' : 'create', false);
        return;
      }
      lockNow();
    }

    function LockTrigger(props) {
      const translate = useTranslate();
      useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
      const wide = !props || props.wide !== false;
      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, CSS),
        h(
          'button',
          {
            key: 'button',
            type: 'button',
            className: 'dsh-lock-trigger',
            'data-wide': wide ? 'true' : 'false',
            'aria-label': translate('triggerAriaLabel'),
            title: translate('triggerTitle'),
            onClick: handleTriggerClick,
          },
          h(LockGlyph, { size: 16 }),
          wide ? h('span', { className: 'dsh-lock-trigger-label' }, translate('triggerLabel')) : null,
        ),
      );
    }

    /* --------------------------------------------------------------- lock page */

    function LockScreen({ credential, onOpenSetup }) {
      const translate = useTranslate();
      const [password, setPassword] = useState('');
      const [errorKey, setErrorKey] = useState('');
      const [busy, setBusy] = useState(false);
      const [failures, setFailures] = useState(0);
      const [cooldownUntil, setCooldownUntil] = useState(0);
      const [now, setNow] = useState(0);
      const inputRef = useRef(null);

      useEffect(() => {
        const previous = document.title;
        document.title = translate('windowTitle');
        return () => {
          document.title = previous;
        };
      }, [translate]);

      useEffect(() => {
        if (credential && inputRef.current) inputRef.current.focus();
      }, [credential]);

      useEffect(() => {
        if (!cooldownUntil) return undefined;
        setNow(Date.now());
        const timer = window.setInterval(() => {
          const current = Date.now();
          if (current >= cooldownUntil) {
            setCooldownUntil(0);
            setErrorKey('');
            return;
          }
          setNow(current);
        }, 250);
        return () => window.clearInterval(timer);
      }, [cooldownUntil]);

      const remainingMs = Math.max(0, cooldownUntil - (now || Date.now()));
      const remainingSeconds = Math.ceil(remainingMs / 1000);
      const blocked = remainingSeconds > 0;

      async function submit(event) {
        if (event) event.preventDefault();
        if (!credential) {
          setLocked(false);
          return;
        }
        if (busy || blocked) return;
        if (!password) {
          if (inputRef.current) inputRef.current.focus();
          return;
        }
        setBusy(true);
        setErrorKey('');
        const accepted = await verifyPassword(password);
        setBusy(false);
        if (accepted) {
          setPassword('');
          setFailures(0);
          setCooldownUntil(0);
          setLocked(false);
          return;
        }
        setPassword('');
        const nextFailures = failures + 1;
        setFailures(nextFailures);
        setErrorKey('wrongPassword');
        if (nextFailures >= 3) {
          const penalty = Math.min(60, 5 * Math.pow(2, nextFailures - 3));
          setCooldownUntil(Date.now() + penalty * 1000);
          setNow(Date.now());
        }
        if (inputRef.current) inputRef.current.focus();
      }

      const message = blocked
        ? fill(translate('cooldown'), { seconds: remainingSeconds })
        : errorKey
          ? translate(errorKey)
          : '';

      function trapFocus(event) {
        if (event.key !== 'Tab') return;
        event.preventDefault();
        if (inputRef.current) inputRef.current.focus();
      }

      const body = credential
        ? h(
            'form',
            { className: 'dsh-lock-form', onSubmit: submit },
            h('input', {
              ref: inputRef,
              className: 'dsh-lock-input',
              type: 'password',
              autoComplete: 'current-password',
              spellCheck: false,
              'aria-label': translate('passwordPlaceholder'),
              placeholder: translate('passwordPlaceholder'),
              value: password,
              disabled: busy || blocked,
              onChange: (event) => {
                setPassword(event.target.value);
                if (errorKey) setErrorKey('');
              },
            }),
            h(
              'button',
              { className: 'dsh-lock-primary', type: 'submit', disabled: busy || blocked },
              translate('unlock'),
            ),
            h('div', { className: 'dsh-lock-message', role: 'status', 'aria-live': 'polite' }, message),
          )
        : h(
            'div',
            { className: 'dsh-lock-form' },
            h(
              'button',
              {
                className: 'dsh-lock-primary',
                type: 'button',
                autoFocus: true,
                onClick: () => {
                  setLocked(false);
                },
              },
              translate('unlock'),
            ),
          );

      const hint = credential
        ? null
        : h(
            'div',
            { className: 'dsh-lock-hint' },
            h('span', null, translate('noPasswordHint')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-lock-link',
                onClick: (event) => {
                  event.stopPropagation();
                  onOpenSetup();
                },
              },
              translate('setPasswordLink'),
            ),
          );

      return h(
        'div',
        {
          className: 'dsh-lock-screen',
          'data-dsh-lock-screen': '',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': translate('lockedTitle'),
          onKeyDown: trapFocus,
        },
        h(
          'div',
          { className: 'dsh-lock-panel' },
          h('div', { className: 'dsh-lock-badge' }, h(LockGlyph, { size: 26 })),
          h('div', { className: 'dsh-lock-title' }, translate('lockedTitle')),
          h('div', { className: 'dsh-lock-subtitle' }, translate('lockedSubtitle')),
          body,
          hint,
        ),
      );
    }

    /* -------------------------------------------------------------- setup card */

    function SetupCard({ mode, lockAfterSave }) {
      const translate = useTranslate();
      const snapshot = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
      const hasCredential = Boolean(snapshot.credential);
      const needsCurrent = mode === 'change' && hasCredential;
      const [current, setCurrent] = useState('');
      const [next, setNext] = useState('');
      const [confirm, setConfirm] = useState('');
      const [errorKey, setErrorKey] = useState('');
      const [busy, setBusy] = useState(false);
      const firstRef = useRef(null);

      useEffect(() => {
        if (firstRef.current) firstRef.current.focus();
      }, []);

      async function submit(event) {
        if (event) event.preventDefault();
        if (busy) return;
        setErrorKey('');
        if (needsCurrent) {
          const accepted = await verifyPassword(current);
          if (!accepted) {
            setErrorKey('wrongPassword');
            return;
          }
        }
        if (next.length < MIN_PASSWORD_LENGTH) {
          setErrorKey('passwordTooShort');
          return;
        }
        if (next !== confirm) {
          setErrorKey('passwordMismatch');
          return;
        }
        setBusy(true);
        await savePassword(next);
        setBusy(false);
        if (lockAfterSave) setLocked(true);
      }

      const message = errorKey
        ? fill(translate(errorKey), { min: MIN_PASSWORD_LENGTH })
        : '';

      return h(
        'div',
        {
          className: 'dsh-lock-backdrop',
          'data-dsh-lock-screen': '',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': translate(mode === 'change' ? 'setupChangeTitle' : 'setupCreateTitle'),
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closeSetup();
          },
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              closeSetup();
            }
          },
        },
        h(
          'form',
          { className: 'dsh-lock-card', onSubmit: submit },
          h(
            'div',
            { className: 'dsh-lock-card-title' },
            translate(mode === 'change' ? 'setupChangeTitle' : 'setupCreateTitle'),
          ),
          h('div', { className: 'dsh-lock-card-desc' }, translate('setupDescription')),
          needsCurrent
            ? h('input', {
                ref: firstRef,
                className: 'dsh-lock-input',
                type: 'password',
                autoComplete: 'current-password',
                'aria-label': translate('currentPasswordPlaceholder'),
                placeholder: translate('currentPasswordPlaceholder'),
                value: current,
                onChange: (event) => setCurrent(event.target.value),
              })
            : null,
          h('input', {
            ref: needsCurrent ? undefined : firstRef,
            className: 'dsh-lock-input',
            type: 'password',
            autoComplete: 'new-password',
            'aria-label': fill(translate('newPasswordPlaceholder'), { min: MIN_PASSWORD_LENGTH }),
            placeholder: fill(translate('newPasswordPlaceholder'), { min: MIN_PASSWORD_LENGTH }),
            value: next,
            onChange: (event) => setNext(event.target.value),
          }),
          h('input', {
            className: 'dsh-lock-input',
            type: 'password',
            autoComplete: 'new-password',
            'aria-label': translate('confirmPasswordPlaceholder'),
            placeholder: translate('confirmPasswordPlaceholder'),
            value: confirm,
            onChange: (event) => setConfirm(event.target.value),
          }),
          h('div', { className: 'dsh-lock-message', role: 'status', 'aria-live': 'polite' }, message),
          h(
            'div',
            { className: 'dsh-lock-row' },
            h(
              'button',
              { className: 'dsh-lock-primary', type: 'submit', disabled: busy, style: { flex: '1 1 140px' } },
              translate(lockAfterSave ? 'saveAndLock' : 'savePassword'),
            ),
            h(
              'button',
              {
                className: 'dsh-lock-ghost',
                type: 'button',
                onClick: () => {
                  closeSetup();
                },
              },
              translate('cancel'),
            ),
          ),
          !hasCredential && mode === 'create'
            ? h(
                'div',
                { className: 'dsh-lock-row' },
                h(
                  'button',
                  {
                    className: 'dsh-lock-ghost',
                    type: 'button',
                    onClick: () => {
                      closeSetup();
                      setLocked(true);
                    },
                  },
                  translate('lockWithoutPassword'),
                ),
              )
            : null,
          needsCurrent
            ? h(
                'div',
                { className: 'dsh-lock-row' },
                h(
                  'button',
                  {
                    className: 'dsh-lock-ghost dsh-lock-danger',
                    type: 'button',
                    onClick: () => {
                      clearPassword();
                    },
                  },
                  translate('removePassword'),
                ),
              )
            : null,
        ),
      );
    }

    /* ----------------------------------------------------------------- overlay */

    function LockOverlay() {
      const snapshot = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
      if (!snapshot.locked && !snapshot.setup) return null;
      return h(
        React.Fragment,
        null,
        h('style', { key: 'style' }, CSS),
        snapshot.locked
          ? h(LockScreen, {
              key: 'screen',
              credential: snapshot.credential,
              onOpenSetup: () => openSetup('create', true),
            })
          : null,
        snapshot.setup
          ? h(SetupCard, {
              key: 'setup',
              mode: snapshot.setup.mode,
              lockAfterSave: snapshot.setup.lockAfterSave,
            })
          : null,
      );
    }

    /* -------------------------------------------------------------------- apply */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        locale = ctx.locale;
        if (locale) {
          t = locale.bind(NS);
          ctx.effect(() => locale.register(NS, 'en', EN));
          ctx.effect(() => locale.register(NS, 'zh', ZH));
        }

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'lock-screen', order: 10, label: () => t('triggerLabel') },
            LockTrigger,
          ),
        );

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'lock-screen', order: 100 }, LockOverlay),
        );

        ctx.effect(() => {
          const onKeyDown = (event) => {
            const target = event.target;
            const insideOverlay =
              target && typeof target.closest === 'function' && target.closest(OVERLAY_SELECTOR);
            if (state.locked && !insideOverlay) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            const modifier = event.ctrlKey || event.metaKey;
            if (modifier && event.shiftKey && (event.key === 'L' || event.key === 'l' || event.code === 'KeyL')) {
              event.preventDefault();
              event.stopPropagation();
              lockNow();
            }
          };
          window.addEventListener('keydown', onKeyDown, true);
          return () => window.removeEventListener('keydown', onKeyDown, true);
        });

        ctx.effect(() => {
          const onStorage = (event) => {
            if (event.key === STORAGE_LOCKED) {
              const locked = event.newValue === '1';
              if (state.locked !== locked) {
                state = Object.assign({}, state, { locked });
                emit();
              }
              return;
            }
            if (event.key === STORAGE_CREDENTIAL) {
              const credential = parseCredential(event.newValue);
              state = Object.assign({}, state, { credential });
              emit();
            }
          };
          window.addEventListener('storage', onStorage);
          return () => window.removeEventListener('storage', onStorage);
        });
      },
    };
  },
});
