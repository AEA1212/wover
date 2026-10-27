<p align="center">
  <img src="icons/icon.svg" width="96" height="96" alt="Wover logo">
</p>

<h1 align="center">Wover</h1>

<p align="center">
  <b>Hold a key, point at a word, learn it.</b><br>
  A Firefox extension for learning vocabulary while you read.
</p>

<p align="center">
  <img alt="Firefox 142+" src="https://img.shields.io/badge/Firefox-142%2B-FF7139?logo=firefoxbrowser&logoColor=white">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-555555">
  <img alt="Status: prototype" src="https://img.shields.io/badge/status-prototype-orange">
</p>

<p align="center">
  <img src="docs/screenshots/popup.png" width="760" alt="The Wover popup over an article, showing a word's pronunciation, translation and definitions. Saved words in the article are highlighted.">
</p>

## ✨ Features

- 🔍 Hold <kbd>Ctrl</kbd> and point at a word to see its definition, pronunciation and translation (or press a key twice, or use your own shortcut)
- ➕ Save words with one click, together with the sentence you found them in
- 🖍️ Saved words are highlighted on every page, more strongly the less you know them
- 🔊 Pick the accent you hear for each language, like British English, Austrian German or Brazilian Portuguese
- 🧠 Review them with spaced-repetition flashcards, and have the review open when Firefox starts or after the days and hours you choose
- 🌍 Keep a separate list for each language
- 🎨 Pick a colour scheme and a light, dark or system theme
- 💾 Back up, restore and export your words
- 🔒 Your words stay in your browser

## 📸 Gallery

| Review | Word lists |
| --- | --- |
| <img src="docs/screenshots/review.png" alt="A flashcard with its translation, definitions, rating buttons and review stats."> | <img src="docs/screenshots/words.png" alt="The word list with English and German lists."> |

| Colour schemes | Dark mode |
| --- | --- |
| <img src="docs/screenshots/colors.png" alt="Highlighting settings with colour schemes and highlight levels."> | <img src="docs/screenshots/popup-dark.png" alt="The popup in dark mode."> |

## 📦 Installation

### Firefox Add-ons

<a href="https://addons.mozilla.org/en-US/firefox/addon/wover/"><img alt="Get Wover on Firefox Add-ons" src="https://img.shields.io/badge/Firefox_Add--ons-Get_Wover-FF7139?logo=firefoxbrowser&logoColor=white&style=for-the-badge"></a>

### From source

1. Download this repository (**Code → Download ZIP**, then unzip it) or run `git clone https://github.com/AEA1212/wover.git`.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and choose `manifest.json`.

⚠️ Firefox removes temporary add-ons when it restarts, so repeat step 3 after each restart.

## 🚀 How to use

1. Choose the language you want translations in (the settings open when you install Wover).
2. On any web page, hold <kbd>Ctrl</kbd> and point at a word. You can change the key, or press it twice, or set your own shortcut in **Settings → Looking up words**.
3. Click **+ Add to my … words**.
4. Click the Wover button in the toolbar to review your words.

⚠️ Wover can't run on Firefox's own pages, in Reader View or in the PDF viewer.

## 🔒 Privacy

Your words and settings are stored only in Firefox. When you look a word up, only that word (or a sentence you ask to translate) is sent to Wiktionary and to a translation service (Google Translate or MyMemory).