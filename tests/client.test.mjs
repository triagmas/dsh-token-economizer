/**
 * Client bundle contract tests.
 *
 * Loads the shipped `client/index.js` through the same module-loader shim the
 * Harness uses, with a minimal React stand-in, and checks registration only: the
 * actual rendering is exercised in a browser, not here.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8')

function loadClient() {
  let registration = null
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  }
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        registration = { id, value: factory((name) => {
          assert.equal(name, 'react')
          return React
        }) }
      },
    },
  }
  new Function('window', source)(globalThis.window)
  return registration
}

test('client registers the expected plugin surface', () => {
  const registration = loadClient()
  assert.equal(registration.id, 'dsh-token-economizer')
  const plugin = registration.value
  assert.equal(plugin.name, 'dsh-token-economizer')
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  assert.equal(typeof plugin.apply, 'function')
})

test('client registers one settings section, its dictionaries, and its effects', () => {
  const plugin = loadClient().value
  const dictionaries = {}
  const effects = []
  let section = null
  const locale = {
    register(namespace, dict) {
      dictionaries[namespace] = dict
      return () => {}
    },
    bind(namespace) {
      return (key) => dictionaries[namespace]?.en?.[key] ?? key
    },
  }
  const ctx = {
    effect(fn) {
      effects.push(fn())
    },
    locale,
    slots: {
      inject(slot, register) {
        assert.equal(slot, 'settings.section')
        register()
      },
      register(definition, component) {
        section = { definition, component }
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  assert.equal(effects.length, 2)
  assert.ok(section, 'settings section registered')
  assert.equal(section.definition.id, 'token-economizer')
  assert.equal(section.definition.name, 'settings.section')
  assert.equal(section.definition.order, 36)
  assert.equal(section.definition.locale, 'tokenEconomizer')
  assert.equal(typeof section.component, 'function')
  assert.equal(typeof section.definition.label, 'function')
  assert.equal(section.definition.label(), 'Token economizer')
  const dict = dictionaries.tokenEconomizer
  assert.ok(dict, 'tokenEconomizer namespace registered')
  assert.deepEqual(Object.keys(dict).sort(), ['en', 'ru'])
  for (const language of ['en', 'ru']) {
    assert.ok(Object.keys(dict[language]).length > 100, `${language} has a substantial dictionary`)
    for (const key of ['nav', 'title', 'error.noSession', 'common.refresh']) {
      assert.equal(typeof dict[language][key], 'string', `${language}.${key}`)
    }
  }
})

test('English and Russian dictionaries have identical key sets', () => {
  const plugin = loadClient().value
  const dictionaries = {}
  plugin.apply({
    effect: (fn) => { fn() },
    locale: { register: (namespace, dict) => { dictionaries[namespace] = dict }, bind: () => () => '' },
    slots: { inject: () => {}, register: () => () => {} },
  })
  const { en, ru } = dictionaries.tokenEconomizer
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort())
  for (const key of Object.keys(en)) assert.equal(typeof ru[key], 'string', `ru.${key}`)
  // The separately shipped locale files carry UI metadata; the tab dictionaries live in the bundle.
  const shipped = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'))
  assert.equal(typeof shipped.meta.title, 'string')
})

test('client exposes the required five tabs in its source', () => {
  for (const tab of ['tabs.overview', 'tabs.skills', 'tabs.tools', 'tabs.loops', 'tabs.settings']) {
    assert.ok(source.includes(`'${tab}'`), `missing ${tab}`)
  }
  for (const endpoint of ['/status', '/skills', '/tools', '/loops', '/settings', '/skills/action', '/tools/action', '/loops/action']) {
    assert.ok(source.includes(endpoint), `missing API endpoint ${endpoint}`)
  }
})
