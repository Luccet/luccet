// SPDX-License-Identifier: MIT
// copy.js, Tern's copy-button add-on (docs/addons.html#copy). Every fence and
// listing gets a button that copies its code to the clipboard: the code
// alone, as written, without line numbers or highlighting. The button says
// "Copy", then "Copied" for a moment, and a status line says the same to a
// screen reader.
//
//   <script src="tern.js" data-use="addons/copy.js"></script>
//
// A fence with {data-copy=false} gets no button. The words come from
// window.TERN.strings (copy, copied, copyFailed; docs/api.html#strings). The
// clipboard API is used where the page may (a secure context: https, a local
// file, localhost); elsewhere the copy goes through a selection, which works
// inside a click everywhere. The button is not printed. Under node the add-on
// declares nothing and does nothing.
(function () {
  'use strict';
  const T = window.tern;
  if (!T) return;
  const str = (key, params, fallback) => (T.string ? T.string(key, params, fallback) : fallback);

  T.style(
    [
      '.tern pre.t-copyable { position: relative; }',
      // Muted text at rest, the text colour on hover or focus: both pairs are
      // the theme's checked ones (opacity would blend the button into the
      // fence and fail the contrast check in some light themes).
      '.t-copy { position: absolute; inset-block-start: .4rem; inset-inline-end: .4rem; margin: 0; padding: .3em .6em; font: 600 .75rem/1 var(--t-sans); color: var(--t-muted); background: var(--t-bg); border: 1px solid var(--t-line-strong); border-radius: 4px; cursor: pointer; user-select: none; -webkit-user-select: none; }',
      '.t-copy:hover, .t-copy:focus-visible, .t-copyable:hover > .t-copy { color: var(--t-fg); }',
      '.t-copy:focus-visible { outline: 2px solid var(--t-link); outline-offset: 1px; }',
      '.t-copy[data-done="yes"] { border-color: var(--t-fg); }',
      '.t-copy[data-done="no"] { color: var(--t-error); border-color: var(--t-error); }',
      '.t-copy-status { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }',
      '@media print { .t-copy { display: none; } }',
    ].join('\n'),
  );

  const DOM = typeof document === 'object' && document !== null && document.nodeType === 9;
  if (!DOM) return;

  // One status line for the page, for screen readers; made when first needed,
  // again if a render took the body with it.
  let status = null;
  function say(text) {
    if (!status || !status.isConnected) {
      status = document.createElement('div');
      status.className = 't-copy-status';
      status.setAttribute('role', 'status');
      document.body.append(status);
    }
    status.textContent = '';
    status.textContent = text;
  }

  // The clipboard API, else a selection and execCommand('copy'), which needs
  // no permission inside a click. Resolves to whether the copy was made.
  async function copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      // not allowed here: the selection route below
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.setAttribute('aria-hidden', 'true');
    area.className = 't-copy-status';
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {
      ok = false;
    }
    area.remove();
    return ok;
  }

  const RESET_MS = 1800;
  function button(code) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 't-copy';
    const idle = str('copy', {}, 'Copy');
    b.textContent = idle;
    let timer = 0;
    b.addEventListener('click', () => {
      copy(code.textContent).then((ok) => {
        const word = ok ? str('copied', {}, 'Copied') : str('copyFailed', {}, 'Copy failed');
        b.textContent = word;
        b.setAttribute('data-done', ok ? 'yes' : 'no');
        say(word);
        clearTimeout(timer);
        timer = setTimeout(() => {
          b.textContent = idle;
          b.removeAttribute('data-done');
        }, RESET_MS);
      });
    });
    return b;
  }

  // Fences are pre[data-t=code], listings figure[data-t=code] holding one; the
  // author's attributes are on that element. The button goes inside the pre,
  // first, so a fence another add-on moves or hides (a diagram) takes it along.
  T.define('code', (el) => {
    if ((el.getAttribute('data-copy') || '').trim().toLowerCase() === 'false') return;
    const pre = el.matches('pre') ? el : el.querySelector(':scope > pre');
    const code = pre && pre.querySelector(':scope > code');
    if (!code || pre.querySelector(':scope > .t-copy')) return;
    pre.classList.add('t-copyable');
    pre.prepend(button(code));
  });
})();
