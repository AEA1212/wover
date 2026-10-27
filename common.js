'use strict';

/* Helpers shared by the background page, the content script and the dashboard. */
globalThis.Wover = (() => {
  const MINUTE = 60000;
  const DAY = 86400000;

  // Memory levels, weakest first. Their colours live in highlight.css and dashboard.css.
  const LEVELS = [
    { id: 0, name: 'New', hint: 'not reviewed yet' },
    { id: 1, name: 'Learning', hint: 'next review within 3 days' },
    { id: 2, name: 'Familiar', hint: 'next review in 3–9 days' },
    { id: 3, name: 'Known', hint: 'next review in 10–29 days' },
    { id: 4, name: 'Mastered', hint: 'next review in 30 days or more' },
  ];

  const DEFAULT_SETTINGS = {
    targetLang: '',          // language to translate into; chosen on first run
    sourceLang: 'auto',      // language of the words you read; 'auto' follows the page
    holdLookup: true,        // hold triggerKey and point at a word
    triggerKey: 'Control',   // Control | Alt | Shift
    doubleLookup: false,     // point at a word and press doubleKey twice
    doubleKey: 'Control',    // Control | Alt | Shift
    shortcutLookup: false,   // point at a word and press the shortcut
    shortcut: 'Alt+KeyW',    // modifiers and a KeyboardEvent.code, e.g. Ctrl+Shift+KeyL
    accents: { en: 'us' },   // preferred recording per language: an id from ACCENTS, or 'any'
    autoPlay: false,         // pronounce the word as soon as the popup opens
    highlight: true,         // mark saved words on web pages
    highlightLevels: [true, true, true, true, true], // which memory levels get marked
    colorScheme: 'amber',    // a key of SCHEMES, or 'custom'
    customColors: null,      // [{ color: '#rrggbb', alpha }] per level, for the custom scheme
    translator: 'auto',      // auto (Google, then MyMemory) | google | mymemory
    myMemoryEmail: '',       // raises MyMemory's free daily limit
    cardDirection: 'word',   // word | meaning | mixed
    reviewOnStartup: false,  // open the review when Firefox starts, if words are due
    reviewRepeat: false,     // open it again reviewEvery hours after the last review, if words are due
    reviewEvery: 24,         // hours
    disabledSites: [],       // hostnames where Wover stays off
    matchPageLang: true,     // highlight a word only on pages in its language, when the page says
    theme: 'system',         // dashboard and popup colours: system | light | dark
  };

  const MODIFIER_KEYS = ['Control', 'Alt', 'Shift'];
  const MAX_REVIEW_HOURS = 365 * 24;

  // Regional pronunciations you can prefer, for languages whose Wiktionary entries have several.
  // `match` finds them in the entry's accent labels (a=Austria) and recording names (De-at-Hund.ogg).
  const ACCENTS = {
    en: [
      { id: 'us', name: 'American', match: /\b(US|GA|GenAm|General American|American)\b/i },
      { id: 'uk', name: 'British', match: /\b(UK|RP|British|England|Southern England|London)\b/i },
      { id: 'au', name: 'Australian', match: /\b(AU|AuE|Australia|Australian)\b/i },
      { id: 'ca', name: 'Canadian', match: /\b(CA|Canada|Canadian|CanE)\b/i },
    ],
    de: [
      { id: 'de', name: 'Germany', match: /\b(Germany|Berlin)\b|(^|\s)De-(?!at-|ch-)/i },
      { id: 'at', name: 'Austria', match: /\b(Austria|Austrian|Vienna)\b|\bDe-at-/i },
      { id: 'ch', name: 'Switzerland', match: /\b(Switzerland|Swiss)\b|\bDe-ch-/i },
    ],
    es: [
      { id: 'es', name: 'Spain', match: /\b(Spain|Castilian|Madrid)\b/i },
      { id: 'latam', name: 'Latin America', match: /\b(Latin America|Mexico|Colombia|Argentina|Peru|Chile|Venezuela|Cuba|Uruguay|Ecuador|Bolivia|Caribbean|Central America)\b|\bam-lat\b/i },
    ],
    fr: [
      { id: 'fr', name: 'France', match: /\b(France|Paris|Parisian)\b/i },
      { id: 'ca', name: 'Canada', match: /\b(Canada|Canadian|Quebec|Québec|Montreal)\b/i },
    ],
    nl: [
      { id: 'nl', name: 'Netherlands', match: /\b(Netherlands|Holland|NL)\b/i },
      { id: 'be', name: 'Belgium', match: /\b(Belgium|Belgian|Flanders|Flemish|BE)\b/i },
    ],
    pt: [
      { id: 'br', name: 'Brazil', match: /\b(Brazil|Brazilian|BR|São Paulo|Rio de Janeiro)\b/i },
      { id: 'pt', name: 'Portugal', match: /\b(Portugal|European Portuguese|Lisbon|Porto)\b|\bPT\b(?!-br)/i },
    ],
  };

  // A lookup shortcut as written in settings, "Ctrl+Shift+KeyL": its modifiers and key code, or null
  // if it isn't one. It needs Ctrl, Alt or Meta, or a function key, so it can't fire while typing.
  function parseShortcut(text) {
    const parts = String(text || '').split('+');
    const code = parts.pop();
    if (!/^[A-Za-z0-9]+$/.test(code) || /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code)) return null;
    if (!parts.every((p) => ['Ctrl', 'Alt', 'Shift', 'Meta'].includes(p))) return null;
    const sc = { ctrl: parts.includes('Ctrl'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), meta: parts.includes('Meta'), code };
    return sc.ctrl || sc.alt || sc.meta || /^F\d{1,2}$/.test(code) ? sc : null;
  }

  const LANGUAGES = [
    ['af', 'Afrikaans'], ['sq', 'Albanian'], ['am', 'Amharic'], ['ar', 'Arabic'], ['hy', 'Armenian'],
    ['az', 'Azerbaijani'], ['eu', 'Basque'], ['be', 'Belarusian'], ['bn', 'Bengali'], ['bs', 'Bosnian'],
    ['bg', 'Bulgarian'], ['my', 'Burmese'], ['ca', 'Catalan'], ['zh-CN', 'Chinese (Simplified)'],
    ['zh-TW', 'Chinese (Traditional)'], ['hr', 'Croatian'], ['cs', 'Czech'], ['da', 'Danish'],
    ['nl', 'Dutch'], ['en', 'English'], ['eo', 'Esperanto'], ['et', 'Estonian'], ['tl', 'Filipino'],
    ['fi', 'Finnish'], ['fr', 'French'], ['gl', 'Galician'], ['ka', 'Georgian'], ['de', 'German'],
    ['el', 'Greek'], ['gu', 'Gujarati'], ['ha', 'Hausa'], ['he', 'Hebrew'], ['hi', 'Hindi'],
    ['hu', 'Hungarian'], ['is', 'Icelandic'], ['id', 'Indonesian'], ['ga', 'Irish'], ['it', 'Italian'],
    ['ja', 'Japanese'], ['kn', 'Kannada'], ['kk', 'Kazakh'], ['km', 'Khmer'], ['ko', 'Korean'],
    ['ku', 'Kurdish'], ['ky', 'Kyrgyz'], ['lo', 'Lao'], ['la', 'Latin'], ['lv', 'Latvian'],
    ['lt', 'Lithuanian'], ['mk', 'Macedonian'], ['ms', 'Malay'], ['ml', 'Malayalam'], ['mt', 'Maltese'],
    ['mr', 'Marathi'], ['mn', 'Mongolian'], ['ne', 'Nepali'], ['no', 'Norwegian'], ['ps', 'Pashto'],
    ['fa', 'Persian'], ['pl', 'Polish'], ['pt', 'Portuguese'], ['pa', 'Punjabi'], ['ro', 'Romanian'],
    ['ru', 'Russian'], ['sr', 'Serbian'], ['si', 'Sinhala'], ['sk', 'Slovak'], ['sl', 'Slovenian'],
    ['so', 'Somali'], ['es', 'Spanish'], ['sw', 'Swahili'], ['sv', 'Swedish'], ['ta', 'Tamil'],
    ['te', 'Telugu'], ['th', 'Thai'], ['tr', 'Turkish'], ['uk', 'Ukrainian'], ['ur', 'Urdu'],
    ['uz', 'Uzbek'], ['vi', 'Vietnamese'], ['cy', 'Welsh'], ['yi', 'Yiddish'], ['yo', 'Yoruba'],
    ['zu', 'Zulu'],
  ];

  // Level colours. `page`: how each level is highlighted on web pages (colour, opacity), translucent
  // so text stays readable on light and dark pages. `light`/`dark`: solid marks for the dashboard,
  // each set checked for colour-blind separation and contrast against the dashboard's surfaces.
  const SCHEMES = {
    amber: {
      name: 'Amber',
      note: 'One colour, stronger for words you know less. The easiest to read with colour blindness.',
      page: [['#f0a014', 0.62], ['#f0a014', 0.46], ['#f0a014', 0.32], ['#f0a014', 0.2], ['#f0a014', 0.1]],
      light: ['#923f00', '#ab5803', '#c47203', '#d98b03', '#e8a628'],
      dark: ['#fabb41', '#e89719', '#ce7702', '#b05a05', '#964101'],
    },
    ocean: {
      name: 'Ocean',
      note: 'One blue, stronger for words you know less. Close to the colour of selected text.',
      page: [['#3b82f6', 0.5], ['#3b82f6', 0.37], ['#3b82f6', 0.26], ['#3b82f6', 0.16], ['#3b82f6', 0.08]],
      light: ['#025894', '#1b70b3', '#4586cf', '#679ceb', '#84b6ff'],
      dark: ['#b0d0ff', '#80b3fe', '#5798e3', '#2e7fc3', '#1764a0'],
    },
    lavender: {
      name: 'Lavender',
      note: 'One violet, stronger for words you know less.',
      page: [['#8b5cf6', 0.5], ['#8b5cf6', 0.37], ['#8b5cf6', 0.26], ['#8b5cf6', 0.16], ['#8b5cf6', 0.08]],
      light: ['#594496', '#7057ba', '#8c6dd2', '#aa83ea', '#c1a0fb'],
      dark: ['#d6c2fe', '#bf9bfe', '#9e7fe6', '#7e66ca', '#634fa3'],
    },
    mint: {
      name: 'Mint',
      note: 'One green, stronger for words you know less.',
      page: [['#10b981', 0.55], ['#10b981', 0.41], ['#10b981', 0.29], ['#10b981', 0.18], ['#10b981', 0.09]],
      light: ['#016246', '#057c59', '#089772', '#29ad8d', '#57c3a4'],
      dark: ['#85e3c6', '#4fcaa8', '#33ac87', '#0a9068', '#0b7252'],
    },
    spectrum: {
      name: 'Spectrum',
      note: 'A different colour per level, from red for new words to blue for mastered ones.',
      page: [['#e34948', 0.42], ['#eda100', 0.42], ['#008300', 0.3], ['#1baf7a', 0.26], ['#2a78d6', 0.2]],
      light: ['#e34948', '#eda100', '#008300', '#1baf7a', '#2a78d6'],
      dark: ['#e66767', '#b88a00', '#008300', '#1baf7a', '#3987e5'],
    },
  };

  const isHex = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
  const validCustom = (list) => Array.isArray(list) && list.length === LEVELS.length
    && list.every((c) => c && isHex(c.color) && typeof c.alpha === 'number' && c.alpha >= 0.03 && c.alpha <= 1);

  function rgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${n >> 16} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
  }

  // The active scheme's colours: page highlights as CSS colours, and solid marks per theme.
  function schemeColors(settings) {
    if (settings.colorScheme === 'custom' && validCustom(settings.customColors)) {
      const custom = settings.customColors;
      return { page: custom.map((c) => rgba(c.color, c.alpha)), light: custom.map((c) => c.color), dark: custom.map((c) => c.color) };
    }
    const scheme = SCHEMES[settings.colorScheme] || SCHEMES.amber;
    return { page: scheme.page.map(([hex, alpha]) => rgba(hex, alpha)), light: scheme.light, dark: scheme.dark };
  }

  // Settings as stored, filled in and upgraded (older versions had a single "highlight mastered" switch).
  function normalizeSettings(raw) {
    const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    const levels = raw && raw.highlightLevels;
    s.highlightLevels = Array.isArray(levels) && levels.length === LEVELS.length
      ? levels.map(Boolean)
      : LEVELS.map((l) => l.id !== 4 || !raw || raw.highlightMastered !== false);
    delete s.highlightMastered;
    if (!SCHEMES[s.colorScheme] && s.colorScheme !== 'custom') s.colorScheme = 'amber';
    if (s.colorScheme === 'custom' && !validCustom(s.customColors)) s.colorScheme = 'amber';
    if (!validCustom(s.customColors)) s.customColors = null;
    if (!['system', 'light', 'dark'].includes(s.theme)) s.theme = 'system';
    for (const name of ['triggerKey', 'doubleKey']) {
      if (!MODIFIER_KEYS.includes(s[name])) s[name] = DEFAULT_SETTINGS[name];
    }
    if (!parseShortcut(s.shortcut)) s.shortcut = DEFAULT_SETTINGS.shortcut;
    const hours = Math.round(Number(s.reviewEvery));
    s.reviewEvery = hours >= 1 ? Math.min(hours, MAX_REVIEW_HOURS) : DEFAULT_SETTINGS.reviewEvery;
    // Older versions had one accent, for English.
    const accents = raw && raw.accents && typeof raw.accents === 'object' ? raw.accents
      : { en: raw && raw.accent ? raw.accent : DEFAULT_SETTINGS.accents.en };
    s.accents = { ...DEFAULT_SETTINGS.accents };
    for (const [lang, id] of Object.entries(accents)) {
      if (ACCENTS[lang] && (id === 'any' || ACCENTS[lang].some((a) => a.id === id))) s.accents[lang] = id;
    }
    delete s.accent;
    s.disabledSites = Array.isArray(s.disabledSites) ? s.disabledSites.filter((x) => typeof x === 'string') : [];
    return s;
  }

  const baseLang = (code) => String(code || '').toLowerCase().split(/[-_]/)[0];
  const languageName = (code) => (LANGUAGES.find(([c]) => c === code) || [])[1] || code;

  // Word lists are per language. Codes are compared by their main subtag, and a few
  // codes are folded into the one Wiktionary uses (Serbian, Croatian, Bosnian → sh).
  const LANG_ALIASES = { sr: 'sh', hr: 'sh', bs: 'sh', nb: 'no', nn: 'no', iw: 'he', in: 'id', ji: 'yi', fil: 'tl', jw: 'jv', mo: 'ro', cmn: 'zh' };
  function normLang(code) {
    const base = baseLang(code);
    return LANG_ALIASES[base] || base;
  }

  // Wiktionary's names where Intl's differ (Intl calls sh "Serbian (Latin)").
  const NAME_OVERRIDES = { sh: 'Serbo-Croatian', mul: 'Translingual', und: 'Unknown language' };
  let displayNames = null;
  try {
    displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
  } catch (err) {
    // Fall back to the built-in list below.
  }
  function langName(code) {
    if (!code) return 'Unknown language';
    if (NAME_OVERRIDES[code]) return NAME_OVERRIDES[code];
    try {
      const name = displayNames && displayNames.of(code);
      if (name && name !== code) return name;
    } catch (err) {
      // Not a code Intl knows.
    }
    return languageName(code);
  }

  // Storage key of a saved word: one entry per language and spelling.
  const keyOf = (lang, word) => `w:${normLang(lang) || 'en'}:${String(word || '').trim().toLowerCase()}`;
  const keyOfEntry = (entry) => keyOf(entry.lang, entry.word);

  // Trim whitespace and punctuation around a hovered or selected piece of text.
  function cleanText(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/^[^\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '')
      .slice(0, 80);
  }

  function newEntry(fields, now = Date.now()) {
    return {
      word: '', lang: 'en', phonetic: '', audio: '', translation: '', trLang: '', alternatives: [],
      meanings: [], context: null, note: '', source: '',
      addedAt: now, due: now, interval: 0, ease: 2.5, reps: 0, lapses: 0, reviews: 0, lastReviewed: 0,
      ...fields,
    };
  }

  // A saved word built from a background lookup result.
  function entryFromLookup(res, context) {
    const tr = res.translation;
    return newEntry({
      word: res.word,
      lang: normLang(res.lang) || 'en',
      phonetic: res.phonetic || '',
      audio: res.audio || '',
      translation: tr ? tr.text : '',
      trLang: tr && tr.text ? tr.target || '' : '', // the language the translation is in
      alternatives: tr ? tr.alts.flatMap((a) => a.terms).slice(0, 6) : [],
      meanings: (res.meanings || []).slice(0, 3).map((m) => ({ pos: m.pos, defs: m.defs.slice(0, 2) })),
      context: context || null,
      source: res.source || '',
    });
  }

  function levelOf(entry) {
    if (!entry || !entry.reviews) return 0;
    const days = entry.interval || 0;
    return days < 3 ? 1 : days < 10 ? 2 : days < 30 ? 3 : 4;
  }

  // Spaced repetition, a small SM-2 variant. rating: 1 again, 2 hard, 3 good, 4 easy.
  function schedule(entry, rating, now = Date.now()) {
    let ease = entry.ease || 2.5;
    let interval = entry.interval || 0; // days
    let reps = entry.reps || 0;         // successful reviews in a row
    let lapses = entry.lapses || 0;
    let due;
    if (rating === 1) {
      if (reps > 0) lapses++;
      reps = 0;
      interval = 0;
      ease = Math.max(1.3, ease - 0.2);
      due = now + 10 * MINUTE;
    } else {
      let hard, good, easy;
      if (reps === 0) {
        hard = 0.5; good = 1; easy = 4;
      } else {
        hard = Math.max(interval * 1.2, interval + 1);
        good = Math.max(reps === 1 ? 3 : interval * ease, hard + 1);
        easy = Math.max(good * 1.3, good + 1);
      }
      interval = Math.min(3650, rating === 2 ? hard : rating === 3 ? good : easy);
      if (interval >= 1) interval = Math.round(interval);
      if (rating === 2) ease = Math.max(1.3, ease - 0.15);
      if (rating === 4) ease += 0.15;
      reps++;
      due = now + interval * DAY;
    }
    return {
      ease: Math.round(ease * 100) / 100, interval, reps, lapses, due,
      reviews: (entry.reviews || 0) + 1, lastReviewed: now,
    };
  }

  function formatDuration(ms) {
    const minutes = ms / MINUTE;
    if (minutes < 60) return Math.max(1, Math.round(minutes)) + 'm';
    const hours = minutes / 60;
    if (hours < 24) return Math.round(hours) + 'h';
    const days = hours / 24;
    if (days < 30) return Math.round(days) + 'd';
    if (days < 365) return Number((days / 30).toFixed(days < 300 ? 1 : 0)) + 'mo';
    return Number((days / 365).toFixed(1)) + 'y';
  }

  // The word itself plus base forms it may be an English inflection of: cats → cat, tried → try.
  function variants(word) {
    const w = String(word || '').toLowerCase();
    const out = [w];
    const add = (v) => { if (v.length > 1 && !out.includes(v)) out.push(v); };
    if (/['’]s$/.test(w)) add(w.slice(0, -2));
    if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
    if (w.endsWith('es')) add(w.slice(0, -2));
    if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
    if (w.endsWith('ied')) add(w.slice(0, -3) + 'y');
    if (w.endsWith('ed')) {
      const stem = w.slice(0, -2);
      add(stem);
      add(w.slice(0, -1));
      if (/(.)\1$/.test(stem)) add(stem.slice(0, -1));
    }
    if (w.endsWith('ing')) {
      const stem = w.slice(0, -3);
      add(stem);
      add(stem + 'e');
      if (/(.)\1$/.test(stem)) add(stem.slice(0, -1));
    }
    return out;
  }

  function dayKey(ts = Date.now()) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function siteDisabled(hostname, list) {
    const host = String(hostname || '').toLowerCase();
    return (list || []).some((site) => host === site || host.endsWith('.' + site));
  }

  async function getSettings() {
    const { settings } = await browser.storage.local.get('settings');
    return normalizeSettings(settings);
  }

  async function getAllWords() {
    const all = await browser.storage.local.get(null);
    return Object.keys(all).filter((k) => k.startsWith('w:')).map((k) => all[k]);
  }

  // Build DOM without innerHTML: h('a', { href, onclick }, 'text', childNode, [more]).
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (name === 'class') el.className = value;
      else if (name === 'style') el.style.cssText = value;
      else if (name.startsWith('on')) el.addEventListener(name.slice(2), value);
      else el.setAttribute(name, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(typeof child === 'object' ? child : String(child));
    }
    return el;
  }

  const ICONS = {
    speaker: 'M11 5 6 9H3v6h3l5 4V5z M15.5 8.5a5 5 0 0 1 0 7 M18.5 5.5a9 9 0 0 1 0 13',
    list: 'M9 6h12 M9 12h12 M9 18h12 M4 6h.01 M4 12h.01 M4 18h.01',
    external: 'M14 4h6v6 M10 14 20 4 M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5',
    edit: 'M4 20h4L19 9l-4-4L4 16v4z M13.5 6.5l4 4',
    check: 'M20 6 9 17l-5-5',
    reset: 'M3 12a9 9 0 1 0 3-6.7 M3 4v5h5',
    trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 13h10l1-13 M9 7V4h6v3',
    monitor: 'M3 4h18v12H3z M8 20h8 M12 16v4',
    sun: 'M16 12a4 4 0 1 1-8 0a4 4 0 1 1 8 0z M12 2v2 M12 20v2 M4.93 4.93l1.41 1.41 M17.66 17.66l1.41 1.41 M2 12h2 M20 12h2 M6.34 17.66l-1.41 1.41 M19.07 4.93l-1.41 1.41',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  };

  function icon(name, size = 16) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name]);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }

  return {
    MINUTE, DAY, LEVELS, DEFAULT_SETTINGS, MODIFIER_KEYS, MAX_REVIEW_HOURS, ACCENTS, parseShortcut,
    LANGUAGES, SCHEMES, schemeColors, normalizeSettings, rgba,
    baseLang, normLang, langName, keyOf, keyOfEntry, languageName, cleanText, newEntry, entryFromLookup,
    levelOf, schedule, formatDuration,
    variants, dayKey, siteDisabled, getSettings, getAllWords, h, icon,
  };
})();
