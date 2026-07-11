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
