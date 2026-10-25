// SPDX-License-Identifier: MIT
// The add-on of the smoke pages that need one, any one: use.html (from its
// :::use block), the long note of the :::use streaming test (/gen/use-long.html)
// and math-requests.html. It marks every fence of a root it sees rendered
// (data-fence-addon="yes"), so a test can tell it ran. Under node, where
// luccet.on is inert, it does nothing.
luccet.on('render', (root) => {
  for (const pre of root.querySelectorAll('pre')) pre.dataset.fenceAddon = 'yes';
});
