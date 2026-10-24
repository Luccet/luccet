// SPDX-License-Identifier: MIT
// lightbox.js, Luccet's lightbox add-on (docs/addons.html#lightbox). An image in
// a figure opens full size in a dialog, on a click or on Enter, with the
// figure's caption; Escape, the close button or a click beside the image
// closes it, and focus returns to the image.
//
//   <script src="luccet.js" data-use="addons/lightbox.js"></script>
//   <script src="luccet.js" data-use="addons/lightbox.js?images=all"></script>
//
// `images=all` (on the add-on, or window.LUCCET = {use: {lightbox: {images:
// 'all'}}}) takes every image of the note, not only a figure's. An image
// inside a link is left to its link, and {data-lightbox=false} on a figure
// or an image leaves it alone. The image becomes a control: focusable, a
// button to a screen reader, named "View full size" with the caption. The words come from window.LUCCET.strings
// (viewFullSize, close; docs/api.html#strings). The dialog needs <dialog>
// (Chrome 37, Firefox 98, Safari 15.4): where it is missing, images stay as
// they are. Under node the add-on declares nothing and does nothing.
(function () {
  'use strict';
  const T = window.luccet;
  if (!T) return;
  const str = (key, params, fallback) => (T.string ? T.string(key, params, fallback) : fallback);

  T.style(
    [
      '.luccet .t-zoomable { cursor: zoom-in; }',
      '.luccet .t-zoomable:focus-visible { outline: 2px solid var(--t-link); outline-offset: 2px; }',
      '.t-lightbox { inline-size: 100vw; block-size: 100vh; max-inline-size: none; max-block-size: none; margin: 0; padding: 0; border: 0; background: rgb(0 0 0 / .88); color: #fff; }',
      '.t-lightbox::backdrop { background: rgb(0 0 0 / .5); }',
      '.t-lightbox-figure { display: flex; flex-direction: column; align-items: center; justify-content: center; inline-size: 100%; block-size: 100%; margin: 0; cursor: zoom-out; }',
      '.t-lightbox-figure > img { display: block; max-inline-size: 94vw; max-block-size: 86vh; object-fit: contain; cursor: default; }',
      '.t-lightbox-caption { margin: .75rem 1rem 0; max-inline-size: 60rem; font: .95rem/1.4 var(--t-sans); text-align: center; cursor: default; }',
      '.t-lightbox-close { position: fixed; inset-block-start: .6rem; inset-inline-end: .6rem; inline-size: 2.4rem; block-size: 2.4rem; padding: 0; font: 1.6rem/1 var(--t-sans); color: #fff; background: rgb(0 0 0 / .6); border: 1px solid #fff; border-radius: 50%; cursor: pointer; }',
      '.t-lightbox-close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }',
      'html:has(.t-lightbox[open]) { overflow: hidden; }',
      '@media print { .t-lightbox { display: none; } }',
    ].join('\n'),
  );

  const DOM = typeof document === 'object' && document !== null && document.nodeType === 9;
  if (!DOM) return;
  const supported = typeof HTMLDialogElement === 'function' && 'showModal' in HTMLDialogElement.prototype;
  if (!supported) return;

  const options = Object.assign({}, T.config && T.config.use && T.config.use.lightbox);

  // The dialog, one for the page, made when first needed (again if a render
  // took the body with it): a close button, the image and its caption.
  let box = null;
  function dialog() {
    if (box && box.el.isConnected) return box;
    const el = document.createElement('dialog');
    el.className = 't-lightbox';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 't-lightbox-close';
    close.setAttribute('aria-label', str('close', {}, 'Close'));
    close.textContent = '×';
    const figure = document.createElement('figure');
    figure.className = 't-lightbox-figure';
    const img = document.createElement('img');
    const caption = document.createElement('figcaption');
    caption.className = 't-lightbox-caption';
    figure.append(img, caption);
    el.append(close, figure);
    close.addEventListener('click', () => el.close());
    // A click anywhere but on the image, the caption or the button closes.
    el.addEventListener('click', (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('img, figcaption, button')) el.close();
    });
    el.addEventListener('close', () => {
      img.removeAttribute('src');
      img.removeAttribute('srcset');
    });
    document.body.append(el);
    return (box = { el, img, caption });
  }

  // The caption: the figure's, which carries its label, else the alt text.
  function captionOf(img) {
    const fig = img.closest('figure');
    const cap = fig && fig.querySelector(':scope > figcaption');
    return ((cap && cap.textContent) || img.getAttribute('alt') || '').trim();
  }

  function open(img) {
    const d = dialog();
    const text = captionOf(img);
    d.img.alt = img.getAttribute('alt') || '';
    if (img.getAttribute('srcset')) {
      d.img.setAttribute('srcset', img.getAttribute('srcset'));
      d.img.setAttribute('sizes', '100vw');
    }
    d.img.src = img.currentSrc || img.src;
    d.caption.textContent = text;
    d.caption.hidden = !text;
    d.el.setAttribute('aria-label', text || str('viewFullSize', {}, 'View full size'));
    d.el.showModal();
  }

  // Makes an image open the dialog: a click, or Enter or Space when focused.
  function wire(img) {
    if (img.classList.contains('t-zoomable') || img.closest('a, [data-lightbox="false"]')) return;
    img.classList.add('t-zoomable');
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-haspopup', 'dialog');
    const name = captionOf(img); // the figure's caption, else the alt text
    img.setAttribute('aria-label', name ? `${str('viewFullSize', {}, 'View full size')}: ${name}` : str('viewFullSize', {}, 'View full size'));
    img.addEventListener('click', () => open(img));
    img.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(img);
      }
    });
  }

  // A figure's images; with images=all, every image of the note.
  T.define('figure', (el) => {
    for (const img of el.querySelectorAll('img')) wire(img);
  });
  if (options.images === 'all') {
    T.on('render', (root, info) => {
      if (info && info.safe) return; // an untrusted root gets no behaviour
      for (const img of root.querySelectorAll('img')) wire(img);
    });
  }
})();
