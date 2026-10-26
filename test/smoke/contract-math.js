// The math hand-off (docs/addon-api.html#math), with no library: the add-on
// asks for formulas as TeX, typesets them in an awaited 'render' listener,
// and 'math' fires once that is done.
(function () {
  'use strict';
  const L = window.luccet;
  L.config.math = 'tex';
  const log = (window.__math = []);
  L.on('render', async (root, info) => {
    const list = [...root.querySelectorAll('.t-math')];
    const tex = list.every((el) => !el.querySelector('math') && /[a-z]/.test(el.textContent));
    log.push(`render ${list.length} tex=${tex} safe=${info.safe}`);
    await new Promise((r) => setTimeout(r, 20));
    for (const el of list) {
      if (el.hasAttribute('data-done')) continue;
      el.setAttribute('data-tex', el.textContent);
      el.textContent = `[${el.textContent}]`;
      el.setAttribute('data-done', '');
    }
  });
  L.on('math', (root) => log.push(`math ${root.querySelectorAll('.t-math[data-done]').length}`));
})();
