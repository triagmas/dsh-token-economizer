import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Config,
  CONFIG_DEFAULTS,
  CONFIG_FIELD_RULES,
  resolveConfig,
} from '../lib/config/schema.js'

test('field rules, schema defaults and bounds stay in lockstep', () => {
  const keys = Object.keys(CONFIG_DEFAULTS).sort()
  assert.deepEqual(Object.keys(CONFIG_FIELD_RULES).sort(), keys)
  for (const key of keys) {
    const rule = CONFIG_FIELD_RULES[key]
    const schema = Config.dict[key]
    assert.ok(schema, `${key} is present in the schemastery schema`)
    assert.deepEqual(schema.meta?.default, CONFIG_DEFAULTS[key], `${key} default`)
    if (rule.type !== 'number') continue
    assert.equal(typeof rule.min, 'number', `${key} min`)
    assert.equal(typeof rule.max, 'number', `${key} max`)
    assert.equal(typeof rule.step, 'number', `${key} step`)
    assert.equal(schema.meta.min, rule.min, `${key} schema min`)
    assert.equal(schema.meta.max, rule.max, `${key} schema max`)
    assert.equal(schema.meta.step, rule.step, `${key} schema step`)
    assert.equal(resolveConfig({ [key]: rule.min - 1 })[key], rule.min, `${key} clamps low`)
    assert.equal(resolveConfig({ [key]: rule.max + 1 })[key], rule.max, `${key} clamps high`)
  }
})
