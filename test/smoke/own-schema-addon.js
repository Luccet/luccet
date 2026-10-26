// SPDX-License-Identifier: MIT
// The add-on of test/smoke/own-schema.html (D12): its `theorem` loses to the
// note's own window.LUCCET.schema entry; its `lemma` stands.
luccet.block('theorem', { tag: 'section', counter: 'theorem', label: 'Satz', dom(el) { el.dataset.dom = 'addon'; } });
luccet.block('lemma', { tag: 'section', counter: 'theorem', label: 'Lemma' });
