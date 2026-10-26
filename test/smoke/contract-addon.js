// The add-on contract (docs/addon-api.html), item by item, with no library:
// test/smoke.js reads what it logs to window.__contract, and builds the page
// with the command line to see the same vocabulary under node.
(function () {
  'use strict';
  const L = window.luccet;
  const log = (window.__contract = []);
  const at = (root) => root.id || root.localName;

  // The number, and the options: window.LUCCET.use, then the query string.
  log.push(`api ${L.api}`);
  log.push(`use ${JSON.stringify(Object.assign({}, L.config.use['contract-addon']))}`);

  // The registry: a bad name throws; an entry is returned, and is the registry's.
  let bad = 'none';
  try {
    L.block('a b', {});
  } catch (e) {
    bad = e instanceof TypeError ? 'TypeError' : 'other';
  }
  log.push(`bad ${bad}`);
  const entry = L.block('card', { tag: 'aside', class: 'contract-card', dom: (el) => log.push(`dom ${el.id}`) });
  log.push(`entry ${entry === L.schema.block.card}`);
  L.leaf('host', {});

  // A behaviour after the entry's dom; listeners, the awaited 'render' first.
  L.define('card', (el) => log.push(`define ${el.id}`));
  L.on('render', async (root, info) => {
    log.push(`render ${at(root)} safe=${info.safe}`);
    await new Promise((r) => setTimeout(r, 30));
    log.push(`render-done ${at(root)}`);
  });
  L.on('math', (root, info) => log.push(`math ${at(root)} safe=${info.safe}`));
  L.on('ready', () => log.push('ready'));

  // A transform, with a diagnostic of the add-on's own.
  L.transform('contract', (ast, ctx) => void ctx.report('contract.ran', null, 'the contract transform ran', null, 'info'));

  // Words: a fallback with a field, and the page's own string.
  log.push(`string ${L.string('contract.hi', { who: 'you' }, 'hi {who}')}`);
  log.push(`own ${L.string('contract.own', null, 'none')}`);

  // Content shown later: a <details> that, as it opens, gets a card, handed
  // over with luccet.render(el) so the behaviours and events reach it.
  L.block('later', {
    tag: 'details',
    dom(el) {
      el.addEventListener('toggle', () => {
        if (!el.open || el.querySelector('#late')) return;
        const card = document.createElement('aside');
        card.id = 'late';
        card.className = 't-block card contract-card';
        card.setAttribute('data-t', 'card');
        card.textContent = 'Late.';
        el.append(card);
        L.render(el);
      });
    },
  });

  // Foreign content: a tree from elsewhere, one node forged, rendered with safe.
  window.__foreign = () => {
    const { ast } = L.parse(':::card{#f1}\nForeign, with $q$.\n:::\n');
    L.transform(ast);
    ast.children.push({ type: 'containerDirective', name: 'card', children: [], data: { luccet: { tag: 'img src=x onerror="window.__xss=1"' } } });
    return L.render(document.getElementById('host'), ast, { safe: true });
  };
})();
