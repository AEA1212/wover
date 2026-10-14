'use strict';

/* Hold the trigger key and point at a word to look it up.
   Saved words are highlighted on the page, stronger for words you know less. */
(() => {
  // Tiny frames are usually ads or widgets.
  if (window !== window.top && (window.innerWidth < 200 || window.innerHeight < 80)) return;
  // UI left behind by an older copy of this script (after the extension is updated or reloaded).
  document.querySelectorAll('wover-popup, style[data-wover]').forEach((n) => n.remove());

  const { h, icon } = Wover;
  const WORD_CHAR = /[\p{L}\p{M}'’-]/u;
  const JOINER = /['’-]/;
  const MODIFIERS = { Control: 'ctrlKey', Alt: 'altKey', Shift: 'shiftKey' };

  let settings = Wover.normalizeSettings(null);
  let levels = new Map(); // lowercased saved word -> { language: memory level }
  let enabled = false;

  /* ---------- state from storage ---------- */

  Promise.all([Wover.getSettings(), browser.runtime.sendMessage({ type: 'index' })])
    .then(([stored, index]) => {
      settings = stored;
      levels = new Map(Object.entries(index || {}));
      apply();
    })
    .catch(() => {});

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let changed = false;
    for (const [key, { newValue, oldValue }] of Object.entries(changes)) {
      if (key === 'settings') {
        settings = Wover.normalizeSettings(newValue);
        changed = true;
      } else if (key.startsWith('w:')) {
        if (newValue) setLevel(newValue, Wover.levelOf(newValue));
        // Removing a key a word was moved away from must not forget the word.
        else if (oldValue && key === Wover.keyOfEntry(oldValue)) setLevel(oldValue, null);
        changed = true;
      }
    }
    if (changed) {
      apply();
      popup.refresh();
    }
  });

  function setLevel(entry, level) {
    const word = String(entry.word || '').toLowerCase();
    const langs = { ...(levels.get(word) || {}) };
    if (level === null) delete langs[Wover.normLang(entry.lang)];
    else langs[Wover.normLang(entry.lang)] = level;
    if (Object.keys(langs).length) levels.set(word, langs);
    else levels.delete(word);
  }

  // Language of the text inside an element, from the nearest lang attribute ('' if the page doesn't say).
  let langMemo = new WeakMap();
  function langOf(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return '';
    if (langMemo.has(el)) return langMemo.get(el);
    const attr = el.getAttribute('lang');
    const lang = attr !== null ? Wover.normLang(attr) : langOf(el.parentElement);
    langMemo.set(el, lang);
    return lang;
  }
  const langAt = (node) => langOf(node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node);

  // Highlight colours of the chosen scheme. highlight.css holds the default amber in case
  // a page refuses this style element.
  let colorStyle = null;
  function applyPageColors() {
    const css = Wover.schemeColors(settings).page
      .map((color, i) => `::highlight(wover-${i}) { background-color: ${color} !important; }`).join('\n');
    if (!colorStyle || !colorStyle.isConnected) {
      document.querySelectorAll('style[data-wover]').forEach((n) => n.remove());
      colorStyle = document.createElement('style');
      colorStyle.setAttribute('data-wover', '');
      document.documentElement.append(colorStyle);
    }
    if (colorStyle.textContent !== css) colorStyle.textContent = css;
  }

  function apply() {
    applyPageColors();
    enabled = !Wover.siteDisabled(location.hostname, settings.disabledSites);
    if (!enabled) popup.hide();
    highlighter.refresh();
  }

  /* ---------- key + pointer ---------- */

  const pointer = { x: -1, y: -1 };
  let comboPressed = false; // another key went down with the trigger, e.g. Ctrl+C
  let lookedUp = false;
  let holdTimer = 0;
  let moveTimer = 0;
  let lastHit = '';

  function onlyTriggerHeld(e) {
    const flag = MODIFIERS[settings.triggerKey];
    return !!e[flag] && ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'].every((f) => f === flag || !e[f]);
  }

  addEventListener('mousemove', (e) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (!enabled || comboPressed || e.buttons || !onlyTriggerHeld(e)) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(lookUpAtPointer, 80);
  }, { capture: true, passive: true });

  // The pointer is over a child frame or has left the page: don't look up a stale position.
  addEventListener('mouseover', (e) => {
    if (/^I?FRAME$/.test(e.target.nodeName)) pointer.x = -1;
  }, { capture: true, passive: true });
  document.documentElement.addEventListener('mouseleave', () => { pointer.x = -1; });

  addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      popup.hide();
      return;
    }
    if (!enabled) return;
    if (e.key === settings.triggerKey) {
      if (e.repeat) return;
      comboPressed = false;
      lookedUp = false;
      lastHit = '';
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => { if (!comboPressed) lookUpAtPointer(); }, 200);
    } else {
      comboPressed = true;
      clearTimeout(holdTimer);
      clearTimeout(moveTimer);
      // The key was held for a shortcut (Ctrl+F…), not a lookup: close what it opened.
      if (lookedUp && e[MODIFIERS[settings.triggerKey]]) popup.hide();
    }
  }, true);

  addEventListener('keyup', (e) => {
    if (e.key !== settings.triggerKey) return;
    clearTimeout(holdTimer);
    comboPressed = false;
    // A lone Alt press would otherwise toggle Firefox's menu bar.
    if (e.key === 'Alt' && lookedUp) e.preventDefault();
  }, true);

  function lookUpAtPointer() {
    if (pointer.x < 0 || popup.isUnder(pointer.x, pointer.y)) return;
    const hit = textAt(pointer.x, pointer.y);
    if (!hit) return;
    const id = `${hit.text}|${Math.round(hit.rect.left)}|${Math.round(hit.rect.top)}`;
    if (id === lastHit && popup.isOpen()) return;
    lastHit = id;
    lookedUp = true;
    lookUp(hit.text, hit.range, contextOf(hit), { pageLang: langAt(hit.node) });
  }

  // The word under the point, or the selection if the point is inside it (for phrases).
  function textAt(x, y) {
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const text = Wover.cleanText(sel.toString());
      if (text && text.length <= 60 && text.split(' ').length <= 5 && contains(range.getClientRects(), x, y, 3)) {
        return { text, range: range.cloneRange(), rect: range.getBoundingClientRect(), node: range.startContainer, offset: range.startOffset };
      }
    }
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos || !pos.offsetNode || pos.offsetNode.nodeType !== Node.TEXT_NODE) return null;
    const node = pos.offsetNode;
    const s = node.data;
    let start = pos.offset;
    let end = pos.offset;
    while (start > 0 && WORD_CHAR.test(s[start - 1])) start--;
    while (end < s.length && WORD_CHAR.test(s[end])) end++;
    while (start < end && JOINER.test(s[start])) start++;
    while (end > start && JOINER.test(s[end - 1])) end--;
    if (end === start || end - start > 40) return null;
    const text = s.slice(start, end);
    if (!/\p{L}/u.test(text)) return null;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    if (!contains(range.getClientRects(), x, y, 2)) return null;
    return { text, range, rect: range.getBoundingClientRect(), node, offset: start };
  }

  function contains(rects, x, y, pad) {
    for (const r of rects) {
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) return true;
    }
    return false;
  }

  // The sentence around the hovered word, saved with the word as a memory aid.
  function contextOf(hit) {
    if (!hit.node || hit.node.nodeType !== Node.TEXT_NODE) return '';
    const block = hit.node.parentElement && hit.node.parentElement.closest(
      'p, li, dd, dt, td, th, h1, h2, h3, h4, h5, h6, blockquote, figcaption, caption, pre, div, section, article, body');
    if (!block) return '';
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let text = '';
    let at = -1;
    for (let n = walker.nextNode(); n && text.length < 5000; n = walker.nextNode()) {
      if (n === hit.node) at = text.length + hit.offset;
      text += n.data;
    }
    if (at < 0) return '';
    const before = text.slice(0, at);
    const after = text.slice(at);
    const startMatch = before.match(/^[\s\S]*[.!?…。！？]\s+/);
    const start = startMatch ? startMatch[0].length : 0;
    const endMatch = after.match(/[.!?…。！？](?=\s|$)/);
    const end = endMatch ? at + endMatch.index + 1 : text.length;
    let sentence = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (sentence.length > 300) {
      const word = hit.text;
      const i = Math.max(0, sentence.indexOf(word));
      const from = Math.max(0, i - 140);
      sentence = (from ? '…' : '') + sentence.slice(from, from + 300).trim() + '…';
    }
    return sentence;
  }

  /* ---------- lookups ---------- */

  let seq = 0;

  // where: { pageLang } for the hovered text, plus { lang } to look the word up in one language only.
  async function lookUp(text, range, context, where) {
    const n = ++seq;
    popup.open(range, text);
    let res;
    try {
      res = await browser.runtime.sendMessage({ type: 'lookup', text, pageLang: where.pageLang, lang: where.lang || '' });
    } catch (err) {
      res = { ok: false, query: text, error: 'Wover could not reach its background page. Reload this tab and try again.' };
    }
    if (n !== seq || !popup.isOpen()) return;
    popup.show(res, context, where);
    if (res.ok && settings.autoPlay) pronounce(res);
  }

  async function pronounce(res) {
    let played = null;
    if (res.audio) played = await browser.runtime.sendMessage({ type: 'play', url: res.audio }).catch(() => null);
    if (played && played.ok) return;
    try {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(res.word);
      utterance.lang = res.lang || 'en';
      speechSynthesis.speak(utterance);
    } catch (err) {
      // No speech engine available.
    }
  }

  /* ---------- popup ---------- */

  const popup = (() => {
    let host = null;
    let card = null;
    let anchor = null; // Range of the looked-up word; the popup follows it on scroll
    let state = null;  // { res, context, where, sentence, removed }

    function build() {
      host = document.createElement('wover-popup');
      host.style.cssText = 'all: initial !important; position: fixed !important; top: 0 !important;'
        + ' left: 0 !important; z-index: 2147483647 !important;';
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = POPUP_CSS;
      card = h('div', { class: 'card', role: 'dialog', 'aria-label': 'Wover dictionary' });
      paint();
      root.append(style, card);
      document.documentElement.append(host);
    }

    function open(range, text) {
      if (!host || !host.isConnected) build();
      anchor = range;
      state = null;
      card.replaceChildren(
        h('header', { class: 'head' }, h('span', { class: 'word' }, text)),
        h('p', { class: 'muted pad' }, 'Looking up…'));
      place();
    }

    function show(res, context, where) {
      state = { res, context, where, sentence: null, removed: null };
      render();
    }

    function refresh() {
      if (state && isOpen()) render();
    }

    function hide() {
      seq++;
      if (host) host.remove();
      host = card = anchor = state = null;
    }

    const isOpen = () => !!host && host.isConnected;
    const isUnder = (x, y) => isOpen() && document.elementFromPoint(x, y) === host;

    // Theme (system, light or dark) and the colour scheme's level colours.
    function paint() {
      card.setAttribute('data-theme', settings.theme);
      const colors = Wover.schemeColors(settings);
      colors.light.forEach((light, i) => card.style.setProperty(`--l${i}`, `light-dark(${light}, ${colors.dark[i]})`));
    }

    function render() {
      paint();
      const scroller = card.querySelector('.body');
      const scrollTop = scroller ? scroller.scrollTop : 0;
      card.replaceChildren(...view());
      const body = card.querySelector('.body');
      if (body) body.scrollTop = scrollTop;
      place();
    }

    function view() {
      const { res, context, where } = state;
      if (!res.ok) {
        return [
          h('header', { class: 'head' }, h('span', { class: 'word' }, res.query || '')),
          h('p', { class: 'muted pad' }, res.error || 'Something went wrong.'),
        ];
      }
      const lang = Wover.normLang(res.lang);
      const listName = Wover.langName(lang);
      const level = (levels.get(res.word.toLowerCase()) || {})[lang];
      const saved = level !== undefined;
      const tr = res.translation;
      const again = (text, lang) => lookUp(text, anchor, context, { pageLang: where.pageLang, lang });

      const head = h('header', { class: 'head' },
        h('span', { class: 'word', lang: res.lang }, res.word),
        res.phonetic ? h('span', { class: 'ipa' }, res.phonetic) : null,
        h('button', { class: 'icon', type: 'button', title: 'Pronounce', 'aria-label': 'Pronounce', onclick: () => pronounce(res) }, icon('speaker')),
        saved ? h('span', { class: 'chip', title: Wover.LEVELS[level].hint },
          h('span', { class: `dot l${level}` }), Wover.LEVELS[level].name) : null);

      const body = h('div', { class: 'body' });
      if (res.languages && res.languages.length) {
        // The same spelling exists in other languages: let the reader switch.
        body.append(h('p', { class: 'muted small' }, `${listName} · also `,
          res.languages.map((l, i) => [i ? ', ' : '',
            h('button', { class: 'link', type: 'button', title: `Look it up as ${l.name}`, onclick: () => again(res.query, l.code) }, l.name)])));
      }
      if (res.inflection) {
        body.append(h('p', { class: 'muted small' }, `${res.query} → ${res.inflection}`));
      } else if (res.lemma) {
        body.append(h('p', { class: 'muted small' }, 'Also a form of ',
          h('button', { class: 'link', type: 'button', onclick: () => again(res.lemma, lang) }, res.lemma)));
      }

      if (tr && tr.text) {
        body.append(h('div', { class: 'tr' },
          h('div', { class: 'tr-main', dir: 'auto', lang: settings.targetLang }, tr.text),
          tr.alts.map((a) => h('div', { class: 'tr-alt', dir: 'auto' },
            a.pos ? h('span', { class: 'pos' }, a.pos) : null, a.terms.join(' · ')))));
      } else if (!settings.targetLang) {
        body.append(h('p', { class: 'muted small' },
          h('a', { href: '#', onclick: openSettings }, 'Choose your language'), ' to see translations.'));
      } else if (res.translationError) {
        body.append(h('p', { class: 'muted small' }, `Translation unavailable: ${res.translationError}`));
      }

      if (res.meanings.length) {
        for (const m of res.meanings) {
          body.append(h('section', { class: 'meaning' },
            m.pos ? h('h3', {}, m.pos) : null,
            h('ol', {}, m.defs.map((d) => h('li', {},
              h('span', {}, d.text),
              d.example ? h('span', { class: 'example' }, `“${d.example}”`) : null)))));
        }
      } else {
        body.append(h('p', { class: 'muted small' }, res.dictError || 'No dictionary entry found.'));
      }
      if (state.sentence) {
        body.append(h('div', { class: 'sentence' },
          h('div', { class: 'muted small' }, `“${context}”`),
          h('div', { dir: 'auto', lang: settings.targetLang }, state.sentence)));
      } else if (context && settings.targetLang) {
        body.append(h('button', { class: 'link sentence-link', type: 'button', onclick: translateSentence },
          'Translate the whole sentence'));
      }

      let main;
      if (state.removed) {
        main = h('button', { class: 'btn', type: 'button', onclick: undoRemove }, 'Removed. Undo');
      } else if (saved) {
        main = h('button', { class: 'btn', type: 'button', onclick: remove }, `Remove from my ${listName} words`);
      } else {
        main = h('button', { class: 'btn primary', type: 'button', onclick: add }, `+ Add to my ${listName} words`);
      }
      const footer = h('footer', {},
        main,
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon', type: 'button', title: 'My words', 'aria-label': 'Open my words', onclick: () => openDashboard('') }, icon('list')),
        res.url ? h('a', { class: 'icon', href: res.url, target: '_blank', rel: 'noopener noreferrer', title: `Open in ${res.source || 'the dictionary'}`, 'aria-label': 'Open the full dictionary entry' }, icon('external')) : null);

      return [head, body, footer];
    }

    async function add() {
      const { res, context } = state;
      const found = context ? { sentence: context, url: location.href, title: document.title } : null;
      const entry = Wover.entryFromLookup(res, found);
      const key = Wover.keyOfEntry(entry);
      const existing = (await browser.storage.local.get(key))[key];
      if (existing) return;
      await browser.storage.local.set({ [key]: entry });
    }

    async function remove() {
      const key = Wover.keyOf(state.res.lang, state.res.word);
      const entry = (await browser.storage.local.get(key))[key];
      if (!entry) return;
      state.removed = entry;
      await browser.storage.local.remove(key);
    }

    async function undoRemove() {
      const entry = state.removed;
      state.removed = null;
      await browser.storage.local.set({ [Wover.keyOfEntry(entry)]: entry });
    }

    async function translateSentence() {
      const current = state;
      current.sentence = 'Translating…';
      render();
      const r = await browser.runtime.sendMessage({ type: 'translate', text: current.context, lang: current.res.lang })
        .catch(() => ({ ok: false, error: 'Wover could not reach its background page.' }));
      if (state !== current) return;
      current.sentence = r.ok ? r.text : `Could not translate: ${r.error}`;
      render();
    }

    function openSettings(e) {
      e.preventDefault();
      openDashboard('#settings');
    }

    function openDashboard(hash) {
      browser.runtime.sendMessage({ type: 'open-dashboard', hash }).catch(() => {});
    }

    function place() {
      if (!anchor || !card) return;
      const r = anchor.getBoundingClientRect();
      const vw = Math.min(innerWidth, document.documentElement.clientWidth || innerWidth);
      const vh = Math.min(innerHeight, document.documentElement.clientHeight || innerHeight);
      if (r.bottom < 0 || r.top > vh || (!r.width && !r.height)) {
        hide();
        return;
      }
      const margin = 8;
      const gap = 6;
      const w = card.offsetWidth;
      const ht = card.offsetHeight;
      const left = Math.max(margin, Math.min(r.left, vw - w - margin));
      let top = r.bottom + gap;
      if (top + ht > vh - margin) {
        top = r.top - gap - ht >= margin ? r.top - gap - ht : Math.max(margin, vh - margin - ht);
      }
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
    }

    addEventListener('mousedown', (e) => { if (isOpen() && e.target !== host) hide(); }, true);
    addEventListener('resize', () => hide(), { passive: true });
    let ticking = false;
    addEventListener('scroll', () => {
      if (!isOpen() || ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; place(); });
    }, { capture: true, passive: true });

    return { open, show, refresh, hide, isOpen, isUnder };
  })();

  /* ---------- highlighting saved words ---------- */

  const highlighter = (() => {
    const supported = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function';
    const NAMES = Wover.LEVELS.map((l) => `wover-${l.id}`);
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE', 'IFRAME', 'OBJECT', 'SELECT', 'OPTION']);
    const WORD = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu;
    let sets = [];
    let tracked = new Set();    // { range, level } for every highlighted word
    let byNode = new WeakMap(); // text node -> its tracked items
    let memo = new Map();       // language|token -> level or null
    let phrases = [];
    let observer = null;
    let pending = new Set();
    let flushTimer = 0;
    let rebuildTimer = 0;
    let flushes = 0;
    let active = false;

    function refresh() {
      if (!supported) return;
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(rebuild, 150);
    }

    function stop() {
      active = false;
      if (observer) observer.disconnect();
      observer = null;
      pending.clear();
      clearTimeout(flushTimer);
      flushTimer = 0;
      NAMES.forEach((name) => CSS.highlights.delete(name));
      sets = [];
      tracked = new Set();
      byNode = new WeakMap();
      memo = new Map();
      langMemo = new WeakMap();
    }

    function rebuild() {
      stop();
      if (!enabled || !settings.highlight || !levels.size || !document.body) return;
      sets = NAMES.map(() => new Highlight());
      NAMES.forEach((name, i) => CSS.highlights.set(name, sets[i]));
      phrases = [...levels.keys()].filter((w) => w.includes(' '));
      active = true;
      scan(document.body);
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    function onMutations(records) {
      for (const r of records) {
        if (r.type === 'characterData') pending.add(r.target);
        else r.addedNodes.forEach((n) => pending.add(n));
      }
      if (!flushTimer) flushTimer = setTimeout(flush, 300);
    }

    function flush() {
      flushTimer = 0;
      if (!active) return;
      const nodes = [...pending];
      pending.clear();
      for (const n of nodes) if (n.isConnected) scan(n);
      if (tracked.size > 500 || ++flushes % 10 === 0) prune();
    }

    // Forget highlights whose text was removed from the page.
    function prune() {
      for (const item of tracked) {
        if (item.range.collapsed || !item.range.startContainer.isConnected) {
          sets[item.level].delete(item.range);
          tracked.delete(item);
        }
      }
    }

    function scan(root) {
      if (root.nodeType === Node.TEXT_NODE) {
        if (!SKIP.has(root.parentNode && root.parentNode.nodeName)) mark(root);
        return;
      }
      if (root.nodeType !== Node.ELEMENT_NODE || SKIP.has(root.nodeName)) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!SKIP.has(n.parentNode.nodeName)) mark(n);
      }
    }

    function mark(node) {
      unmark(node);
      const text = node.data;
      if (text.length < 2 || text.length > 20000) return;
      const lang = langOf(node.parentElement);
      const items = [];
      WORD.lastIndex = 0;
      for (let m = WORD.exec(text); m; m = WORD.exec(text)) {
        const level = levelFor(m[0], lang);
        if (level !== null) items.push(add(node, m.index, m.index + m[0].length, level));
      }
      if (phrases.length) {
        const lower = text.toLowerCase();
        for (const phrase of phrases) {
          for (let i = lower.indexOf(phrase); i !== -1; i = lower.indexOf(phrase, i + phrase.length)) {
            const level = visible(pick(levels.get(phrase), lang, false));
            if (level !== null && boundary(lower, i - 1) && boundary(lower, i + phrase.length)) {
              items.push(add(node, i, i + phrase.length, level));
            }
          }
        }
      }
      if (items.length) byNode.set(node, items);
    }

    function unmark(node) {
      const items = byNode.get(node);
      if (!items) return;
      for (const item of items) {
        sets[item.level].delete(item.range);
        tracked.delete(item);
      }
      byNode.delete(node);
    }

    function add(node, start, end, level) {
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      sets[level].add(range);
      const item = { range, level };
      tracked.add(item);
      return item;
    }

    function levelFor(token, lang) {
      const lower = token.toLowerCase();
      const id = `${lang}|${lower}`;
      if (memo.has(id)) return memo.get(id);
      let level = pick(levels.get(lower), lang, false);
      if (level === null && lower.length > 3) {
        for (const v of Wover.variants(lower).slice(1)) {
          level = pick(levels.get(v), lang, true);
          if (level !== null) break;
        }
      }
      level = visible(level);
      memo.set(id, level);
      return level;
    }

    // The level to show for a saved spelling found in text of language `lang` ('' if unknown).
    // By default a word only counts on pages in its own language, so German "Gift" stays
    // unmarked in English text. Inflected forms (cats → cat) only apply to English words.
    function pick(langs, lang, inflected) {
      if (!langs) return null;
      if (inflected) {
        const ok = langs.en !== undefined && (!lang || lang === 'en' || !settings.matchPageLang);
        return ok ? langs.en : null;
      }
      if (lang && langs[lang] !== undefined) return langs[lang];
      if (lang && settings.matchPageLang) return null;
      const all = Object.values(langs);
      return all.length ? Math.min(...all) : null;
    }

    const visible = (level) => (level === null || !settings.highlightLevels[level] ? null : level);
    const boundary = (s, i) => i < 0 || i >= s.length || !/[\p{L}\p{M}]/u.test(s[i]);

    return { refresh };
  })();

  const POPUP_CSS = `
    :host { all: initial; }
    .card {
      color-scheme: light dark; /* "system": follows the OS; data-theme pins one */
      --bg: light-dark(#fcfcfb, #1f1f1d); --ink: light-dark(#0b0b0b, #f0efec);
      --ink-2: light-dark(#52514e, #c3c2b7); --muted: light-dark(#6f6e69, #9a998f);
      --line: light-dark(rgba(11, 11, 11, 0.1), rgba(255, 255, 255, 0.12));
      --hover: light-dark(rgba(11, 11, 11, 0.05), rgba(255, 255, 255, 0.07));
      --accent: light-dark(#0b0b0b, #f0efec); --accent-ink: light-dark(#fcfcfb, #1a1a19);
      --focus: light-dark(#2a78d6, #3987e5);
      position: fixed; top: 0; left: 0; box-sizing: border-box;
      width: 360px; max-width: calc(100vw - 16px); max-height: min(460px, calc(100vh - 16px));
      display: flex; flex-direction: column; overflow: hidden;
      background: var(--bg); color: var(--ink);
      border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 12px 32px light-dark(rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0.5)),
        0 2px 6px light-dark(rgba(0, 0, 0, 0.08), rgba(0, 0, 0, 0.25));
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      text-align: left; direction: ltr; cursor: auto;
    }
    .card[data-theme="light"] { color-scheme: light; }
    .card[data-theme="dark"] { color-scheme: dark; }
    * { box-sizing: border-box; }
    .head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; padding: 14px 16px 8px; }
    .word { font-size: 20px; font-weight: 650; line-height: 1.2; word-break: break-word; }
    .ipa { color: var(--ink-2); font-size: 14px; }
    .chip {
      margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
      padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px;
      font-size: 12px; color: var(--ink-2); white-space: nowrap;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .l0 { background: var(--l0); } .l1 { background: var(--l1); } .l2 { background: var(--l2); }
    .l3 { background: var(--l3); } .l4 { background: var(--l4); }
    .body {
      overflow: auto; padding: 0 16px 12px; min-height: 0;
      scrollbar-width: thin; scrollbar-color: var(--muted) transparent;
    }
    .pad { padding: 0 16px 14px; }
    .tr { padding: 2px 0 10px; border-bottom: 1px solid var(--line); margin-bottom: 4px; }
    .tr-main { font-size: 18px; font-weight: 600; line-height: 1.35; }
    .tr-alt { color: var(--ink-2); font-size: 13px; margin-top: 2px; }
    .pos { color: var(--muted); font-style: italic; margin-inline-end: 6px; }
    .meaning h3 {
      margin: 10px 0 2px; font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
      text-transform: uppercase; color: var(--muted);
    }
    ol { margin: 0; padding-left: 20px; }
    li { margin: 2px 0 6px; }
    li::marker { color: var(--muted); }
    .example { display: block; color: var(--ink-2); font-style: italic; margin-top: 2px; }
    .sentence { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); }
    .muted { color: var(--muted); }
    .small { font-size: 13px; margin: 6px 0; }
    p { margin: 0; }
    a { color: inherit; }
    footer {
      display: flex; align-items: center; gap: 6px; padding: 10px 12px 10px 16px;
      border-top: 1px solid var(--line);
    }
    .spacer { flex: 1; }
    button { font: inherit; color: inherit; }
    .btn {
      font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 8px; white-space: nowrap;
      border: 1px solid var(--line); background: transparent; color: var(--ink); cursor: pointer;
    }
    .btn:hover { background: var(--hover); }
    .btn.primary { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
    .btn.primary:hover { opacity: 0.88; }
    .btn.ghost { border-color: transparent; color: var(--ink-2); }
    .icon {
      display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0;
      border: 0; border-radius: 6px; background: transparent; color: var(--ink-2); cursor: pointer;
    }
    .icon:hover { background: var(--hover); color: var(--ink); }
    .link {
      display: inline; padding: 0; border: 0; background: none;
      color: var(--ink-2); text-decoration: underline; cursor: pointer; font-size: 13px;
    }
    .link:hover { color: var(--ink); }
    .sentence-link { display: block; margin-top: 10px; }
    :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  `;
})();
