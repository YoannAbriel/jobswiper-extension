/**
 * Pure-logic tests for autofill v2 (scoring, assignment, denylist).
 * Run: node --test test/autofill.test.js
 *
 * Only the DOM-free logic is covered here. The visibility gate, form-root
 * resolution, closed-shadow review panel, and file attach are DOM-bound and are
 * covered by the manual test steps in the PR description (no jsdom dependency in
 * this build-less extension).
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const autofill = require('../content/autofill.js')
const shared = require('../content/apply-shared.js')

const { normalize, scoreFieldForSignals, assignBestMatch, labelIsSensitive, FIELD_MAP } = autofill

function fieldByKey(key) {
  const f = FIELD_MAP.find((x) => x.key === key)
  assert.ok(f, `field ${key} exists in FIELD_MAP`)
  return f
}

// Score every field against one input's signals, return >= threshold candidates.
function candidatesFor(inputRef, sig) {
  const out = []
  for (const field of FIELD_MAP) {
    const score = scoreFieldForSignals(field, sig)
    if (score >= 45) out.push({ inputRef, fieldKey: field.key, score })
  }
  return out
}

test('normalize splits camelCase and strips diacritics', () => {
  assert.equal(normalize('firstName'), 'first name')
  assert.equal(normalize('first_name'), 'first name')
  assert.equal(normalize('Prénom'), 'prenom')
  assert.equal(normalize('Téléphone'), 'telephone')
  assert.equal(normalize('E-mail'), 'e mail')
})

test('autocomplete token is the strongest signal', () => {
  assert.equal(scoreFieldForSignals(fieldByKey('email'), { autocomplete: 'email' }), 100)
  assert.equal(scoreFieldForSignals(fieldByKey('first_name'), { autocomplete: 'given-name' }), 100)
  assert.equal(scoreFieldForSignals(fieldByKey('phone'), { autocomplete: 'tel' }), 100)
})

test('name attribute scores below autocomplete but above a weak label', () => {
  const s = scoreFieldForSignals(fieldByKey('first_name'), { name: 'firstName' })
  assert.ok(s >= 80, `expected >=80, got ${s}`)
})

test('two name inputs get distinct fields (no first-match collision)', () => {
  // input A labelled "First name", input B labelled generic "Name".
  const cands = [
    ...candidatesFor('A', { label: 'First name' }),
    ...candidatesFor('B', { label: 'Name' }),
  ]
  const assigned = assignBestMatch(cands)
  const byInput = Object.fromEntries(assigned.map((c) => [c.inputRef, c.fieldKey]))
  assert.equal(byInput['A'], 'first_name')
  assert.equal(byInput['B'], 'full_name')
})

test('assignment never reuses an input or a field', () => {
  const cands = [
    ...candidatesFor('A', { autocomplete: 'email', label: 'Email' }),
    ...candidatesFor('B', { autocomplete: 'email', label: 'Confirm email' }),
  ]
  const assigned = assignBestMatch(cands)
  const inputs = assigned.map((c) => c.inputRef)
  const fields = assigned.map((c) => c.fieldKey)
  assert.equal(new Set(inputs).size, inputs.length, 'each input used at most once')
  assert.equal(new Set(fields).size, fields.length, 'each field used at most once')
})

test('denylist excludes sensitive and third-party fields', () => {
  assert.equal(labelIsSensitive('Confirm email'), true)
  assert.equal(labelIsSensitive('Emergency contact phone'), true)
  assert.equal(labelIsSensitive('Work authorization'), true)
  assert.equal(labelIsSensitive('Gender'), true)
  assert.equal(labelIsSensitive('Reference name'), true)
  assert.equal(labelIsSensitive('Date of birth'), true)
})

test('denylist does not over-match a plain field', () => {
  assert.equal(labelIsSensitive('Email'), false)
  assert.equal(labelIsSensitive('First name'), false)
  assert.equal(labelIsSensitive('Phone'), false)
})

test('shared denylist is the same set autofill falls back to', () => {
  assert.ok(Array.isArray(shared.SENSITIVE_DENYLIST))
  for (const term of ['confirm', 'visa', 'ssn', 'veteran', 'date of birth']) {
    assert.ok(shared.SENSITIVE_DENYLIST.includes(term), `denylist has ${term}`)
  }
})
