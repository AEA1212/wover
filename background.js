'use strict';

/* Background page: dictionary and translation lookups, audio, the toolbar badge, review reminders. */

const WIKI_HEADERS = { 'Api-User-Agent': 'Wover/1.0 (Firefox extension; word lookups)' };
const CACHE_MAX = 200;
const SCHEMA = 3;          // 2: words keyed by language, w:<lang>:<word>; 3: words know their translation's language
const cache = new Map();   // lookup results, oldest first
let index = null;          // saved word -> { language: memory level }, shared with content scripts
let googleBlockedUntil = 0; // skip Google for a while after it refuses a request
let currentAudio = null;
let wordsTimer = 0;
const parser = new DOMParser();

/* ---------- events ---------- */

browser.runtime.onMessage.addListener((msg) => {
  switch (msg && msg.type) {
    case 'lookup': return lookup(msg.text, msg.pageLang, msg.lang);
    case 'translate': return translateText(msg.text, msg.lang);
    case 'play': return play(msg.url);
    case 'index': return getIndex();
    case 'open-dashboard': return openDashboard(msg.hash);
    default: return undefined;
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let wordsChanged = false;
  for (const [key, { newValue, oldValue }] of Object.entries(changes)) {
    if (key === 'settings') {
      cache.clear();
      scheduleReview();
    }
    if (!key.startsWith('w:')) continue;
    wordsChanged = true;
    if (!index) continue;
    if (newValue) addToIndex(newValue);
    // Removing a key a word was moved away from must not forget the word.
    else if (oldValue && key === Wover.keyOfEntry(oldValue)) removeFromIndex(oldValue);
  }
  if (wordsChanged) {
    clearTimeout(wordsTimer);
    wordsTimer = setTimeout(() => {
      updateBadge();
      scheduleReview();
    }, 500);
  }
});

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  const { settings, meta } = await browser.storage.local.get(['settings', 'meta']);
  if (!settings) {
    const ui = Wover.baseLang(browser.i18n.getUILanguage());
    const match = ui === 'en' ? null : Wover.LANGUAGES.find(([code]) => Wover.baseLang(code) === ui);
    await browser.storage.local.set({ settings: { ...Wover.DEFAULT_SETTINGS, targetLang: match ? match[0] : '' } });
  }
  if (!meta) await browser.storage.local.set({ meta: { installedAt: Date.now(), lastBackupAt: 0, schema: SCHEMA } });
  await startUp();
  if (reason === 'install') openDashboard('#settings');
});

browser.runtime.onStartup.addListener(async () => {
  await startUp();
  const { reviewOnStartup } = await Wover.getSettings();
  if (reviewOnStartup && (await reviewStatus()).due) await openReview();
});
browser.action.onClicked.addListener(() => openDashboard());
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'badge') updateBadge();
  else if (alarm.name === 'review') remindToReview();
});

async function startUp() {
  await migrate();
  if (!(await browser.alarms.get('badge'))) browser.alarms.create('badge', { periodInMinutes: 15 });
  await browser.action.setBadgeBackgroundColor({ color: '#52514e' });
  if (browser.action.setBadgeTextColor) await browser.action.setBadgeTextColor({ color: '#ffffff' });
  await updateBadge();
  await scheduleReview();
}

// Version 1 keyed words by spelling alone (w:<word>); move them to w:<lang>:<word>.
// Version 2 didn't record the translation's language; it was the one set in Settings.
async function migrate() {
  const all = await browser.storage.local.get(null);
  if (all.meta && all.meta.schema >= SCHEMA) return;
  const target = (all.settings && all.settings.targetLang) || '';
  const writes = {};
  const stale = [];
  for (const [key, entry] of Object.entries(all)) {
    if (!key.startsWith('w:') || !entry || typeof entry.word !== 'string') continue;
    const fixed = { ...entry, lang: Wover.normLang(entry.lang) || 'en' };
    if (typeof fixed.trLang !== 'string') fixed.trLang = fixed.translation ? target : '';
    const want = Wover.keyOfEntry(fixed);
    if (want === key && fixed.lang === entry.lang && fixed.trLang === entry.trLang) continue;
    const existing = writes[want] || (want !== key ? all[want] : null);
    writes[want] = existing && (existing.reviews || 0) > (fixed.reviews || 0) ? existing : fixed;
    if (want !== key) stale.push(key);
  }
  writes.meta = { ...(all.meta || {}), schema: SCHEMA };
  await browser.storage.local.set(writes); // write the new keys before removing the old ones
  if (stale.length) await browser.storage.local.remove(stale);
  index = null;
}

async function updateBadge() {
  const now = Date.now();
  const byLang = new Map();
  for (const w of await Wover.getAllWords()) {
    if ((w.due || 0) > now) continue;
    const lang = Wover.normLang(w.lang);
    byLang.set(lang, (byLang.get(lang) || 0) + 1);
  }
  const due = [...byLang.values()].reduce((a, b) => a + b, 0);
  const split = byLang.size > 1 ? ` (${[...byLang].map(([lang, n]) => `${Wover.langName(lang)} ${n}`).join(', ')})` : '';
  await browser.action.setBadgeText({ text: due ? (due > 999 ? '999+' : String(due)) : '' });
  await browser.action.setTitle({ title: due ? `Wover: ${due} word${due === 1 ? '' : 's'} to review${split}` : 'Wover: my words' });
}

/* ---------- review reminders ---------- */

// When you last reviewed or Wover last checked for words to review, and how many are due.
async function reviewStatus() {
  const { meta } = await browser.storage.local.get('meta');
  const now = Date.now();
  let last = (meta && meta.reviewCheckedAt) || 0;
  let words = 0;
  let due = 0;
  for (const w of await Wover.getAllWords()) {
    last = Math.max(last, w.lastReviewed || 0);
    words++;
    if ((w.due || 0) <= now) due++;
  }
  return { last, words, due };
}

const reviewPeriod = (settings) => settings.reviewEvery * 60 * Wover.MINUTE;

// Settings' reviewRepeat: reviewEvery hours after you last reviewed (or Wover last checked),
// open the review if words are due. Reviewing puts the check off again.
async function scheduleReview() {
  const settings = await Wover.getSettings();
  const { last, words } = await reviewStatus();
  if (!settings.reviewRepeat || !words) {
    await browser.alarms.clear('review');
    return;
  }
  const when = Math.max(last + reviewPeriod(settings), Date.now() + Wover.MINUTE);
  browser.alarms.create('review', { when });
}

async function remindToReview() {
  const settings = await Wover.getSettings();
  const { last, due } = await reviewStatus();
  if (!settings.reviewRepeat || Date.now() - last < reviewPeriod(settings) - Wover.MINUTE) await scheduleReview();
  else if (due) await openReview();
  else await checkedForReview();
}

async function openReview() {
  await checkedForReview();
  await openDashboard('#review');
}

// Count the next reviewEvery minutes from now.
async function checkedForReview() {
  const { meta } = await browser.storage.local.get('meta');
  await browser.storage.local.set({ meta: { ...(meta || {}), reviewCheckedAt: Date.now() } });
  await scheduleReview();
}

async function getIndex() {
  if (!index) {
    index = {};
    for (const w of await Wover.getAllWords()) addToIndex(w);
  }
  return index;
}

function addToIndex(entry) {
  const word = entry.word.toLowerCase();
  index[word] = { ...(index[word] || {}), [Wover.normLang(entry.lang)]: Wover.levelOf(entry) };
}

function removeFromIndex(entry) {
  const word = entry.word.toLowerCase();
  const langs = { ...(index[word] || {}) };
  delete langs[Wover.normLang(entry.lang)];
  if (Object.keys(langs).length) index[word] = langs;
  else delete index[word];
}

async function openDashboard(hash = '') {
  const base = browser.runtime.getURL('dashboard.html');
  try {
    for (const view of browser.extension.getViews({ type: 'tab' })) {
      if (!view.location.href.startsWith(base) || !view.woverTab) continue;
      if (hash) view.location.hash = hash;
      await browser.tabs.update(view.woverTab.id, { active: true });
      await browser.windows.update(view.woverTab.windowId, { focused: true });
      return;
    }
  } catch (err) {
    // Fall through and open a new tab.
  }
  await browser.tabs.create({ url: base + hash });
}

async function play(url) {
  if (!/^https:\/\//.test(url || '')) return { ok: false };
  try {
    if (currentAudio) currentAudio.pause();
    currentAudio = new Audio(url);
    await currentAudio.play();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ---------- lookups ---------- */

// forcedLang: look the word up in this language only (a word list, or "also German" in the popup).
async function lookup(text, pageLang, forcedLang) {
  const query = Wover.cleanText(text);
  if (!query) return { ok: false, error: 'Nothing to look up here.' };
  const settings = await Wover.getSettings();
  const prefs = {
    forced: Wover.normLang(forcedLang),
    preferred: settings.sourceLang !== 'auto' ? Wover.normLang(settings.sourceLang) : '',
    page: Wover.normLang(pageLang),
  };
  const id = [query, prefs.forced, prefs.preferred, prefs.page, settings.targetLang, JSON.stringify(settings.accents), settings.translator].join('|');
  if (cache.has(id)) return cache.get(id);

  // Translate from the language the word is expected to be in, so German "Gift" becomes poison, not a present.
  const hint = prefs.forced || prefs.preferred || prefs.page;
  const translation = settings.targetLang ? translate(query, settings, hint) : Promise.resolve(null);
  // Without a hint, the translator's guess at the language helps pick the dictionary section.
  prefs.detected = hint ? Promise.resolve('') : translation.then((r) => Wover.normLang(r && r.src), () => '');
  const [dict] = await Promise.allSettled([lookUpDictionary(query, prefs, settings.accents), translation]);
  let [tr] = await Promise.allSettled([translation]);

  // The dictionary found the word in another language than the translation assumed: translate again from it.
  const assumed = hint || (await prefs.detected);
  const found = dict.status === 'fulfilled' && dict.value ? dict.value.lang : '';
  if (settings.targetLang && found && found !== assumed && sourceCode(found) !== 'auto') {
    [tr] = await Promise.allSettled([translate(query, settings, found)]);
  }

  const lang = prefs.forced || prefs.preferred || prefs.page || (await prefs.detected) || 'en';
  const result = { ok: true, query, word: query, lang, languages: [], meanings: [], phonetic: '', audio: '' };
  if (dict.status === 'fulfilled' && dict.value) Object.assign(result, dict.value);
  else result.dictError = dict.status === 'rejected' ? errorText(dict.reason) : `No ${Wover.langName(lang)} dictionary entry found.`;
  if (tr.status === 'fulfilled') result.translation = tr.value;
  else result.translationError = errorText(tr.reason);

  // Only cache complete answers, so a network hiccup is retried next time.
  if (dict.status === 'fulfilled' && tr.status === 'fulfilled') {
    cache.set(id, result);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  return result;
}

async function lookUpDictionary(query, prefs, accents) {
  const lower = query.toLowerCase();
  const titles = [...new Set([lower, query])];
  const wikitext = fetchWikitext(titles[0]);
  let pick = null;

  try {
    for (const title of titles) {
      const data = await fetchDefinitions(title);
      const found = data && await rankLanguage(data, prefs);
      if (found && (!pick || found.rank < pick.rank)) pick = { title, data, ...found };
      if (pick && pick.rank === 0) break;
    }
    // Not in Wiktionary as written: try base forms (cats → cat, tried → try).
    if (!pick && !/\s/.test(lower)) {
      for (const title of Wover.variants(lower).slice(1, 5)) {
        const data = await fetchDefinitions(title);
        const found = data && await rankLanguage(data, prefs);
        if (found) { pick = { title, data, ...found }; break; }
      }
    }
  } catch (err) {
    if ((prefs.forced || prefs.preferred || prefs.page || 'en') === 'en') return lookUpFreeDictionary(lower, accents);
    throw err;
  }
  if (!pick) return null;

  // Other languages that have this spelling, offered in the popup.
  const languages = usableLanguages(pick.data).filter((code) => code !== pick.code).slice(0, 5)
    .map((code) => ({ code: Wover.normLang(code), name: sectionName(pick.data[code], code) }));

  let parsed = parseEntries(pick.data[pick.code]);
  let headword = pick.title;
  let inflection = '';
  // A pure inflection ("plural of cat"): show the base word instead.
  if (parsed.formOnly && parsed.lemma.toLowerCase() !== headword.toLowerCase()) {
    const data = await fetchDefinitions(parsed.lemma).catch(() => null);
    if (data && data[pick.code]) {
      inflection = parsed.formText;
      headword = parsed.lemma;
      parsed = parseEntries(data[pick.code]);
    }
  }

  const source = headword === titles[0] ? await wikitext : await fetchWikitext(headword);
  const sound = parsePronunciation(source, parsed.language, pick.code, accents);
  return {
    word: headword,
    lang: Wover.normLang(pick.code),
    language: parsed.language,
    languages,
    meanings: parsed.meanings,
    lemma: parsed.lemma && parsed.lemma.toLowerCase() !== headword.toLowerCase() ? parsed.lemma : '',
    inflection,
    phonetic: sound.phonetic,
    audio: sound.audio,
    source: 'Wiktionary',
    url: `https://en.wiktionary.org/wiki/${encodeURIComponent(headword.replace(/ /g, '_'))}#${encodeURIComponent(parsed.language.replace(/ /g, '_'))}`,
  };
}

async function fetchDefinitions(title) {
  const url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const res = await fetchWithTimeout(url, { headers: WIKI_HEADERS });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Wiktionary answered ${res.status}.`);
  return res.json();
}

async function fetchWikitext(title) {
  try {
    const url = 'https://en.wiktionary.org/w/api.php?action=parse&format=json&formatversion=2'
      + `&prop=wikitext&redirects=1&page=${encodeURIComponent(title)}`;
    const res = await fetchWithTimeout(url, { headers: WIKI_HEADERS });
    if (!res.ok) return '';
    const data = await res.json();
    return (data.parse && data.parse.wikitext) || '';
  } catch (err) {
    return '';
  }
}

// Language sections with definitions. Translingual entries (symbols, ISO codes) only count
// when there is nothing else.
function usableLanguages(data) {
  const codes = Object.keys(data).filter((code) => Array.isArray(data[code]));
  const has = (code, real) => data[code].some((e) => e.definitions && e.definitions.length && (!real || e.language !== 'Translingual'));
  const real = codes.filter((code) => code !== 'other' && has(code, true));
  return real.length ? real : codes.filter((code) => has(code, false));
}

function sectionName(entries, code) {
  const entry = (entries || []).find((e) => e.language && e.language !== 'Translingual');
  return entry ? entry.language : Wover.langName(code);
}

// Which language section to show. rank 0: the forced, chosen or page language;
// 1: the translator's guess; 2: English; 3: whatever Wiktionary has.
async function rankLanguage(data, prefs) {
  const usable = usableLanguages(data);
  const find = (lang) => lang && usable.find((code) => Wover.normLang(code) === lang);
  if (prefs.forced) {
    const code = find(prefs.forced);
    return code ? { code, rank: 0 } : null;
  }
  const code = find(prefs.preferred) || find(prefs.page);
  if (code) return { code, rank: 0 };
  const guessed = find(await prefs.detected);
  if (guessed) return { code: guessed, rank: 1 };
  if (find('en')) return { code: find('en'), rank: 2 };
  return usable.length ? { code: usable[0], rank: 3 } : null;
}

function parseEntries(all) {
  // Wiktionary files Translingual entries (symbols, ISO codes) under English too.
  const own = (all || []).filter((e) => e.language !== 'Translingual');
  const entries = own.length ? own : all || [];
  const byPos = new Map();
  let lemma = '';
  let formText = '';
  let formOnly = true;
  for (const entry of entries) {
    for (const def of entry.definitions || []) {
      const { text, formOf } = cleanDefinition(def.definition || '');
      if (!text) continue;
      if (formOf) {
        if (!lemma) { lemma = formOf; formText = text; }
      } else {
        formOnly = false;
      }
      const rawExamples = def.parsedExamples ? def.parsedExamples.map((x) => x.example) : def.examples || [];
      const example = rawExamples.map(htmlToText).find(Boolean) || '';
      const pos = entry.partOfSpeech || '';
      if (!byPos.has(pos)) byPos.set(pos, []);
      const defs = byPos.get(pos);
      if (defs.length < 3) defs.push({ text: clip(text, 260), example: clip(example, 200) });
    }
  }
  return {
    meanings: [...byPos].slice(0, 4).map(([pos, defs]) => ({ pos, defs })),
    lemma,
    formText,
    formOnly: formOnly && !!lemma,
    language: (entries[0] && entries[0].language) || '',
  };
}

function cleanDefinition(html) {
  const body = parser.parseFromString(`<body>${html}`, 'text/html').body;
  const hasSubsenses = !!body.querySelector('ol, ul');
  body.querySelectorAll('ol, ul, dl, sup, style, link, .maintenance-line, .reference, .previewonly')
    .forEach((n) => n.remove());
  const text = tidy(body.textContent);
  // A heading like "Terms relating to animals." whose real senses follow as separate definitions.
  const heading = body.querySelector('.use-with-mention:not(.form-of-definition)');
  if (hasSubsenses && heading && tidy(heading.textContent) === text) return { text: '', formOf: '' };
  const link = body.querySelector('.form-of-definition-link');
  return { text, formOf: link ? tidy(link.textContent) : '' };
}

function htmlToText(html) {
  const body = parser.parseFromString(`<body>${html || ''}`, 'text/html').body;
  body.querySelectorAll('sup, style, link').forEach((n) => n.remove());
  return tidy(body.textContent);
}

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// The pattern of the regional recording you prefer for a language (Settings), or null for any.
function accentMatch(accents, lang) {
  const code = Wover.normLang(lang);
  const accent = (Wover.ACCENTS[code] || []).find((a) => a.id === (accents || {})[code]);
  return accent ? accent.match : null;
}

function languageSection(wikitext, language) {
  if (!wikitext || !language) return '';
  const name = language.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^==\\s*${name}\\s*==\\s*$`, 'm').exec(wikitext);
  if (!heading) return '';
  const rest = wikitext.slice(heading.index + heading[0].length);
  const next = rest.search(/^==[^=].*==\s*$/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function templateArgs(body) {
  const positional = [];
  const named = {};
  for (const part of body.split('|')) {
    const eq = part.indexOf('=');
    if (eq > 0 && /^\s*[a-z0-9]+\s*$/i.test(part.slice(0, eq))) named[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    else positional.push(part.trim());
  }
  return { positional, named };
}

// IPA and a recording from the {{IPA}} and {{audio}} templates of the word's language section.
function parsePronunciation(wikitext, language, code, accents) {
  const ipas = [];
  const audios = [];
  for (const line of languageSection(wikitext, language).split('\n')) {
    const lineAccent = [...line.matchAll(/\{\{\s*(?:a|accent)\s*\|([^{}]*)\}\}/g)].map((m) => m[1]).join(' ');
    for (const m of line.matchAll(/\{\{\s*IPA\s*\|([^{}]*)\}\}/g)) {
      const { positional, named } = templateArgs(m[1]);
      if (positional[0] !== code) continue;
      for (const value of positional.slice(1)) {
        if (/^[/[]/.test(value)) ipas.push({ value, tag: `${lineAccent} ${named.a || ''}` });
      }
    }
    for (const m of line.matchAll(/\{\{\s*audio\s*\|([^{}]*)\}\}/g)) {
      const { positional, named } = templateArgs(m[1]);
      if (positional[0] !== code || !positional[1]) continue;
      audios.push({ value: positional[1], tag: `${lineAccent} ${named.a || ''} ${positional[2] || ''} ${positional[1]}` });
    }
    // Spanish lists recordings inside its pronunciation template: {{es-pr|+<audio:Es-cielo.ogg<a:Latin America>>}}.
    for (const m of line.matchAll(/<audio:([^<>]+?)(?:<a:([^<>]*)>)?>/g)) {
      audios.push({ value: m[1].trim(), tag: `${lineAccent} ${m[2] || ''} ${m[1]}` });
    }
  }
  const prefer = accentMatch(accents, code);
  const pick = (list) => (prefer && list.find((x) => prefer.test(x.tag))) || list[0];
  const ipa = pick(ipas);
  const audio = pick(audios);
  return {
    phonetic: ipa ? ipa.value : '',
    audio: audio ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(audio.value.replace(/ /g, '_'))}` : '',
  };
}

// Used only when Wiktionary itself can't be reached.
async function lookUpFreeDictionary(word, accents) {
  const res = await fetchWithTimeout(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The dictionary answered ${res.status}.`);
  const entries = await res.json();
  const byPos = new Map();
  const audios = [];
  let phonetic = '';
  for (const entry of entries) {
    phonetic = phonetic || entry.phonetic || '';
    for (const p of entry.phonetics || []) {
      if (p.text && !phonetic) phonetic = p.text;
      if (p.audio) audios.push({ value: p.audio, tag: p.audio });
    }
    for (const m of entry.meanings || []) {
      if (!byPos.has(m.partOfSpeech)) byPos.set(m.partOfSpeech, []);
      const defs = byPos.get(m.partOfSpeech);
      for (const d of m.definitions || []) {
        if (defs.length < 3) defs.push({ text: clip(d.definition || '', 260), example: clip(d.example || '', 200) });
      }
    }
  }
  const prefer = accentMatch(accents, 'en');
  const audio = (prefer && audios.find((a) => prefer.test(a.tag))) || audios[0];
  const headword = (entries[0] && entries[0].word) || word;
  return {
    word: headword,
    lang: 'en',
    language: 'English',
    languages: [],
    meanings: [...byPos].slice(0, 4).map(([pos, defs]) => ({ pos, defs })),
    lemma: '',
    inflection: '',
    phonetic,
    audio: audio ? audio.value : '',
    source: 'Free Dictionary API',
    url: `https://en.wiktionary.org/wiki/${encodeURIComponent(headword)}#English`,
  };
}

/* ---------- translation ---------- */

async function translateText(text, lang) {
  const settings = await Wover.getSettings();
  if (!settings.targetLang) return { ok: false, error: 'Choose your language in Wover’s settings first.' };
  if (sourceCode(lang) !== 'auto' && Wover.normLang(lang) === Wover.normLang(settings.targetLang)) {
    return { ok: false, same: true, error: 'It’s already in the language you translate into.' };
  }
  try {
    const result = await translate(String(text || '').slice(0, 450), settings, lang);
    return result ? { ok: true, ...result } : { ok: false, error: 'No translation found.' };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

// The translators' code for a language, or 'auto' to let them guess.
function sourceCode(lang) {
  const known = lang && Wover.LANGUAGES.find(([code]) => Wover.normLang(code) === Wover.normLang(lang));
  return known ? known[0] : 'auto';
}

// sourceLang: the text's language when known; translators guess it otherwise.
async function translate(text, settings, sourceLang) {
  const target = settings.targetLang;
  const source = sourceCode(sourceLang);
  if (source !== 'auto' && Wover.normLang(source) === Wover.normLang(target)) return null;
  const providers = settings.translator === 'google' ? ['google']
    : settings.translator === 'mymemory' ? ['mymemory']
    : Date.now() < googleBlockedUntil ? ['mymemory'] : ['google', 'mymemory'];
  let lastError = null;
  for (const provider of providers) {
    try {
      const result = provider === 'google'
        ? await googleTranslate(text, source, target)
        : await myMemoryTranslate(text, source, target, settings.myMemoryEmail);
      if (result && result.text) return result;
    } catch (err) {
      lastError = err;
      if (provider === 'google' && settings.translator === 'auto') googleBlockedUntil = Date.now() + 15 * Wover.MINUTE;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function googleTranslate(text, source, target) {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dj=1&dt=t&dt=bd'
    + `&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(text)}`;
  const res = await fetchWithTimeout(url, {}, 4000); // short: MyMemory is the fallback
  if (!res.ok) throw new Error(`Google Translate answered ${res.status}.`);
  const data = await res.json();
  const main = (data.sentences || []).map((s) => s.trans || '').join('').trim();
  const alts = (data.dict || []).slice(0, 3)
    .map((d) => ({ pos: d.pos || '', terms: (d.terms || []).filter((t) => t !== main).slice(0, 5) }))
    .filter((a) => a.terms.length);
  return { text: main, alts, src: data.src || source, target, provider: 'Google Translate' };
}

async function myMemoryTranslate(text, source, target, email) {
  const pair = `${source === 'auto' ? 'autodetect' : source}|${target}`;
  let url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;
  if (email) url += `&de=${encodeURIComponent(email)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`MyMemory answered ${res.status}.`);
  const data = await res.json();
  const main = decodeEntities((data.responseData && data.responseData.translatedText) || '').trim();
  if (data.quotaFinished || /MYMEMORY WARNING/i.test(main)) {
    throw new Error('MyMemory’s free daily limit is used up. Adding your email in Settings raises it.');
  }
  if (Number(data.responseStatus) !== 200) throw new Error(decodeEntities(data.responseDetails || 'MyMemory could not translate this.'));
  const seen = new Set([main.toLowerCase(), text.toLowerCase()]);
  const terms = [];
  for (const m of data.matches || []) {
    const t = decodeEntities(m.translation || '').trim();
    if (!t || t.length > 60 || Number(m.match) < 0.5 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    terms.push(t);
    if (terms.length === 4) break;
  }
  return {
    text: main,
    alts: terms.length ? [{ pos: '', terms }] : [],
    src: (data.responseData && data.responseData.detectedLanguage) || source,
    target,
    provider: 'MyMemory',
  };
}

/* ---------- utilities ---------- */

async function fetchWithTimeout(url, options = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, credentials: 'omit', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return parser.parseFromString(`<body>${s}`, 'text/html').body.textContent;
}

function errorText(err) {
  if (!err) return 'Something went wrong.';
  if (err.name === 'AbortError') return 'The request timed out.';
  if (err.name === 'TypeError') return 'Network error. Check your connection.';
  return err.message || String(err);
}
