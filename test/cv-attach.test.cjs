/**
 * Pure-logic tests for CV attach (Phase 3): uuid validation, filename
 * derivation, accept gate, target-mode selection, and the base64 binary
 * round-trip that carries the PDF from the service worker to the page.
 * Run: node --test test/cv-attach.test.js
 *
 * The DOM-bound parts (file-input visibility gate, DataTransfer attach + verify,
 * pick mode, closed-shadow panel, blob download) have no jsdom dependency in
 * this build-less extension and are covered by the manual steps in the PR
 * description / degradation matrix.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const cv = require('../content/cv-attach.js')
const { isValidUuid, deriveFilename, acceptOk, selectMode, base64ToBytes, MAX_PDF_BYTES } = cv

const UUID = '11111111-2222-3333-4444-555555555555'

test('isValidUuid accepts a v-any uuid and rejects junk', () => {
  assert.equal(isValidUuid(UUID), true)
  assert.equal(isValidUuid(UUID.toUpperCase()), true)
  assert.equal(isValidUuid(''), false)
  assert.equal(isValidUuid('not-a-uuid'), false)
  // no query-string / path injection can pass as a cvId
  assert.equal(isValidUuid(UUID + '&format=docx'), false)
  assert.equal(isValidUuid('../../etc/passwd'), false)
  assert.equal(isValidUuid(null), false)
})

test('deriveFilename sanitizes to a single safe token + .pdf', () => {
  assert.equal(deriveFilename('Jane_Doe'), 'Jane_Doe.pdf')
  assert.equal(deriveFilename('Jane Doe'), 'Jane_Doe.pdf')
  assert.equal(deriveFilename('Jane/../Doe'), 'Jane_Doe.pdf')
  assert.equal(deriveFilename(''), 'CV.pdf')
  assert.equal(deriveFilename(null), 'CV.pdf')
  assert.equal(deriveFilename('___'), 'CV.pdf')
})

test('acceptOk allows document inputs and empty accept, rejects image-only', () => {
  assert.equal(acceptOk(''), true)
  assert.equal(acceptOk(null), true)
  assert.equal(acceptOk('application/pdf'), true)
  assert.equal(acceptOk('.pdf,.doc,.docx'), true)
  assert.equal(acceptOk('application/msword'), true)
  assert.equal(acceptOk('application/octet-stream'), true)
  assert.equal(acceptOk('image/*'), false)
  assert.equal(acceptOk('.png,.jpg,.jpeg'), false)
  // positive allowlist: unknown / non-document accept degrades to download
  assert.equal(acceptOk('text/plain'), false)
})

test('selectMode maps the safe-input count to a flow', () => {
  assert.equal(selectMode(0), 'download')
  assert.equal(selectMode(1), 'attach')
  assert.equal(selectMode(2), 'pick')
  assert.equal(selectMode(9), 'pick')
})

test('base64 round-trips PDF bytes byte-for-byte', () => {
  // Emulate the SW encoder (Buffer.toString base64 == btoa over binary string).
  const original = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80, 0x7f, 0x0a]) // %PDF...
  const base64 = original.toString('base64')
  const bytes = base64ToBytes(base64)
  assert.ok(bytes instanceof Uint8Array)
  assert.equal(bytes.length, original.length)
  for (let i = 0; i < original.length; i++) {
    assert.equal(bytes[i], original[i], `byte ${i} matches`)
  }
})

test('base64 round-trips a large (>32KB chunk boundary) payload', () => {
  const big = Buffer.alloc(70000)
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff
  const bytes = base64ToBytes(big.toString('base64'))
  assert.equal(bytes.length, big.length)
  assert.equal(bytes[0], big[0])
  assert.equal(bytes[69999], big[69999])
})

test('the 10 MB cap constant is exact', () => {
  assert.equal(MAX_PDF_BYTES, 10 * 1024 * 1024)
})
