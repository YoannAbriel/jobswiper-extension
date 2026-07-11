import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { isPlausibleJob, stripPII } = require('../../utils/extract-helpers.js')

const LONG = 'x'.repeat(250)

test('plausible: title+company+long description', () => {
  assert.equal(isPlausibleJob({ title: 'Designer', company: 'Acme', description: LONG }), true)
})

test('implausible: empty title', () => {
  assert.equal(isPlausibleJob({ title: '', company: 'Acme', description: LONG }), false)
})

test('implausible: short description', () => {
  assert.equal(isPlausibleJob({ title: 'Designer', company: 'Acme', description: 'too short' }), false)
})

test('stripPII removes emails, phones, profile urls', () => {
  const input =
    'Contact jane.doe@acme.com or +41 78 605 70 60 or 06 52 05 59 47, profile https://www.linkedin.com/in/jane-doe/'
  const out = stripPII(input)
  assert.ok(!out.includes('jane.doe@acme.com'))
  assert.ok(!out.includes('78 605 70 60'))
  assert.ok(!out.includes('06 52 05 59 47'))
  assert.ok(!out.includes('linkedin.com/in/'))
})

test('stripPII strips real phone numbers (all shapes)', () => {
  for (const phone of ['+41 78 605 70 60', '06 52 05 59 47', '+33 6 52 05 59 47', '(415) 555-2671']) {
    const out = stripPII(`Call me at ${phone} today`)
    assert.ok(!out.includes(phone), `expected "${phone}" to be stripped, got: ${out}`)
    assert.ok(out.includes('[phone]'), `expected [phone] token for "${phone}", got: ${out}`)
  }
})

test('stripPII preserves salary ranges and reference numbers verbatim', () => {
  const preserved = [
    '60000-75000 EUR',
    'Salary range 60000-75000 EUR annually',
    'Ref number 2026071012345',
    '5+ years',
    '60-75k EUR',
  ]
  for (const text of preserved) {
    assert.equal(stripPII(text), text, `expected "${text}" untouched, got: ${stripPII(text)}`)
  }
})
