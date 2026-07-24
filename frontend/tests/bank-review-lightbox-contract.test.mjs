/* ▶ Review (Bank fast triage) — wiring contract.
 *
 * The navigation itself is unit-tested in src/components/bank/bankReview.test.js.
 * What node --test can't exercise (JSX) is asserted here as text, on the few
 * properties that would silently ruin the mode if a refactor dropped them:
 * the tile click must STAY the bulk-selection gesture, decisions must go out one
 * POST at a time, and a failed POST must not advance.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { WHATS_NEW } from '../src/whatsNew.js'
import { getHelpTopic } from '../src/help/helpRegistry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, '..')
const read = (rel) => fs.readFileSync(path.join(frontend, rel), 'utf8')
const lightbox = read('src/components/bank/BankReviewLightbox.jsx')
const workspace = read('src/components/bank/BankWorkspace.jsx')

test('the lightbox offers Keep, Reject and Skip with their K/R/S shortcuts', () => {
  assert.match(lightbox, /✓ Keep/)
  assert.match(lightbox, /✕ Reject/)
  assert.match(lightbox, /⏭ Skip/)
  assert.match(lightbox, /k === 'k'[^\n]*sendDecision\('keep'\)/)
  assert.match(lightbox, /k === 'r'[^\n]*sendDecision\('reject'\)/)
  assert.match(lightbox, /k === 's' \|\| e\.key === 'ArrowRight'/)
  assert.match(lightbox, /e\.key === 'Escape'/)
  // Discoverable, not folklore: the shortcuts are printed in the UI.
  assert.match(lightbox, /K keep · R reject · S skip/)
})

test('the shortcuts survive the focus trap landing on the 🎲 checkbox', () => {
  // A blanket `tag === 'input'` guard silently killed K/R/S: useFocusTrap
  // focuses the first focusable, which is the Random-order checkbox.
  assert.doesNotMatch(lightbox, /if \(tag === 'input'[^\n]*\) return/)
  assert.match(lightbox, /\['checkbox', 'radio', 'button', 'submit', 'range'\]\.includes\(type\)/)
})

test('each decision is one immediate POST for one image', () => {
  assert.match(lightbox, /postJson\(`\/api\/bank\/\$\{bankId\}\/images\/status`, \{ ids: \[target\], status \}\)/)
})

test('a failed decision surfaces an error and does NOT advance', () => {
  const send = lightbox.match(/const sendDecision = useCallback\(([\s\S]*?)\n  \}, \[/)[1]
  const [tryPart, catchPart] = send.split('} catch (e) {')
  assert.match(tryPart, /setSession\(\(s\) => decide\(s, status\)\)/)
  assert.doesNotMatch(catchPart, /setSession/)
  assert.match(catchPart, /setError\(/)
})

test('the lightbox renders the FULL file, never the grid thumbnail', () => {
  assert.match(lightbox, /\/api\/bank\/\$\{bankId\}\/file\/\$\{id\}/)
  assert.doesNotMatch(lightbox, /\/thumb\//)
})

test('the end-of-pool state is explicit and closable', () => {
  assert.match(lightbox, /All \{p\.total\.toLocaleString\(\)\} image/)
  assert.match(lightbox, /Back to the grid/)
})

test('random order is a shuffle of the remaining ids, not a random draw', () => {
  const logic = read('src/components/bank/bankReview.js')
  assert.match(logic, /export function setShuffle/)
  assert.match(lightbox, /setShuffle\(s, !s\.shuffle\)/)
  // No "pick an index at random" anywhere in the navigation lane.
  assert.doesNotMatch(logic, /Math\.random\(\)\s*\*\s*(s\.|order)/)
})

test('the workspace opens the review over a SNAPSHOT of the current filter', () => {
  assert.match(workspace, /const openReview = async/)
  assert.match(workspace, /await fetchAllIds\(bankId, filterParams\(filter\)\)/)
  assert.match(workspace, /<BankReviewLightbox bankId=\{bankId\} ids=\{review\.ids\} startId=\{review\.startId\}/)
})

test('the tile click still (de)selects — review is its own ▶ hit target', () => {
  assert.match(workspace, /onReview=\{\(\) => openReview\(img\.id\)\}/)
  assert.match(workspace, /onToggle=\{\(\) => setSelected\(/)
  assert.match(workspace, /<button type="button" onClick=\{onReview\}/)
  assert.match(workspace, /<button type="button" onClick=\{onToggle\}/)
})

test('header counters follow the run and the grid refreshes on close', () => {
  assert.match(workspace, /const onReviewDecided = \(\) => \{ refreshPayload\(\) \}/)
  assert.match(workspace, /const closeReview = \(\) => \{ setReview\(null\); refreshPayload\(\); refreshImages\(\) \}/)
})

test('the mode is announced and documented', () => {
  const entry = WHATS_NEW.find((e) => e.id === '2026-07-24-bank-review-one-by-one')
  assert.ok(entry, "What's new entry for the review mode is missing")
  assert.equal(entry.to, '/bank')
  const topic = getHelpTopic('bank-review-one-by-one')
  assert.ok(topic, 'help topic bank-review-one-by-one is missing')
  assert.equal(topic.guide.anchor, 'review-a-bank-one-image-at-a-time')
})
