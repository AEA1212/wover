'use strict';

/* Dashboard: flashcard review, the word list, settings and backups. */

const { h, icon, LEVELS } = Wover;
const $ = (selector) => document.querySelector(selector);

// Apply the remembered theme before the page paints; the stored setting is applied once loaded.
applyTheme(readTheme());

const state = {
  words: new Map(), // storage key -> entry
  settings: Wover.normalizeSettings(null),
  stats: { days: {} },
  meta: {},
  tab: 'review',
  filter: { q: '', level: 'all', sort: 'recent', limit: 60 },
  session: null, // { queue, index, revealed, reviewed, again, practice, direction }
  editing: null, // key of the word being edited
  pendingImport: null,
  list: readList(), // the word list on show: a language code, or 'all'
  addLang: null,    // language picked in the "add a word" form
};

function readList() {
  try {
    return localStorage.getItem('wover.list') || 'all';
  } catch (err) {
    return 'all';
  }
}

function saveList() {
  try {
    localStorage.setItem('wover.list', state.list);
  } catch (err) {
    // Not remembered between visits; nothing else depends on it.
  }
}

init();

async function init() {
  browser.tabs.getCurrent()
    .then((tab) => { window.woverTab = { id: tab.id, windowId: tab.windowId }; })
    .catch(() => {});
  await load();
  applyTheme(state.settings.theme);
  applyScheme();
  setUpThemeSwitch();
  setUpSettings();
  setUpWords();
  setUpKeys();
  setUpTooltip();
  browser.storage.onChanged.addListener(onStorageChanged);
  addEventListener('hashchange', route);
  route();
}

async function load() {
  const all = await browser.storage.local.get(null);
  state.settings = Wover.normalizeSettings(all.settings);
  state.stats = all.stats && all.stats.days ? all.stats : { days: {} };
  state.meta = all.meta || {};
  state.words = new Map(Object.keys(all).filter((k) => k.startsWith('w:')).map((k) => [k, all[k]]));
}

let renderTimer = 0;
function onStorageChanged(changes, area) {
  if (area !== 'local') return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (key.startsWith('w:')) {
      if (newValue) state.words.set(key, newValue);
      else state.words.delete(key);
    } else if (key === 'settings') {
      const next = Wover.normalizeSettings(newValue);
      // Changed somewhere else (another dashboard tab): refresh the controls too.
      if (JSON.stringify(next) !== JSON.stringify(state.settings)) {
        state.settings = next;
        fillSettingsForm();
        renderHighlightSettings();
      }
      applyTheme(state.settings.theme);
      applyScheme();
    } else if (key === 'stats') {
      state.stats = newValue && newValue.days ? newValue : { days: {} };
    } else if (key === 'meta') {
      state.meta = newValue || {};
    }
  }
  clearTimeout(renderTimer);
  renderTimer = setTimeout(renderCurrent, 50);
}

function route() {
  const tab = location.hash.slice(1);
  state.tab = ['review', 'words', 'settings'].includes(tab) ? tab : 'review';
  for (const section of document.querySelectorAll('.tab')) section.hidden = section.id !== `tab-${state.tab}`;
  for (const link of document.querySelectorAll('.tabs a')) {
    if (link.dataset.tab === state.tab) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  renderCurrent();
}

function renderCurrent() {
  renderLists();
  const due = dueCount();
  $('#tab-due').textContent = due ? String(due) : '';
  renderBanners();
  if (state.tab === 'review') renderReview();
  else if (state.tab === 'words') renderWords(true);
  else renderSettingsInfo();
}

/* ---------- shared bits ---------- */

const isDue = (w, now = Date.now()) => (w.due || 0) <= now;
const langOfEntry = (w) => Wover.normLang(w.lang) || 'en';

// [key, entry] pairs of the list on show.
function scoped() {
  const all = [...state.words.entries()];
  return state.list === 'all' ? all : all.filter(([, w]) => langOfEntry(w) === state.list);
}
const scopedWords = () => scoped().map(([, w]) => w);
const dueCount = () => { const now = Date.now(); return scopedWords().filter((w) => isDue(w, now)).length; };

// Each language with saved words, biggest list first: lang -> { total, due }.
function listGroups() {
  const now = Date.now();
  const groups = new Map();
  for (const w of state.words.values()) {
    const g = groups.get(langOfEntry(w)) || { total: 0, due: 0 };
    g.total++;
    if (isDue(w, now)) g.due++;
    groups.set(langOfEntry(w), g);
  }
  return new Map([...groups].sort((a, b) => b[1].total - a[1].total || Wover.langName(a[0]).localeCompare(Wover.langName(b[0]))));
}
const showLanguages = () => state.list === 'all' && listGroups().size > 1;

function renderLists() {
  const bar = $('#lists');
  const groups = listGroups();
  if (state.list !== 'all' && !groups.has(state.list)) {
    state.list = 'all';
    saveList();
  }
  bar.hidden = groups.size < 2 || state.tab === 'settings';
  if (bar.hidden) return;
  const pill = (value, name, g) => h('button', {
    type: 'button', class: 'list-pill', 'aria-pressed': String(state.list === value), onclick: () => selectList(value),
  }, name, h('span', { class: 'list-count' }, String(g.total)), g.due ? h('span', { class: 'list-due' }, `${g.due} due`) : null);
  const due = [...groups.values()].reduce((sum, g) => sum + g.due, 0);
  bar.replaceChildren(
    ...[...groups].map(([lang, g]) => pill(lang, Wover.langName(lang), g)),
    pill('all', 'All languages', { total: state.words.size, due }));
}

function selectList(value) {
  if (state.list === value) return;
  state.list = value;
  saveList();
  state.session = null;
  state.editing = null;
  state.addLang = null;
  Object.assign(state.filter, { level: 'all', limit: 60 });
  renderCurrent();
}

// <option>s for a language picker: your lists first, then every other language.
function languageOptions(selected) {
  const mine = [...listGroups().keys()];
  const others = [...new Set(Wover.LANGUAGES.map(([code]) => Wover.normLang(code)))]
    .filter((code) => !mine.includes(code))
    .sort((a, b) => Wover.langName(a).localeCompare(Wover.langName(b)));
  const option = (code) => h('option', { value: code, selected: code === selected }, Wover.langName(code));
  return [
    mine.length ? h('optgroup', { label: 'Your lists' }, mine.map(option)) : null,
    h('optgroup', { label: mine.length ? 'Other languages' : 'Languages' }, others.map(option)),
  ];
}
const keyLabel = () => ({ Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift' })[state.settings.triggerKey] || 'Ctrl';
const safeUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url);
const hostOf = (url) => { try { return new URL(url).hostname; } catch (err) { return url; } };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "(Spanish)" after a translation that isn't in the language you translate into now.
function trNote(w) {
  const target = state.settings.targetLang;
  return w.trLang && target && w.trLang !== target
    ? h('span', { class: 'tr-lang', title: `Translated into ${Wover.languageName(w.trLang)}` }, ` (${Wover.languageName(w.trLang)})`) : null;
}

function chip(level) {
  return h('span', { class: 'chip' }, h('span', { class: `dot l${level}` }), LEVELS[level].name);
}

function firstDef(w) {
  for (const m of w.meanings || []) for (const d of m.defs || []) return { pos: m.pos, ...d };
  return null;
}

function nextDueText() {
  const now = Date.now();
  const next = Math.min(...scopedWords().map((w) => w.due || 0).filter((t) => t > now));
  return Number.isFinite(next) ? `Next review in ${Wover.formatDuration(next - now)}.` : '';
}

function ago(ts) {
  const days = Math.floor((Date.now() - ts) / Wover.DAY);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

// The sentence with the saved word (or its inflected form) marked or blanked out.
function markWord(sentence, word, level, blank = false) {
  const target = word.toLowerCase();
  const out = [];
  let last = 0;
  const wrap = (text) => (blank
    ? h('span', { class: 'cloze', 'aria-label': 'hidden word' }, '_____')
    : h('mark', { class: `hl${level}` }, text));
  if (target.includes(' ')) {
    const lower = sentence.toLowerCase();
    for (let i = lower.indexOf(target); i !== -1; i = lower.indexOf(target, last)) {
      out.push(sentence.slice(last, i), wrap(sentence.slice(i, i + target.length)));
      last = i + target.length;
    }
  } else {
    for (const m of sentence.matchAll(/[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu)) {
      const lower = m[0].toLowerCase();
      if (lower !== target && !Wover.variants(lower).includes(target)) continue;
      out.push(sentence.slice(last, m.index), wrap(m[0]));
      last = m.index + m[0].length;
    }
  }
  out.push(sentence.slice(last));
  return out;
}

function play(entry) {
  const speak = () => {
    try {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(entry.word);
      utterance.lang = entry.lang || 'en';
      speechSynthesis.speak(utterance);
    } catch (err) {
      // No speech engine available.
    }
  };
  if (/^https:\/\//.test(entry.audio || '')) new Audio(entry.audio).play().catch(speak);
  else speak();
}

function speakerButton(entry) {
  return h('button', { class: 'icon', type: 'button', title: 'Pronounce (P)', 'aria-label': `Pronounce ${entry.word}`, onclick: () => play(entry) }, icon('speaker'));
}

let toastTimer = 0;
function toast(message, undo) {
  const el = $('#toast');
  el.replaceChildren(h('span', {}, message),
    undo ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { el.hidden = true; undo(); } }, 'Undo') : null);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

async function renderBanners() {
  const items = [];
  const banner = (text, action) => h('div', { class: 'banner' }, h('p', {}, text), action);
  let access = true;
  try {
    access = await browser.permissions.contains({ origins: ['<all_urls>'] });
  } catch (err) {
    // Assume access; the content script simply won't run without it.
  }
  if (!access) {
    items.push(banner('Wover needs access to websites to show definitions and highlight your words.',
      h('button', { class: 'btn primary', type: 'button', onclick: requestAccess }, 'Allow access')));
  }
  if (!state.settings.targetLang) {
    items.push(banner(['Welcome to Wover. Choose the language you want translations in, then hold ',
      h('kbd', {}, keyLabel()), ' and point at any word on a web page.'],
    state.tab === 'settings' ? null : h('a', { class: 'btn primary', href: '#settings' }, 'Choose language')));
  }
  const last = state.meta.lastBackupAt || 0;
  if (state.words.size >= 10 && Date.now() - last > 14 * Wover.DAY) {
    items.push(banner(last ? `Your last backup was ${ago(last)}.` : 'You haven’t backed up your words yet.',
      h('button', { class: 'btn', type: 'button', onclick: exportJSON }, 'Download backup')));
  }
  $('#banners').replaceChildren(...items);
}

async function requestAccess() {
  if (await browser.permissions.request({ origins: ['<all_urls>'] })) renderBanners();
}

/* ---------- review ---------- */

function renderReview() {
  renderKpis();
  renderLevelChart();
  renderSession();
}

function streak() {
  const days = state.stats.days || {};
  const d = new Date();
  if (!days[Wover.dayKey(d)]) d.setDate(d.getDate() - 1); // today isn't over yet
  let n = 0;
  while (days[Wover.dayKey(d)]) {
    n++;
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function renderKpis() {
  const words = scopedWords();
  const now = Date.now();
  const due = words.filter((w) => isDue(w, now));
  const fresh = due.filter((w) => !w.reviews).length;
  const mastered = words.filter((w) => Wover.levelOf(w) === 4).length;
  const days = state.stats.days || {};
  const today = days[Wover.dayKey()] || 0;
  let week = 0;
  for (let i = 0; i < 7; i++) week += days[Wover.dayKey(now - i * Wover.DAY)] || 0;
  const run = streak();
  const tiles = [
    ['Due now', due.length, due.length ? `${fresh} new, ${due.length - fresh} to repeat` : nextDueText() || 'Nothing scheduled'],
    [state.list === 'all' ? 'Words saved' : `${Wover.langName(state.list)} words`, words.length, `${mastered} mastered`],
    ['Reviewed today', today, `${week} in the last 7 days`],
    ['Day streak', run, run === 1 ? 'day in a row' : 'days in a row'],
  ];
  $('#kpis').replaceChildren(...tiles.map(([label, value, note]) => h('div', { class: 'kpi' },
    h('div', { class: 'kpi-label' }, label),
    h('div', { class: 'kpi-value' }, value.toLocaleString()),
    h('div', { class: 'kpi-note' }, note))));
}

function renderLevelChart() {
  const counts = LEVELS.map(() => 0);
  for (const w of scopedWords()) counts[Wover.levelOf(w)]++;
  const total = counts.reduce((a, b) => a + b, 0);
  const max = Math.max(1, ...counts);
  $('#level-chart').replaceChildren(...LEVELS.map((level, i) => {
    const pct = total ? Math.round((counts[i] / total) * 100) : 0;
    const value = `${plural(counts[i], 'word')} · ${pct}%`;
    const width = counts[i] ? `max(3px, ${(counts[i] / max) * 100}%)` : '0';
    return h('button', {
      class: 'lvl-row', type: 'button',
      'data-tip': value, 'data-tip-label': `${level.name}: ${level.hint}`,
      'aria-label': `${level.name}: ${value}, ${level.hint}. Show these words.`,
      onclick: () => showLevel(i),
    },
    h('span', { class: 'lvl-name' }, level.name),
    h('span', { class: 'lvl-track' }, h('span', { class: `lvl-bar l${i}`, style: `width: ${width}` })),
    h('span', { class: 'lvl-value' }, String(counts[i])));
  }));
}

function showLevel(level) {
  Object.assign(state.filter, { level: String(level), q: '', limit: 60 });
  $('#search').value = '';
  location.hash = 'words';
}

function pickDirection() {
  const d = state.settings.cardDirection;
  return d === 'mixed' ? (Math.random() < 0.5 ? 'word' : 'meaning') : d;
}

function startSession(practice) {
  const now = Date.now();
  const entries = scoped();
  const queue = practice
    ? entries.sort(([, a], [, b]) => Wover.levelOf(a) - Wover.levelOf(b) || (a.lastReviewed || 0) - (b.lastReviewed || 0))
      .slice(0, 10).map(([k]) => k)
    : entries.filter(([, w]) => isDue(w, now)).sort(([, a], [, b]) => (a.due || 0) - (b.due || 0)).map(([k]) => k);
  state.session = { queue, index: 0, revealed: false, reviewed: 0, again: {}, practice, direction: pickDirection() };
  maybeAutoPlay();
}

function renderSession() {
  const box = $('#session');
  if (!state.words.size) {
    state.session = null;
    box.replaceChildren(emptyState());
    return;
  }
  if (!state.session) startSession(false);
  const s = state.session;
  // Skip cards whose word was deleted meanwhile.
  while (s.index < s.queue.length && !state.words.has(s.queue[s.index])) s.queue.splice(s.index, 1);
  if (s.index >= s.queue.length) {
    box.replaceChildren(finishedView(s));
    return;
  }
  box.replaceChildren(...cardView(state.words.get(s.queue[s.index]), s));
}

function emptyState() {
  return h('div', { class: 'empty' },
    h('h2', {}, 'Start by saving a few words'),
    h('ol', { class: 'steps' },
      h('li', {}, 'On any web page, hold ', h('kbd', {}, keyLabel()), ' and point at a word.'),
      h('li', {}, 'Click ', h('strong', {}, '+ Add to my words'), ' in the popup.'),
      h('li', {}, 'Come back here to review them. Saved words are highlighted on every page you read.')),
    h('p', { class: 'sub' }, 'You can also type words in on the My words tab.'));
}

function finishedView(s) {
  const due = dueCount();
  const box = h('div', { class: 'done' });
  box.append(h('h2', {}, s.reviewed ? `Session done: ${plural(s.reviewed, 'card')} reviewed` : 'All caught up'));
  if (due) {
    box.append(
      h('p', { class: 'sub' }, `${plural(due, 'word')} ${due === 1 ? 'is' : 'are'} due now.`),
      h('button', { class: 'btn primary', type: 'button', onclick: () => { startSession(false); renderSession(); } }, `Review ${due} now`));
  } else {
    box.append(
      h('p', { class: 'sub' }, nextDueText() || 'Nothing is scheduled.'),
      h('button', { class: 'btn', type: 'button', onclick: () => { startSession(true); renderSession(); } },
        scoped().length === 1 ? 'Practice your word' : `Practice your ${Math.min(10, scoped().length)} weakest words`),
      h('p', { class: 'sub small' }, 'Practice doesn’t move your schedule forward. Words you don’t know go back to the start.'));
  }
  return box;
}

function cardDirection(entry, s) {
  return s.direction === 'meaning' && (entry.translation || firstDef(entry)) ? 'meaning' : 'word';
}

function cardView(entry, s) {
  const level = Wover.levelOf(entry);
  const dir = cardDirection(entry, s);
  const done = Math.min(s.index, s.queue.length);
  const progress = h('div', { class: 'progress' },
    h('span', {}, s.practice ? `Practice · ${done + 1} of ${s.queue.length}` : `${done + 1} of ${s.queue.length}`),
    h('div', { class: 'meter', role: 'progressbar', 'aria-label': 'Session progress', 'aria-valuemin': '0', 'aria-valuemax': String(s.queue.length), 'aria-valuenow': String(done) },
      h('span', { style: `width: ${(done / s.queue.length) * 100}%` })));

  const front = h('div', { class: 'face front' },
    h('div', { class: 'chips' }, chip(level),
      showLanguages() ? h('span', { class: 'chip' }, Wover.langName(langOfEntry(entry))) : null),
    ...(dir === 'word' ? wordFace(entry, level) : meaningFace(entry, level, true)));
  const parts = [progress, front];
  if (s.revealed) {
    parts.push(h('div', { class: 'face answer' },
      ...(dir === 'word' ? meaningFace(entry, level, false) : wordFace(entry, level))));
  }
  parts.push(rateButtons(entry, s));
  return parts;
}

function wordFace(entry, level) {
  return [
    h('div', { class: 'prompt', lang: entry.lang }, entry.word),
    h('div', { class: 'say' }, entry.phonetic ? h('span', { class: 'ipa' }, entry.phonetic) : null, speakerButton(entry)),
    entry.context && entry.context.sentence
      ? h('blockquote', { class: 'context' }, markWord(entry.context.sentence, entry.word, level)) : null,
  ];
}

function meaningFace(entry, level, asPrompt) {
  const hide = (text) => (asPrompt ? markWord(text, entry.word, level, true) : text);
  const out = [];
  if (entry.translation) {
    out.push(h('div', { class: asPrompt ? 'prompt translation' : 'translation', dir: 'auto', lang: entry.trLang || state.settings.targetLang }, entry.translation, trNote(entry)));
  }
  if (entry.alternatives && entry.alternatives.length) {
    out.push(h('div', { class: 'alts', dir: 'auto' }, entry.alternatives.slice(0, 4).join(' · ')));
  }
  const meanings = (entry.meanings || []).filter((m) => m.defs && m.defs.length);
  if (meanings.length) {
    out.push(h('div', { class: 'defs' }, meanings.map((m) => h('div', { class: 'def' },
      m.pos ? h('span', { class: 'pos' }, m.pos) : null,
      h('ol', {}, m.defs.map((d) => h('li', {}, hide(d.text), d.example ? h('span', { class: 'example' }, '“', hide(d.example), '”') : null)))))));
  }
  if (asPrompt && entry.context && entry.context.sentence) {
    out.push(h('blockquote', { class: 'context' }, markWord(entry.context.sentence, entry.word, level, true)));
  }
  if (entry.note) out.push(h('div', { class: 'note' }, entry.note));
  if (!asPrompt && entry.context && safeUrl(entry.context.url)) {
    out.push(h('div', { class: 'source' }, 'Saved from ',
      h('a', { href: entry.context.url, target: '_blank', rel: 'noopener noreferrer' }, entry.context.title || hostOf(entry.context.url))));
  }
  return out;
}

function rateButtons(entry, s) {
  if (!s.revealed) {
    return h('div', { class: 'actions' },
      h('button', { class: 'btn primary big', type: 'button', onclick: reveal }, 'Show answer', h('kbd', {}, 'Space')));
  }
  if (s.practice) {
    return h('div', { class: 'actions rates two' },
      h('button', { class: 'btn rate', type: 'button', onclick: () => rate(1) }, h('span', { class: 'rate-label' }, 'Didn’t know'), h('kbd', {}, '1')),
      h('button', { class: 'btn rate primary', type: 'button', onclick: () => rate(3) }, h('span', { class: 'rate-label' }, 'Knew it'), h('kbd', {}, '2')));
  }
  const now = Date.now();
  return h('div', { class: 'actions rates' }, ['Again', 'Hard', 'Good', 'Easy'].map((label, i) => {
    const next = Wover.schedule(entry, i + 1, now);
    return h('button', { class: `btn rate${i === 2 ? ' primary' : ''}`, type: 'button', onclick: () => rate(i + 1) },
      h('span', { class: 'rate-label' }, label),
      h('span', { class: 'rate-when' }, Wover.formatDuration(next.due - now)),
      h('kbd', {}, String(i + 1)));
  }));
}

function currentEntry() {
  const s = state.session;
  return s && s.index < s.queue.length ? state.words.get(s.queue[s.index]) : null;
}

function maybeAutoPlay() {
  const s = state.session;
  const entry = currentEntry();
  if (!entry || !state.settings.autoPlay) return;
  const wordShowing = cardDirection(entry, s) === 'word' ? !s.revealed : s.revealed;
  if (wordShowing) play(entry);
}

function reveal() {
  const s = state.session;
  if (!s || s.revealed || !currentEntry()) return;
  s.revealed = true;
  renderSession();
  maybeAutoPlay();
}

async function rate(rating) {
  const s = state.session;
  const entry = currentEntry();
  if (!entry || !s.revealed) return;
  const key = s.queue[s.index];
  const writes = {};
  // Practice only records forgetting; it never moves a word's schedule forward.
  if (!s.practice || rating === 1) {
    const next = { ...entry, ...Wover.schedule(entry, rating) };
    state.words.set(key, next);
    writes[key] = next;
  }
  if (rating === 1 && (s.again[key] || 0) < 2) {
    s.again[key] = (s.again[key] || 0) + 1;
    s.queue.push(key); // see it again before the session ends
  }
  s.reviewed++;
  s.index++;
  s.revealed = false;
  s.direction = pickDirection();
  const today = Wover.dayKey();
  const days = { ...(state.stats.days || {}) };
  days[today] = (days[today] || 0) + 1;
  const cutoff = Wover.dayKey(Date.now() - 400 * Wover.DAY);
  for (const day of Object.keys(days)) if (day < cutoff) delete days[day];
  state.stats = { ...state.stats, days };
  writes.stats = state.stats;
  renderReview();
  maybeAutoPlay();
  await browser.storage.local.set(writes);
}

function setUpKeys() {
  document.addEventListener('keydown', (e) => {
    if (state.tab !== 'review' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest && e.target.closest('input, textarea, select, button, a, [contenteditable]')) return;
    const s = state.session;
    const entry = currentEntry();
    if (!entry) return;
    if ((e.key === ' ' || e.key === 'Enter') && !s.revealed) {
      e.preventDefault();
      reveal();
    } else if (e.key === 'p' || e.key === 'P') {
      play(entry);
    } else if (s.revealed && /^[1-4]$/.test(e.key)) {
      const n = Number(e.key);
      if (s.practice) {
        if (n <= 2) rate(n === 1 ? 1 : 3);
      } else {
        rate(n);
      }
    }
  });
}

function setUpTooltip() {
  const tip = $('#tooltip');
  const show = (el) => {
    tip.replaceChildren(h('strong', {}, el.dataset.tip), el.dataset.tipLabel ? h('span', {}, el.dataset.tipLabel) : null);
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2))}px`;
    tip.style.top = `${r.top - t.height - 8 < 8 ? r.bottom + 8 : r.top - t.height - 8}px`;
  };
  const target = (e) => e.target.closest && e.target.closest('[data-tip]');
  document.addEventListener('pointerover', (e) => { const el = target(e); if (el) show(el); });
  document.addEventListener('pointerout', (e) => {
    const el = target(e);
    if (el && !el.contains(e.relatedTarget)) tip.hidden = true;
  });
  document.addEventListener('focusin', (e) => { const el = target(e); if (el) show(el); });
  document.addEventListener('focusout', () => { tip.hidden = true; });
  addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
}

/* ---------- word list ---------- */

function setUpWords() {
  $('#search').addEventListener('input', (e) => {
    state.filter.q = e.target.value.trim().toLowerCase();
    state.filter.limit = 60;
    renderWords();
  });
  $('#sort').addEventListener('change', (e) => {
    state.filter.sort = e.target.value;
    renderWords();
  });
  $('#more').addEventListener('click', () => {
    state.filter.limit += 100;
    renderWords();
  });
  $('#add-form').addEventListener('submit', addWord);
  $('#add-lang').addEventListener('change', (e) => { state.addLang = e.target.value; });
  $('#delete-list').addEventListener('click', deleteList);
}

const SORTERS = {
  recent: ([, a], [, b]) => (b.addedAt || 0) - (a.addedAt || 0),
  due: ([, a], [, b]) => (a.due || 0) - (b.due || 0),
  weak: ([, a], [, b]) => Wover.levelOf(a) - Wover.levelOf(b) || (b.lapses || 0) - (a.lapses || 0) || (a.due || 0) - (b.due || 0),
  alpha: ([, a], [, b]) => a.word.localeCompare(b.word),
};

function searchText(w) {
  return [w.word, w.translation, w.note, ...(w.alternatives || []), w.context && w.context.sentence]
    .filter(Boolean).join(' ').toLowerCase();
}

// fromStorage: a background refresh, which must not wipe a half-typed edit.
function renderWords(fromStorage = false) {
  if (fromStorage && state.editing && state.words.has(state.editing)) return;
  state.editing = null;
  const { q, level, sort, limit } = state.filter;
  const all = scoped();
  const matches = q ? all.filter(([, w]) => searchText(w).includes(q)) : all;
  const listName = state.list === 'all' ? '' : `${Wover.langName(state.list)} `;
  const counts = LEVELS.map(() => 0);
  for (const [, w] of matches) counts[Wover.levelOf(w)]++;

  const filterButton = (value, label, count, level) => h('button', {
    type: 'button', class: 'seg-btn', 'aria-pressed': String(state.filter.level === value),
    onclick: () => { state.filter.level = value; state.filter.limit = 60; renderWords(); },
  }, level === undefined ? null : h('span', { class: `dot l${level}` }), label, h('span', { class: 'seg-count' }, String(count)));
  $('#level-filter').replaceChildren(
    filterButton('all', 'All', matches.length),
    ...LEVELS.map((l, i) => filterButton(String(i), l.name, counts[i], i)));
  $('#sort').value = sort;

  const list = (level === 'all' ? matches : matches.filter(([, w]) => Wover.levelOf(w) === Number(level))).sort(SORTERS[sort]);
  $('#word-count').textContent = all.length
    ? `${list.length} ${listName}${list.length === 1 ? 'word' : 'words'}${list.length !== all.length ? ` of ${all.length}` : ''}` : '';
  const ul = $('#word-list');
  const languages = showLanguages();
  if (!all.length) {
    ul.replaceChildren(h('li', { class: 'empty-row' }, 'No words yet. Hold ', h('kbd', {}, keyLabel()),
      ' and point at a word on any web page, or type one above.'));
  } else if (!list.length) {
    ul.replaceChildren(h('li', { class: 'empty-row' }, 'No words match.'));
  } else {
    ul.replaceChildren(...list.slice(0, limit).map(([key, w]) => wordRow(key, w, languages)));
  }
  $('#more').hidden = list.length <= limit;

  const add = state.addLang || (state.list !== 'all' ? state.list
    : state.settings.sourceLang !== 'auto' ? Wover.normLang(state.settings.sourceLang)
    : listGroups().keys().next().value || 'en');
  $('#add-lang').replaceChildren(...languageOptions(add));
  $('#add-lang').value = add;
  const del = $('#delete-list');
  del.hidden = state.list === 'all' || listGroups().size < 2;
  del.textContent = `Delete all ${listName}words…`;
}

function iconButton(name, label, onclick) {
  return h('button', { class: 'icon', type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
}

function wordRow(key, w, showLanguage) {
  const level = Wover.levelOf(w);
  const now = Date.now();
  const def = firstDef(w);
  const ctx = w.context && w.context.sentence ? w.context : null;
  return h('li', { class: 'word-row', 'data-key': key },
    h('div', { class: 'row-main' },
      h('div', { class: 'row-head' },
        h('span', { class: `w hl${level}`, lang: w.lang }, w.word),
        w.phonetic ? h('span', { class: 'ipa' }, w.phonetic) : null,
        speakerButton(w),
        chip(level),
        showLanguage ? h('span', { class: 'chip' }, Wover.langName(langOfEntry(w))) : null,
        h('span', { class: 'due' }, isDue(w, now) ? 'due now' : `due in ${Wover.formatDuration(w.due - now)}`)),
      w.translation ? h('div', { class: 'row-tr', dir: 'auto' }, w.translation,
        w.alternatives && w.alternatives.length ? h('span', { class: 'alts' }, ` · ${w.alternatives.slice(0, 3).join(' · ')}`) : null,
        trNote(w)) : null,
      def ? h('div', { class: 'row-def' }, def.pos ? h('span', { class: 'pos' }, def.pos) : null, def.text) : null,
      ctx ? h('div', { class: 'row-ctx' }, '“', markWord(ctx.sentence, w.word, level), '”',
        safeUrl(ctx.url) ? [' · ', h('a', { href: ctx.url, target: '_blank', rel: 'noopener noreferrer' }, ctx.title || hostOf(ctx.url))] : null) : null,
      w.note ? h('div', { class: 'row-note' }, w.note) : null),
    h('div', { class: 'row-actions' },
      iconButton('edit', `Edit ${w.word}`, () => editWord(key)),
      level < 4 ? iconButton('check', `Mark ${w.word} as mastered`, () => markMastered(key)) : null,
      w.reviews ? iconButton('reset', `Reset progress for ${w.word}`, () => resetWord(key)) : null,
      iconButton('trash', `Delete ${w.word}`, () => deleteWord(key))));
}

function editWord(key) {
  const w = state.words.get(key);
  if (!w) return;
  const tr = h('input', { type: 'text', dir: 'auto', 'aria-label': 'Translation' });
  tr.value = w.translation || '';
  const note = h('textarea', { rows: '2', 'aria-label': 'Note', placeholder: 'A note, a mnemonic, your own example…' });
  note.value = w.note || '';
  const lang = h('select', { 'aria-label': 'Language' }, languageOptions(langOfEntry(w)));
  lang.value = langOfEntry(w);
  const close = () => { state.editing = null; renderWords(); };
  const save = async (e) => {
    e.preventDefault();
    const current = state.words.get(key);
    state.editing = null;
    if (current) {
      const next = { ...current, translation: tr.value.trim(), note: note.value.trim(), lang: lang.value };
      // A translation typed here is in the language you translate into now.
      if (next.translation !== (current.translation || '')) next.trLang = next.translation ? state.settings.targetLang : '';
      const target = Wover.keyOfEntry(next);
      if (target === key) {
        await browser.storage.local.set({ [key]: next });
      } else {
        // Moving the word to another language's list.
        await browser.storage.local.set({ [target]: mergeEntry(state.words.get(target), next) });
        await browser.storage.local.remove(key);
        toast(`Moved “${next.word}” to your ${Wover.langName(next.lang)} words.`);
      }
    }
    renderWords();
  };
  const row = h('li', { class: 'word-row editing' }, h('form', { class: 'edit', onsubmit: save },
    h('div', { class: 'row-head' }, h('span', { class: 'w' }, w.word)),
    h('label', { class: 'field' }, h('span', {}, 'Translation'), tr),
    h('label', { class: 'field' }, h('span', {}, 'Note'), note),
    h('label', { class: 'field' }, h('span', {}, 'Language list'), lang),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'submit' }, 'Save'),
      h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'))));
  const old = [...document.querySelectorAll('#word-list .word-row')].find((li) => li.dataset.key === key);
  if (!old) return;
  state.editing = key;
  old.replaceWith(row);
  tr.focus();
}

async function markMastered(key) {
  const w = state.words.get(key);
  if (!w) return;
  const now = Date.now();
  const interval = Math.max(30, w.interval || 0);
  await browser.storage.local.set({ [key]: {
    ...w, interval, reps: Math.max(3, w.reps || 0), reviews: Math.max(1, w.reviews || 0),
    due: now + interval * Wover.DAY, lastReviewed: now,
  } });
  toast(`Marked “${w.word}” as mastered.`, () => browser.storage.local.set({ [key]: w }));
}

async function resetWord(key) {
  const w = state.words.get(key);
  if (!w) return;
  await browser.storage.local.set({ [key]: {
    ...w, interval: 0, reps: 0, lapses: 0, reviews: 0, ease: 2.5, due: Date.now(), lastReviewed: 0,
  } });
  toast(`Reset progress for “${w.word}”.`, () => browser.storage.local.set({ [key]: w }));
}

async function deleteWord(key) {
  const w = state.words.get(key);
  if (!w) return;
  await browser.storage.local.remove(key);
  toast(`Deleted “${w.word}”.`, () => browser.storage.local.set({ [key]: w }));
}

async function addWord(e) {
  e.preventDefault();
  const input = $('#add-input');
  const status = $('#add-status');
  const text = Wover.cleanText(input.value);
  const lang = $('#add-lang').value || 'en';
  const listName = `${Wover.langName(lang)} words`;
  if (!text) return;
  if (state.words.has(Wover.keyOf(lang, text))) {
    status.textContent = `“${text}” is already in your ${listName}.`;
    return;
  }
  status.textContent = 'Looking up…';
  let res;
  try {
    res = await browser.runtime.sendMessage({ type: 'lookup', text, pageLang: '', lang });
  } catch (err) {
    res = null;
  }
  if (!res || !res.ok) {
    status.textContent = (res && res.error) || 'Could not look that up.';
    return;
  }
  const entry = Wover.entryFromLookup(res, null);
  const key = Wover.keyOfEntry(entry);
  if (state.words.has(key)) {
    status.textContent = `“${entry.word}” is already in your ${listName}.`;
    return;
  }
  await browser.storage.local.set({ [key]: entry });
  input.value = '';
  const found = res.meanings.length || (res.translation && res.translation.text);
  status.textContent = found ? `Added “${entry.word}” to your ${listName}.`
    : `Added “${entry.word}” to your ${listName}, but no definition or translation was found.`;
}

async function deleteList() {
  if (state.list === 'all') return;
  const keys = scoped().map(([k]) => k);
  const name = Wover.langName(state.list);
  if (!keys.length || !confirm(`Delete all ${plural(keys.length, `${name} word`)} and their review history? Your other lists stay.`)) return;
  await browser.storage.local.remove(keys);
  toast(`Deleted your ${name} words.`);
}

/* ---------- settings ---------- */

function setUpSettings() {
  const langs = [...Wover.LANGUAGES].sort((a, b) => a[1].localeCompare(b[1]));
  $('#s-targetLang').replaceChildren(h('option', { value: '' }, 'Choose a language…'),
    ...langs.map(([code, name]) => h('option', { value: code }, name)));
  $('#s-sourceLang').replaceChildren(h('option', { value: 'auto' }, 'Same as the page'),
    ...langs.map(([code, name]) => h('option', { value: code }, name)));
  fillSettingsForm();
  renderHighlightSettings();
  for (const el of document.querySelectorAll('[id^="s-"]')) {
    el.addEventListener('change', el.id === 's-targetLang' ? onTargetChange : saveSettings);
  }
  $('#export-json').addEventListener('click', exportJSON);
  $('#export-csv').addEventListener('click', exportCSV);
  $('#import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', readImportFile);
  $('#delete-all').addEventListener('click', deleteAll);
}

/* ---------- theme and colours ---------- */

function readTheme() {
  try {
    return localStorage.getItem('wover.theme') || 'system';
  } catch (err) {
    return 'system';
  }
}

function applyTheme(theme) {
  const choice = theme === 'light' || theme === 'dark' ? theme : 'system';
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  for (const b of document.querySelectorAll('[data-theme-choice]')) {
    b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
  }
  try {
    localStorage.setItem('wover.theme', choice);
  } catch (err) {
    // The stored setting still applies once loaded.
  }
}

function setUpThemeSwitch() {
  const icons = { system: 'monitor', light: 'sun', dark: 'moon' };
  for (const b of document.querySelectorAll('[data-theme-choice]')) {
    b.replaceChildren(icon(icons[b.dataset.themeChoice]));
    b.addEventListener('click', () => updateSettings({ theme: b.dataset.themeChoice }));
  }
}

// The colour scheme's level colours, used by chips, the level chart and highlighted words.
function applyScheme() {
  const colors = Wover.schemeColors(state.settings);
  const root = document.documentElement.style;
  colors.page.forEach((color, i) => root.setProperty(`--hl${i}`, color));
  colors.light.forEach((color, i) => root.setProperty(`--l${i}`, `light-dark(${color}, ${colors.dark[i]})`));
}

function renderHighlightSettings() {
  renderLevelChecks();
  renderSchemes();
  renderCustomColors();
  renderSamples();
}

function renderLevelChecks() {
  const s = state.settings;
  const colors = Wover.schemeColors(s);
  const box = $('#level-checks');
  box.disabled = !s.highlight;
  box.replaceChildren(h('legend', {}, 'Highlight these levels'), ...LEVELS.map((level, i) => {
    const check = h('input', { type: 'checkbox', checked: s.highlightLevels[i] });
    check.addEventListener('change', () => {
      const levels = [...state.settings.highlightLevels];
      levels[i] = check.checked;
      updateSettings({ highlightLevels: levels });
    });
    return h('label', {}, check, h('span', { class: 'swatch', style: `background-image: linear-gradient(${colors.page[i]}, ${colors.page[i]})` }), level.name,
      h('span', { class: 'sub small' }, ` · ${level.hint}`));
  }));
}

function renderSchemes() {
  const s = state.settings;
  const ids = [...Object.keys(Wover.SCHEMES), 'custom'];
  $('#schemes').replaceChildren(...ids.map((id) => {
    const preset = Wover.SCHEMES[id];
    const sample = preset
      ? preset.page.map(([hex, alpha]) => Wover.rgba(hex, alpha))
      : Wover.schemeColors({ colorScheme: 'custom', customColors: s.customColors || Wover.SCHEMES.amber.page.map(([color, alpha]) => ({ color, alpha })) }).page;
    return h('button', { type: 'button', class: 'scheme', 'aria-pressed': String(s.colorScheme === id), onclick: () => chooseScheme(id) },
      preset ? preset.name : 'Custom',
      h('span', { class: 'scheme-swatches', 'aria-hidden': 'true' }, sample.map((color) => h('span', { style: `background-image: linear-gradient(${color}, ${color})` }))));
  }));
  const active = Wover.SCHEMES[s.colorScheme];
  $('#scheme-note').textContent = active
    ? `${active.note}${s.colorScheme === 'amber' ? ' This is the default.' : ''}`
    : 'Your own colours. Pick a colour and a strength for each level; lower strength keeps text easier to read.';
}

function chooseScheme(id) {
  if (id === 'custom' && !state.settings.customColors) {
    // Start customising from the scheme in use.
    const from = Wover.SCHEMES[state.settings.colorScheme] || Wover.SCHEMES.amber;
    updateSettings({ colorScheme: 'custom', customColors: from.page.map(([color, alpha]) => ({ color, alpha })) });
  } else {
    updateSettings({ colorScheme: id });
  }
}

function renderCustomColors() {
  const s = state.settings;
  const box = $('#custom-colors');
  box.hidden = s.colorScheme !== 'custom' || !s.customColors;
  if (box.hidden) return;
  box.replaceChildren(...s.customColors.map((c, i) => {
    const color = h('input', { type: 'color', value: c.color, 'aria-label': `${LEVELS[i].name} colour` });
    const strength = h('input', { type: 'range', min: '5', max: '90', step: '1', value: String(Math.round(c.alpha * 100)), 'aria-label': `${LEVELS[i].name} strength` });
    const shown = h('output', {}, `${Math.round(c.alpha * 100)}%`);
    const update = () => {
      shown.textContent = `${strength.value}%`;
      setCustomColor(i, { color: color.value, alpha: Number(strength.value) / 100 });
    };
    color.addEventListener('input', update);
    strength.addEventListener('input', update);
    return h('div', { class: 'custom-row' }, h('span', {}, LEVELS[i].name), color, strength, shown);
  }), h('div', { class: 'row' },
    h('button', { class: 'btn ghost', type: 'button', onclick: () => updateSettings({ customColors: Wover.SCHEMES.amber.page.map(([color, alpha]) => ({ color, alpha })) }) }, 'Start again from Amber')));
}

// Live while dragging; saved shortly after the last change.
let customTimer = 0;
function setCustomColor(i, value) {
  const customColors = state.settings.customColors.map((c, j) => (j === i ? value : c));
  state.settings = { ...state.settings, customColors };
  applyScheme();
  renderLevelChecks();
  renderSchemes();
  renderSamples();
  clearTimeout(customTimer);
  customTimer = setTimeout(async () => {
    await browser.storage.local.set({ settings: state.settings });
    flashSaved();
  }, 250);
}

function renderSamples() {
  const s = state.settings;
  const colors = Wover.schemeColors(s);
  for (const id of ['#sample-light', '#sample-dark']) {
    $(id).replaceChildren(...LEVELS.map((level, i) => {
      const on = s.highlight && s.highlightLevels[i];
      return h('span', { class: on ? '' : 'off', style: on ? `background: ${colors.page[i]}` : '', title: on ? '' : 'Not highlighted' }, level.name);
    }));
  }
}

function fillSettingsForm() {
  for (const [name, value] of Object.entries(state.settings)) {
    const el = document.getElementById(`s-${name}`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!value;
    else if (Array.isArray(value)) el.value = value.join('\n');
    else el.value = value;
  }
  $('#s-targetLang').classList.toggle('attention', !state.settings.targetLang);
  $('#s-matchPageLang').disabled = !state.settings.highlight;
}

// Read the plain form fields (s-<setting>) and save.
function saveSettings() {
  const patch = {};
  for (const name of Object.keys(Wover.DEFAULT_SETTINGS)) {
    const el = document.getElementById(`s-${name}`);
    if (!el) continue;
    if (el.type === 'checkbox') patch[name] = el.checked;
    else if (name === 'disabledSites') patch[name] = parseSites(el.value);
    else patch[name] = el.value.trim();
  }
  return updateSettings(patch);
}

async function updateSettings(patch) {
  state.settings = Wover.normalizeSettings({ ...state.settings, ...patch });
  applyTheme(state.settings.theme);
  applyScheme();
  fillSettingsForm();
  renderHighlightSettings();
  renderTranslationStatus();
  await browser.storage.local.set({ settings: state.settings });
  flashSaved();
  renderBanners();
}

let savedTimer = 0;
function flashSaved() {
  const status = $('#settings-status');
  status.textContent = 'Saved';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { status.textContent = ''; }, 2000);
}

/* ---------- changing the translation language ---------- */

// Words whose translation isn't in `target` yet (words already in that language don't need one).
function staleTranslations(target) {
  return [...state.words.entries()].filter(([, w]) =>
    (w.trLang || '') !== target && Wover.normLang(w.lang) !== Wover.normLang(target));
}

function onTargetChange(e) {
  const next = e.target.value;
  const prev = state.settings.targetLang;
  if (next === prev) return;
  const stale = next ? staleTranslations(next) : [];
  if (!stale.length) {
    updateSettings({ targetLang: next });
    return;
  }
  openTranslateDialog(prev, next, stale);
}

// Ask whether existing words should be re-translated into the new language too.
function openTranslateDialog(prev, next, stale) {
  const dialog = $('#tr-dialog');
  const name = Wover.languageName(next);
  const groups = new Map();
  for (const [key, w] of stale) {
    const lang = langOfEntry(w);
    groups.set(lang, [...(groups.get(lang) || []), key]);
  }
  const onlyNew = h('input', { type: 'radio', name: 'tr-scope', value: 'new', checked: true });
  const existing = h('input', { type: 'radio', name: 'tr-scope', value: 'all' });
  const lists = [...groups].map(([lang, keys]) => {
    const check = h('input', { type: 'checkbox', checked: true });
    return { keys, check, label: h('label', { class: 'check' }, check, `${Wover.langName(lang)} · ${plural(keys.length, 'word')}`) };
  });
  const listBox = h('div', { class: 'dialog-lists' }, lists.map((l) => l.label));
  const sync = () => {
    listBox.hidden = !existing.checked || lists.length < 2;
  };
  onlyNew.addEventListener('change', sync);
  existing.addEventListener('change', sync);
  sync();

  dialog.replaceChildren(h('form', { method: 'dialog' },
    h('h2', { id: 'tr-dialog-title' }, `Translate into ${name}`),
    h('p', { class: 'sub' }, `${plural(stale.length, 'saved word')} ${stale.length === 1 ? 'isn’t' : 'aren’t'} translated into ${name} yet.`),
    h('label', { class: 'choice' }, onlyNew, h('span', {},
      h('strong', {}, 'Only new words'),
      h('small', {}, `Words you save from now on are translated into ${name}. Your saved words keep their current translation.`))),
    h('label', { class: 'choice' }, existing, h('span', {},
      h('strong', {}, 'New and saved words'),
      h('small', {}, `Also re-translate your saved words into ${name}. Their current translations are replaced; your notes stay.`))),
    listBox,
    h('div', { class: 'dialog-actions' },
      h('button', { class: 'btn', value: 'cancel' }, 'Cancel'),
      h('button', { class: 'btn primary', value: 'apply' }, `Switch to ${name}`))));
  dialog.returnValue = '';
  dialog.onclose = async () => {
    if (dialog.returnValue !== 'apply') {
      $('#s-targetLang').value = prev; // cancelled: keep the old language
      return;
    }
    await updateSettings({ targetLang: next });
    if (existing.checked) retranslate(lists.filter((l) => l.check.checked).flatMap((l) => l.keys));
  };
  dialog.showModal();
}

// Re-translate saved words one by one; words are saved in small batches as they're done.
async function retranslate(keys) {
  if (state.job && !state.job.finished) state.job.stopped = true;
  const target = state.settings.targetLang;
  const job = { target, total: keys.length, done: 0, updated: 0, failed: 0, error: '', stopped: false, finished: false };
  state.job = job;
  renderTranslationStatus();
  let batch = {};
  const save = async () => {
    if (!Object.keys(batch).length) return;
    const writes = batch;
    batch = {};
    await browser.storage.local.set(writes);
  };
  for (const key of keys) {
    if (job.stopped || state.settings.targetLang !== target) break;
    const w = state.words.get(key);
    if (w) {
      const r = await browser.runtime.sendMessage({ type: 'translate', text: w.word, lang: w.lang }).catch(() => null);
      const current = state.words.get(key);
      if (current && r && (r.ok || r.same)) {
        batch[key] = r.ok
          ? { ...current, translation: r.text, alternatives: (r.alts || []).flatMap((a) => a.terms).slice(0, 6), trLang: target }
          : { ...current, trLang: target };
        job.updated++;
      } else if (current) {
        job.failed++;
        job.error = (r && r.error) || 'Wover could not reach its background page.';
        if (/limit|quota/i.test(job.error)) job.stopped = true; // no point hammering an exhausted service
      }
    }
    job.done++;
    if (Object.keys(batch).length >= 10) await save();
    renderTranslationStatus();
  }
  await save();
  job.finished = true;
  renderTranslationStatus();
}

function renderTranslationStatus() {
  const box = $('#tr-status');
  const job = state.job;
  if (job && !job.finished) {
    box.replaceChildren(h('div', { class: 'job' },
      h('div', { class: 'job-row' },
        h('span', {}, `Translating your words into ${Wover.languageName(job.target)}: ${job.done} of ${job.total}`),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => { job.stopped = true; } }, 'Stop')),
      h('div', { class: 'meter', role: 'progressbar', 'aria-label': 'Translation progress', 'aria-valuemin': '0', 'aria-valuemax': String(job.total), 'aria-valuenow': String(job.done) },
        h('span', { style: `width: ${job.total ? (job.done / job.total) * 100 : 0}%` }))));
    return;
  }
  const parts = [];
  if (job) {
    const into = Wover.languageName(job.target);
    parts.push(job.failed
      ? h('p', { class: 'error' }, `Translated ${plural(job.updated, 'word')} into ${into}. ${plural(job.failed, 'word')} kept the old translation: ${job.error}`)
      : h('p', { class: 'ok' }, `Translated ${plural(job.updated, 'word')} into ${into}.`));
  }
  const target = state.settings.targetLang;
  const stale = target ? staleTranslations(target) : [];
  if (stale.length) {
    parts.push(h('p', { class: 'sub' },
      `${plural(stale.length, 'saved word')} ${stale.length === 1 ? 'isn’t' : 'aren’t'} translated into ${Wover.languageName(target)}. `,
      h('button', { class: 'link-btn', type: 'button', onclick: () => retranslate(stale.map(([k]) => k)) },
        stale.length === 1 ? 'Translate it now' : 'Translate them now')));
  }
  box.replaceChildren(...parts);
}

function parseSites(text) {
  return [...new Set(text.split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/[/:?#].*$/, '').replace(/^www\./, ''))
    .filter(Boolean))];
}

function renderSettingsInfo() {
  renderTranslationStatus();
  const last = state.meta.lastBackupAt || 0;
  const groups = listGroups();
  const lists = groups.size > 1 ? ` in ${groups.size} languages` : '';
  $('#backup-info').textContent = `${plural(state.words.size, 'saved word')}${lists}. `
    + (last ? `Last backup downloaded ${ago(last)}.` : 'No backup downloaded yet.')
    + ' A backup keeps all your lists, review history and settings in one file you can restore on any computer.';
  const scope = $('#csv-scope');
  const current = scope.value || state.list;
  scope.replaceChildren(h('option', { value: 'all' }, 'All languages'),
    ...[...groups.keys()].map((lang) => h('option', { value: lang }, Wover.langName(lang))));
  scope.value = current === 'all' || groups.has(current) ? current : 'all';
  scope.hidden = groups.size < 2;
}

/* ---------- backup & restore ---------- */

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportJSON() {
  const data = {
    app: 'wover', version: 1, exportedAt: new Date().toISOString(),
    settings: state.settings, stats: state.stats, words: [...state.words.values()],
  };
  download(`wover-backup-${Wover.dayKey()}.json`, JSON.stringify(data, null, 2), 'application/json');
  state.meta = { ...state.meta, lastBackupAt: Date.now() };
  await browser.storage.local.set({ meta: state.meta });
  const lists = listGroups().size;
  toast(`Downloaded a backup of ${plural(state.words.size, 'word')}${lists > 1 ? ` in ${lists} languages` : ''}.`);
}

function exportCSV() {
  const cell = (value) => {
    let s = String(value == null ? '' : value);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // keep spreadsheets from running it as a formula
    return /[",\r\n]/.test(s) || s.startsWith("'") ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const date = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : '');
  const scope = $('#csv-scope').value || 'all';
  const rows = [['word', 'language', 'translation', 'alternatives', 'part of speech', 'definition', 'example', 'context', 'source', 'level', 'added', 'next review', 'note']];
  const words = [...state.words.entries()].filter(([, w]) => scope === 'all' || langOfEntry(w) === scope);
  for (const [, w] of words.sort(SORTERS.alpha)) {
    const d = firstDef(w) || {};
    rows.push([w.word, Wover.langName(langOfEntry(w)), w.translation, (w.alternatives || []).join('; '), d.pos, d.text, d.example,
      w.context ? w.context.sentence : '', w.context ? w.context.url : '', LEVELS[Wover.levelOf(w)].name,
      date(w.addedAt), date(w.due), w.note]);
  }
  const name = scope === 'all' ? 'words' : `${Wover.langName(scope).toLowerCase().replace(/[^a-z]+/g, '-')}-words`;
  // The byte-order mark makes spreadsheet apps read the file as UTF-8.
  download(`wover-${name}-${Wover.dayKey()}.csv`, '\ufeff' + rows.map((r) => r.map(cell).join(',')).join('\r\n'), 'text/csv');
}

async function readImportFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const panel = $('#import-panel');
  const fail = (msg) => panel.replaceChildren(h('p', { class: 'error' }, msg));
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    fail('That file isn’t a Wover backup (it isn’t valid JSON).');
    return;
  }
  const raw = Array.isArray(data) ? data : data && Array.isArray(data.words) ? data.words : null;
  if (!raw) {
    fail('That file doesn’t look like a Wover backup.');
    return;
  }
  // Backups from before translations recorded their language: assume the backup's setting.
  const trDefault = data.settings && typeof data.settings.targetLang === 'string' ? data.settings.targetLang : state.settings.targetLang;
  const words = raw.map((entry) => sanitizeEntry(entry, trDefault)).filter(Boolean);
  if (!words.length) {
    fail('No words found in that file.');
    return;
  }
  const keys = new Set(words.map(Wover.keyOfEntry));
  const fresh = [...keys].filter((k) => !state.words.has(k)).length;
  const langs = [...new Set(words.map(langOfEntry))].map(Wover.langName);
  state.pendingImport = { words, settings: data.settings, stats: data.stats };
  panel.replaceChildren(h('div', { class: 'import-box' },
    h('p', {}, `“${file.name}” has ${plural(keys.size, 'word')} (${langs.join(', ')}): ${fresh} new, ${keys.size - fresh} already in your lists.`),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => applyImport('merge') }, 'Merge into my lists'),
      h('button', { class: 'btn', type: 'button', onclick: () => applyImport('replace') }, 'Replace all my words'),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => { state.pendingImport = null; panel.replaceChildren(); } }, 'Cancel')),
    h('p', { class: 'sub' }, 'Merge adds the backup’s words and keeps the more-practised copy of words you both have. '
      + 'Replace deletes all your current words, in every language, and restores the backup’s words, review history and settings.')));
}

function sanitizeEntry(raw, trDefault = '') {
  if (!raw || typeof raw !== 'object' || typeof raw.word !== 'string') return null;
  const word = Wover.cleanText(raw.word);
  if (!word) return null;
  const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : '');
  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const meanings = Array.isArray(raw.meanings) ? raw.meanings.slice(0, 4).map((m) => ({
    pos: str(m && m.pos, 40),
    defs: Array.isArray(m && m.defs)
      ? m.defs.slice(0, 3).map((d) => ({ text: str(d && d.text), example: str(d && d.example) })).filter((d) => d.text) : [],
  })).filter((m) => m.defs.length) : [];
  const c = raw.context;
  const context = c && typeof c === 'object' && typeof c.sentence === 'string'
    ? { sentence: str(c.sentence, 400), url: safeUrl(c.url) ? c.url.slice(0, 2000) : '', title: str(c.title, 200) } : null;
  const addedAt = num(raw.addedAt, Date.now());
  return Wover.newEntry({
    word,
    lang: Wover.normLang(str(raw.lang, 12)) || 'en',
    phonetic: str(raw.phonetic, 80),
    audio: /^https:\/\//.test(raw.audio || '') ? str(raw.audio, 500) : '',
    translation: str(raw.translation, 300),
    trLang: typeof raw.trLang === 'string' ? raw.trLang.slice(0, 12) : (raw.translation ? trDefault : ''),
    alternatives: Array.isArray(raw.alternatives) ? raw.alternatives.filter((a) => typeof a === 'string').slice(0, 8).map((a) => a.slice(0, 80)) : [],
    meanings,
    context,
    note: str(raw.note, 1000),
    source: str(raw.source, 40),
    due: num(raw.due, addedAt),
    interval: Math.max(0, num(raw.interval)),
    ease: Math.min(5, Math.max(1.3, num(raw.ease, 2.5))),
    reps: Math.max(0, num(raw.reps)),
    lapses: Math.max(0, num(raw.lapses)),
    reviews: Math.max(0, num(raw.reviews)),
    lastReviewed: num(raw.lastReviewed),
  }, addedAt);
}

function sanitizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return Wover.normalizeSettings(null);
  const picked = {};
  for (const [name, def] of Object.entries(Wover.DEFAULT_SETTINGS)) {
    const v = raw[name];
    if (name === 'disabledSites') {
      if (Array.isArray(v)) picked[name] = parseSites(v.filter((x) => typeof x === 'string').join('\n'));
    } else if (def === null || Array.isArray(def)) {
      if (v !== undefined) picked[name] = v; // checked by normalizeSettings
    } else if (typeof v === typeof def) {
      picked[name] = v;
    }
  }
  if (raw.highlightMastered === false) picked.highlightMastered = false;
  return Wover.normalizeSettings(picked);
}

function sanitizeStats(raw) {
  const days = {};
  if (raw && raw.days && typeof raw.days === 'object') {
    for (const [day, n] of Object.entries(raw.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(n) && n > 0) days[day] = Math.round(n);
    }
  }
  return { days };
}

// Keep the more-practised copy, filling gaps from the other one.
function mergeEntry(current, incoming) {
  if (!current) return incoming;
  const newer = (incoming.reviews || 0) > (current.reviews || 0)
    || ((incoming.reviews || 0) === (current.reviews || 0) && (incoming.lastReviewed || 0) > (current.lastReviewed || 0));
  const [winner, other] = newer ? [incoming, current] : [current, incoming];
  return {
    ...winner,
    translation: winner.translation || other.translation,
    note: winner.note || other.note,
    context: winner.context || other.context,
    meanings: winner.meanings && winner.meanings.length ? winner.meanings : other.meanings,
    addedAt: Math.min(winner.addedAt || Date.now(), other.addedAt || Date.now()),
  };
}

async function applyImport(mode) {
  const imp = state.pendingImport;
  if (!imp) return;
  if (mode === 'replace' && state.words.size
    && !confirm(`Replace your ${plural(state.words.size, 'word')} with the backup? Your current list will be deleted.`)) return;
  const writes = {};
  for (const w of imp.words) {
    const key = Wover.keyOfEntry(w);
    writes[key] = mergeEntry(writes[key] || (mode === 'merge' ? state.words.get(key) : null), w);
  }
  if (mode === 'replace') {
    if (imp.settings) writes.settings = sanitizeSettings(imp.settings);
    if (imp.stats) writes.stats = sanitizeStats(imp.stats);
    await browser.storage.local.remove([...state.words.keys()].filter((k) => !(k in writes)));
  } else if (imp.stats) {
    const days = { ...(state.stats.days || {}) };
    for (const [day, n] of Object.entries(sanitizeStats(imp.stats).days)) days[day] = Math.max(days[day] || 0, n);
    writes.stats = { ...state.stats, days };
  }
  await browser.storage.local.set(writes);
  state.pendingImport = null;
  if (writes.settings) {
    state.settings = writes.settings;
    applyTheme(state.settings.theme);
    applyScheme();
    fillSettingsForm();
    renderHighlightSettings();
  }
  state.session = null;
  $('#import-panel').replaceChildren(h('p', { class: 'ok' },
    `Restored ${plural(new Set(imp.words.map(Wover.keyOfEntry)).size, 'word')}.`));
}

async function deleteAll() {
  const n = state.words.size;
  if (!n) return;
  if (!confirm(`Delete all ${plural(n, 'saved word')} and their review history? Download a backup first if you might want them back.`)) return;
  await browser.storage.local.remove([...state.words.keys()]);
  state.session = null;
  toast(`Deleted ${plural(n, 'word')}.`);
}
