// SPDX-License-Identifier: MIT
// The add-on of test/smoke/built.html (P5): a block with a label and a DOM
// behaviour, and a stylesheet through luccet.style, whose place in the head
// follows data-use on a built page too.
luccet.block('box', { tag: 'aside', counter: 'box', label: 'Box', dom(el) { el.dataset.dom = 'yes'; } });
luccet.style('main.luccet aside.box { padding-inline: 1rem; }');
