const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { Script } = require('node:vm');

const copyScript = new Script(readFileSync(join(__dirname, 'public', 'i18n.js'), 'utf8'));

function openPage(navigator, localStorage) {
  const document = { documentElement: {} };
  const window = {};
  copyScript.runInNewContext({ document, window, navigator, localStorage });
  return { copy: window.ResetwiseCopy, document };
}

test('selects the first supported browser language and falls back to English', () => {
  const emptyStorage = { getItem: () => null };
  const cases = [
    [{ languages: ['zh-Hant-HK', 'en-GB'] }, 'zh'],
    [{ languages: ['en-GB', 'zh-CN'] }, 'en'],
    [{ languages: ['fr-FR', 'ZH-hans'] }, 'zh'],
    [{ languages: [], language: 'zh-CN' }, 'zh'],
    [{ languages: ['fr-FR', 'ja-JP'] }, 'en'],
    [{}, 'en'],
  ];
  for (const [navigator, expected] of cases) {
    assert.equal(openPage(navigator, emptyStorage).copy.getLanguage(), expected);
  }
});

test('remembers either manual language and gives it priority over the browser', () => {
  const preferences = new Map([['resetwise.language', 'fr']]);
  const storage = {
    getItem: key => preferences.get(key),
    setItem: (key, value) => preferences.set(key, value),
  };
  const { copy, document } = openPage({ language: 'en-US' }, storage);
  assert.equal(copy.getLanguage(), 'en');
  copy.setLanguage('zh');
  copy.rememberLanguage();
  assert.equal(document.documentElement.lang, 'zh-CN');
  assert.equal(openPage({ language: 'en-US' }, storage).copy.getLanguage(), 'zh');

  copy.setLanguage('en');
  copy.rememberLanguage();
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(openPage({ language: 'zh-CN' }, storage).copy.getLanguage(), 'en');
});

test('language selection still works when storage is blocked', () => {
  const unavailableStorage = () => { throw new Error('Storage is blocked'); };
  const { copy } = openPage({ language: 'fr-FR' }, {
    getItem: unavailableStorage,
    setItem: unavailableStorage,
  });
  assert.equal(copy.getLanguage(), 'en');
  copy.setLanguage('zh');
  assert.doesNotThrow(() => copy.rememberLanguage());
  assert.equal(copy.getLanguage(), 'zh');
});
