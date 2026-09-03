import { applyI18n, t, getLocale, setLocale } from './i18n.js';

applyI18n();
document.getElementById('btn-lang').addEventListener('click', () => {
  setLocale(getLocale() === 'zh' ? 'en' : 'zh');
});

const panels = { sdk: 'sdk-panel', rest: 'rest-panel', restclient: 'rest-client-panel' };
function showTab(name) {
  if (!Object.hasOwn(panels, name)) name = 'rest';
  for (const [key, id] of Object.entries(panels)) {
    document.getElementById(id).style.display = key === name ? 'block' : 'none';
  }
  document.querySelectorAll('[data-tab]').forEach(link => {
    const active = link.dataset.tab === name;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}
function syncTab() {
  // Swagger normalizes hashes to #/... on startup, including reference links.
  const hash = location.hash.slice(1).replace(/^\/(?=(?:sdk|restclient|rest)(?:-|$))/, '');
  showTab(hash.startsWith('sdk-') || hash === 'sdk' ? 'sdk'
    : hash.startsWith('restclient-') || hash === 'restclient' ? 'restclient' : 'rest');
  if (/^(?:sdk|restclient)(?:-|$)/.test(hash)) {
    if (location.hash !== `#${hash}`) history.replaceState(null, '', `#${hash}`);
    document.getElementById(hash)?.scrollIntoView();
  }
  if (Object.hasOwn(panels, hash)) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', syncTab);
syncTab();

for (const name of ['sdk', 'restclient']) {
  const panel = document.getElementById(panels[name]);
  const grid = panel.querySelector('.api-grid');
  const sections = [...grid.querySelectorAll('.sdk-panel')];
  const layout = document.createElement('div');
  layout.className = 'reference-layout';
  const nav = document.createElement('nav');
  nav.className = 'reference-nav';
  nav.setAttribute('aria-label', t('apiDocs.categories'));
  const navTitle = document.createElement('h2');
  navTitle.textContent = t('apiDocs.categories');
  const links = document.createElement('div');
  nav.append(navTitle, links);
  const main = document.createElement('div');
  main.className = 'reference-main';
  const toolbar = document.createElement('div');
  toolbar.className = 'reference-tools';
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = t('apiDocs.search');
  search.setAttribute('aria-label', t('apiDocs.search'));
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.textContent = t('apiDocs.clear');
  const count = document.createElement('span');
  count.className = 'reference-count';
  count.setAttribute('role', 'status');
  toolbar.append(search, clear, count);
  const empty = document.createElement('p');
  empty.className = 'reference-empty';
  empty.textContent = t('apiDocs.noResults');
  empty.hidden = true;
  grid.before(layout);
  main.append(toolbar, grid, empty);
  layout.append(nav, main);
  const entries = sections.map((section, index) => {
    section.id = `${name}-section-${index + 1}`;
    const title = section.querySelector('h2').textContent;
    const link = document.createElement('a');
    link.href = `#${section.id}`;
    link.textContent = title;
    links.append(link);
    // On narrow screens, the complete table remains reachable by touch and keyboard.
    const scroll = section.querySelector('.scroll');
    scroll.tabIndex = 0;
    scroll.setAttribute('role', 'region');
    scroll.setAttribute('aria-label', title);
    return { section, link, title: title.toLowerCase(), rows: [...section.querySelectorAll('tbody tr')] };
  });
  function filter() {
    const query = search.value.trim().toLowerCase();
    let visible = 0;
    let total = 0;
    for (const entry of entries) {
      let matches = 0;
      for (const row of entry.rows) {
        if (row.querySelector('[colspan]')) continue;
        total++;
        row.hidden = !!query && !`${entry.title} ${row.textContent.toLowerCase()}`.includes(query);
        if (!row.hidden) matches++;
      }
      entry.section.hidden = matches === 0;
      entry.link.hidden = matches === 0;
      visible += matches;
    }
    count.textContent = `${visible} / ${total} ${t('apiDocs.entries')}`;
    empty.hidden = visible !== 0;
    clear.disabled = !search.value;
  }
  search.addEventListener('input', filter);
  clear.addEventListener('click', () => { search.value = ''; filter(); search.focus(); });
  filter();
}
syncTab();
