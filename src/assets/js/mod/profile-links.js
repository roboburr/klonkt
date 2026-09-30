// De profiellinks: een regel toevoegen uit het <template>, een regel weghalen.
//
// Stond in admin-site-edit.js, toen de links op de Appearance-pagina stonden.
// Sinds 30-9 bewerk je ze bij je profiel (/account), naast je naam, bio en foto.
//
// De bootstrap in shell.ejs roept init() aan bij elke paginawissel waarop deze
// module actief is; de vlag op het element voorkomt dat een tweede aanroep de
// knoppen dubbel bedraadt.
export function init() {
  const rows = document.getElementById('profile-links-rows');
  const tpl = document.getElementById('profile-link-template');
  const add = document.getElementById('profile-link-add');
  if (!rows || !tpl || !add || rows.__wired) return;
  rows.__wired = true;
  add.addEventListener('click', () => {
    rows.appendChild(tpl.content.cloneNode(true));
    const field = rows.lastElementChild && rows.lastElementChild.querySelector('input');
    if (field) field.focus();
  });
  rows.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.pl-remove');
    if (!btn) return;
    const row = btn.closest('.profile-link-row');
    if (row) row.remove();
  });
}

export default { init };
