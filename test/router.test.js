import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { Router } from '../src/router.js';

let t;
const clock = () => t;
const advance = (ms, r) => { t += ms; r?.tick(); };

function makeRouter(config = {}) {
  const r = new Router({ config: { bundleWindowMs: 1000, digest: { times: [], onBreak: true }, ...config }, clock });
  const pings = [];
  r.on('interrupt', (n) => pings.push(n));
  return { r, pings };
}

const decision = (over = {}) => ({ agent: { id: 'coder', name: 'Coder' }, question: 'Run tests?', options: ['Allow', 'Deny'], ...over });

beforeEach(() => { t = new Date(2026, 10, 3, 10, 0, 0).getTime(); });

describe('routing', () => {
  test('asks arriving together become one interruption', () => {
    const { r, pings } = makeRouter();
    r.submit(decision());
    r.submit(decision({ agent: 'Mailer', question: 'Send reply?' }));
    r.submit(decision({ agent: 'Travel', question: 'Book flight?', urgency: 'high' }));
    advance(500, r);
    assert.equal(pings.length, 0, 'still inside the bundle window');
    advance(600, r);
    assert.equal(pings.length, 1);
    assert.equal(pings[0].asks.length, 3);
    for (const a of r.list()) assert.equal(a.delivery.mode, 'interrupted');
    assert.equal(r.stats.notifications, 1);
  });

  test('focus holds normal asks, lets urgent through, and flushes held ones at the natural break', () => {
    const { r, pings } = makeRouter();
    r.setState('focus');
    const normal = r.submit(decision());
    const fyi = r.submit({ agent: 'Mailer', question: 'Archived 3 newsletters' });
    assert.equal(normal.delivery.mode, 'held');
    assert.equal(fyi.delivery.mode, 'digest');
    const urgent = r.submit(decision({ question: 'Prod is down, roll back?', urgency: 'high' }));
    assert.equal(urgent.delivery.mode, 'queued');
    advance(1100, r);
    assert.equal(pings.length, 1);
    assert.deepEqual(pings[0].asks.map((a) => a.id), [urgent.id]);

    r.setState('available');
    assert.equal(pings.length, 2, 'natural break delivers immediately, in one notification');
    assert.deepEqual(pings[1].asks.map((a) => a.id), [normal.id]);
    assert.deepEqual(pings[1].digest.map((a) => a.id), [fyi.id]);
  });

  test('dnd only lets critical through, immediately', () => {
    const { r, pings } = makeRouter();
    r.setState('dnd');
    assert.equal(r.submit(decision({ urgency: 'high' })).delivery.mode, 'held');
    const crit = r.submit(decision({ urgency: 'critical', question: 'Card fraud detected, freeze?' }));
    assert.equal(pings.length, 1, 'critical skips the bundle window');
    assert.equal(crit.delivery.mode, 'interrupted');
  });

  test('low priority goes to the digest, delivered at digest time', () => {
    const { r, pings } = makeRouter({ digest: { times: ['10:30'], onBreak: true } });
    const low = r.submit({ agent: 'Mailer', question: 'Unsubscribed from 2 lists', urgency: 'low' });
    assert.equal(low.delivery.mode, 'digest');
    advance(20 * 60e3, r);
    assert.equal(pings.length, 0);
    advance(11 * 60e3, r);
    assert.equal(pings.length, 1);
    assert.equal(pings[0].kind, 'digest');
    assert.equal(pings[0].digest[0].id, low.id);
  });
});

describe('snooze', () => {
  test('a snoozed ask comes back and pings you when the snooze ends, without spending budget', () => {
    const { r, pings } = makeRouter({ budget: { initial: 1, min: 1, max: 30 } });
    r.submit(decision({ question: 'first?' }));
    advance(1100, r);
    const a = r.submit(decision());
    assert.equal(a.delivery.mode, 'held', 'over budget');
    r.snooze(a.id, 10 * 60000);
    assert.equal(a.delivery.mode, 'snoozed');
    advance(9 * 60000, r);
    assert.equal(pings.length, 1);
    advance(2 * 60000, r);
    advance(1100, r);
    assert.equal(pings.length, 2, 'reminder delivered even though the agent has no budget');
    assert.equal(a.delivery.mode, 'interrupted');
    assert.match(a.delivery.reason, /snooze ended/);
  });

  test('a snooze that ends during focus waits for the natural break', () => {
    const { r, pings } = makeRouter();
    const a = r.submit(decision());
    advance(1100, r);
    r.snooze(a.id, 60000);
    r.setState('focus');
    advance(61000, r);
    assert.equal(a.delivery.mode, 'held');
    r.setState('available');
    assert.equal(pings.at(-1).asks[0].id, a.id);
  });

  test('unsnooze puts it back where it was, without pinging again', () => {
    const { r, pings } = makeRouter();
    const a = r.submit(decision());
    advance(1100, r);
    assert.equal(a.delivery.mode, 'interrupted');
    r.snooze(a.id, 3600000);
    r.unsnooze(a.id);
    assert.equal(a.delivery.mode, 'interrupted');
    advance(2000, r);
    assert.equal(pings.length, 1);
  });
});

describe('deadlines', () => {
  test('the default applies when nobody answers', () => {
    const { r } = makeRouter();
    r.setState('focus');
    const a = r.submit(decision({ default: 'Deny', deadline: '10m' }));
    assert.equal(a.delivery.mode, 'held', 'a safe default means no need to interrupt');
    advance(10 * 60e3 + 1, r);
    assert.equal(a.status, 'defaulted');
    assert.equal(a.answer.option, 'deny');
    assert.equal(a.answer.by, 'default');
  });

  test('no safe default: escalates near the deadline, then expires', () => {
    const { r, pings } = makeRouter();
    r.setState('focus');
    const a = r.submit(decision({ deadline: '20m' }));
    assert.equal(a.delivery.mode, 'held');
    advance(14 * 60e3, r);
    assert.equal(a.delivery.mode, 'held');
    advance(2 * 60e3, r); // 4 minutes left: inside the 5 minute window
    advance(1100, r);
    assert.equal(a.delivery.mode, 'interrupted');
    assert.match(a.delivery.notes.join(' '), /escalated/);
    assert.equal(pings.length, 1);
    advance(5 * 60e3, r);
    assert.equal(a.status, 'expired');
  });
});

describe('attention budgets', () => {
  test('dismissing an interruption halves the agent budget; acting on one grows it', () => {
    const { r } = makeRouter();
    const a = r.submit(decision());
    advance(1100, r);
    r.dismiss(a.id);
    assert.equal(r.budgets.get('coder').capacity, 3);
    const b = r.submit(decision());
    advance(1100, r);
    r.answer(b.id, { option: 'allow' });
    assert.equal(r.budgets.get('coder').capacity, 4);
  });

  test('an agent over budget is held, with the reason shown', () => {
    const { r } = makeRouter({ budget: { initial: 2, min: 1, max: 30 } });
    r.submit(decision({ question: 'one?' }));
    r.submit(decision({ question: 'two?' }));
    const third = r.submit(decision({ question: 'three?' }));
    assert.equal(third.delivery.mode, 'held');
    assert.match(third.delivery.reason, /over its attention budget/);
    const other = r.submit(decision({ agent: 'Mailer' }));
    assert.equal(other.delivery.mode, 'queued', 'budgets are per agent');
    advance(1100, r);
    assert.equal(third.delivery.mode, 'held');
    advance(30 * 60e3, r); // refill at 2/hr -> one token after 30 min
    assert.equal(third.delivery.mode, 'queued');
  });

  test('crying wolf: dismissed "urgent" asks lower the agent\'s urgency', () => {
    const { r } = makeRouter({ budget: { initial: 30, min: 1, max: 30 } });
    for (let i = 0; i < 4; i++) {
      const a = r.submit(decision({ question: `urgent ${i}?`, urgency: 'high' }));
      r.dismiss(a.id);
    }
    assert.ok(r.budgets.credibility('coder') < 0.5);
    r.setState('focus');
    const next = r.submit(decision({ question: 'really urgent this time?', urgency: 'high' }));
    assert.equal(next.delivery.mode, 'held');
    assert.match(next.delivery.notes[0], /urgency lowered/);
  });

  test('asks settled before the ping goes out are refunded', () => {
    const { r, pings } = makeRouter();
    const a = r.submit(decision());
    assert.equal(r.budgets.get('coder').tokens, 5);
    r.answer(a.id, { option: 'allow' }); // answered in the inbox within the bundle window
    assert.equal(r.budgets.get('coder').tokens, 6);
    advance(1100, r);
    assert.equal(pings.length, 0);
  });

  test('muted agents never interrupt but still show up', () => {
    const { r } = makeRouter();
    r.setMuted('coder', true);
    const a = r.submit(decision({ urgency: 'high' }));
    assert.equal(a.delivery.mode, 'held');
    assert.equal(r.list().length, 1);
  });
});

describe('rules and learning', () => {
  test('answer rules settle asks without bothering you', () => {
    const { r, pings } = makeRouter();
    r.addRule({ match: { agent: 'coder', fingerprint: 'Bash:npm test*' }, action: { answer: 'allow' } });
    const a = r.submit(decision({ fingerprint: 'Bash:npm test -- --watch=false' }));
    assert.equal(a.status, 'auto');
    assert.equal(a.answer.option, 'allow');
    advance(1100, r);
    assert.equal(pings.length, 0);
  });

  test('route rules: digest and mute', () => {
    const { r } = makeRouter();
    r.addRule({ match: { agent: 'Mailer' }, action: { route: 'digest' } });
    r.addRule({ match: { agent: 'Newsbot', kind: 'inform' }, action: { route: 'mute' } });
    assert.equal(r.submit(decision({ agent: 'Mailer', urgency: 'high' })).delivery.mode, 'digest');
    assert.equal(r.submit({ agent: 'Newsbot', question: 'Top stories' }).status, 'read');
  });

  test('three identical answers produce a suggestion; accepting it settles waiting asks', () => {
    const { r } = makeRouter({ budget: { initial: 30, min: 1, max: 30 } });
    for (let i = 0; i < 3; i++) r.answer(r.submit(decision({ fingerprint: 'Bash:npm test' })).id, { option: 'allow' });
    const [sug] = r.suggestions.values();
    assert.ok(sug, 'suggestion created');
    assert.equal(sug.option, 'allow');
    const waiting = r.submit(decision({ fingerprint: 'Bash:npm test' }));
    r.acceptSuggestion(sug.id);
    assert.equal(waiting.status, 'auto');
  });

  test('irreversible decisions are never suggested for automation', () => {
    const { r } = makeRouter({ budget: { initial: 30, min: 1, max: 30 } });
    for (let i = 0; i < 5; i++) r.answer(r.submit(decision({ fingerprint: 'git push', reversible: false })).id, { option: 'allow' });
    assert.equal(r.suggestions.size, 0);
  });

  test('"always" rules match literally, not as globs', () => {
    const { r } = makeRouter({ budget: { initial: 30, min: 1, max: 30 } });
    const a = r.submit(decision({ fingerprint: 'Bash:cat *.log | grep err' }));
    r.answer(a.id, { option: 'allow', always: true });
    assert.equal(r.submit(decision({ fingerprint: 'Bash:cat *.log | grep err' })).status, 'auto');
    assert.equal(r.submit(decision({ fingerprint: 'Bash:cat secrets.log | grep err' })).status, 'pending');
    assert.equal(r.submit(decision({ fingerprint: 'Bash:cat ' })).status, 'pending');
  });
});

describe('agent-facing behaviour', () => {
  test('wait() resolves when the human answers', async () => {
    const { r } = makeRouter();
    const a = r.submit(decision());
    const p = r.wait(a.id, 5000);
    r.answer(a.id, { option: 'Deny' });
    const done = await p;
    assert.equal(done.status, 'answered');
    assert.equal(done.answer.option, 'deny');
  });

  test('collapse_key replaces an unread FYI', () => {
    const { r } = makeRouter();
    const first = r.submit({ agent: 'Coder', question: 'Build 1/3', collapse_key: 'build' });
    const second = r.submit({ agent: 'Coder', question: 'Build 2/3', collapse_key: 'build' });
    assert.equal(first.status, 'read');
    assert.equal(first.answer.replaced_by, second.id);
    assert.equal(r.list().length, 1);
  });

  test('input asks validate required form fields', () => {
    const { r } = makeRouter();
    const a = r.submit({ agent: 'Travel', question: 'Passport details?', input: { schema: { type: 'object', properties: { number: { type: 'string' }, country: { type: 'string' } }, required: ['number'] } } });
    assert.throws(() => r.answer(a.id, { values: { country: 'PT' } }), /missing required: number/);
    r.answer(a.id, { values: { number: 'X1', country: 'PT' } });
    assert.equal(a.status, 'answered');
  });

  test('every decision lands in the ledger, and the chain verifies', () => {
    const { r } = makeRouter();
    const a = r.submit(decision());
    r.answer(a.id, { option: 'allow' });
    const types = r.ledger.entries.map((e) => e.type);
    assert.ok(types.includes('ask.created') && types.includes('ask.routed') && types.includes('ask.resolved'));
    const resolved = r.ledger.entries.find((e) => e.type === 'ask.resolved');
    assert.deepEqual(resolved.data.seen.options, ['Allow', 'Deny']);
    assert.equal(r.ledger.verify().ok, true);
  });
});

describe('work in passes: only the final outcome interrupts', () => {
  const RESEARCHER = { id: 'researcher', name: 'Researcher' };
  const WATCHDOG = { id: 'watchdog', name: 'Watchdog' };
  const update = (over = {}) => ({ agent: RESEARCHER, question: 'Report ready', ...over });
  const delivered = (pings) => pings.flatMap((n) => [...n.asks, ...n.digest].map((a) => a.id));

  test('interim passes wait in the inbox; the final message is the one that pings', () => {
    const { r, pings } = makeRouter();
    r.setWork('req-1', { status: 'running' });
    const first = r.submit(update({ question: 'Market report, first pass', work: { id: 'req-1', pass: 'draft' }, attachments: [{ content: '# Draft', title: 'report.md' }] }));
    assert.equal(first.delivery.mode, 'held');
    assert.equal(first.delivery.work, 'interim');
    assert.match(first.delivery.reason, /work “req-1” has another pass running or queued/);
    // An automatic fix, run by a different agent, continues the same work.
    const fix = r.submit({ agent: { id: 'fixer', name: 'Citation fixer' }, question: 'Fixed 3 citations', work: { id: 'req-1', pass: 'citations', continues: true } });
    assert.equal(fix.delivery.mode, 'held');
    advance(1100, r);
    assert.equal(pings.length, 0, 'nothing pings while a pass is running');

    const final = r.submit(update({ question: 'Market report, corrected', work: { id: 'req-1', final: true } }));
    assert.equal(final.delivery.mode, 'queued');
    advance(1100, r);
    assert.deepEqual(delivered(pings), [final.id]);
    for (const a of [first, fix]) {
      assert.equal(a.status, 'unread', 'interim passes stay in your inbox');
      assert.equal(a.delivery.mode, 'held');
      assert.match(a.delivery.reason, /a later message from work “req-1” is its outcome/);
    }
    // A natural break, the digest or time passing never brings an interim pass back.
    r.setState('focus');
    r.setState('available');
    r.deliverDigest();
    advance(36e5, r);
    assert.deepEqual(delivered(pings), [final.id]);
    assert.equal(r.stats.interim, 2);
  });

  test('closing the work releases the last pass when no final message was sent', () => {
    const { r, pings } = makeRouter();
    const msg = r.submit(update({ work: { id: 'req-2', continues: true } }));
    advance(1100, r);
    assert.equal(msg.delivery.mode, 'held');
    const view = r.setWork('req-2', { status: 'done' });
    assert.equal(view.open, false);
    assert.equal(msg.delivery.mode, 'queued');
    assert.match(msg.delivery.notes.join(' '), /work “req-2” is done; this is its outcome/);
    advance(1100, r);
    assert.deepEqual(delivered(pings), [msg.id]);
  });

  test('any agent, thread or channel works with no setup', () => {
    const { r, pings } = makeRouter();
    const thread = `brand-new-channel-${Date.now()}`;
    const agent = 'An agent nobody configured';
    const step = r.submit({ agent, thread, question: 'Step 1 of 2 done', work: { id: 'job-x', continues: true } });
    const done = r.submit({ agent, thread, question: 'Both steps done', work: { id: 'job-x', final: true } });
    advance(1100, r);
    assert.equal(step.delivery.mode, 'held');
    assert.deepEqual(delivered(pings), [done.id]);
  });

  test('decided at delivery time: a pass that starts inside the bundle window holds the report back', () => {
    const { r, pings } = makeRouter();
    const report = r.submit(update({ work: 'req-3' })); // nothing says more is coming, so it may ping
    assert.equal(report.delivery.mode, 'queued');
    assert.equal(r.budgets.get('researcher').tokens, 5);
    advance(500, r);
    r.setWork('req-3', { status: 'running' }); // seconds later, a follow-up pass starts
    advance(600, r);
    assert.equal(pings.length, 0, 'the earlier "send" verdict was not reused');
    assert.equal(report.delivery.mode, 'held');
    assert.equal(Math.round(r.budgets.get('researcher').tokens), 6, 'the ping it never made is refunded');
    const corrected = r.submit(update({ question: 'Corrected report', work: { id: 'req-3', final: true } }));
    advance(1100, r);
    assert.deepEqual(delivered(pings), [corrected.id]);
  });

  test('decided at delivery time: a saved verdict is checked again when the bundle or digest goes out', () => {
    const { r } = makeRouter();
    const queued = r.submit(update({ work: 'req-4' }));
    const digest = r.submit(update({ question: 'Low priority notes', urgency: 'low', work: 'req-5' }));
    assert.equal(queued.delivery.mode, 'queued');
    assert.equal(digest.delivery.mode, 'digest');
    // The next passes start while those verdicts sit in saved state (e.g. across a restart).
    const saved = JSON.parse(JSON.stringify(r.toJSON()));
    for (const w of saved.work) w.open = true;
    const { r: r2, pings } = makeRouter({ digest: { times: ['10:30'], onBreak: true } });
    r2.load(saved);
    advance(1100, r2);
    advance(31 * 60e3, r2);
    assert.equal(pings.length, 0);
    for (const id of [queued.id, digest.id]) {
      const a = r2.get(id);
      assert.equal(a.delivery.mode, 'held');
      assert.match(a.delivery.notes.join(' '), /checked again just before it went out/);
    }
  });

  test('a stand-in note for work whose own message was held is held too, matched by work id, not title', () => {
    const { r, pings } = makeRouter();
    r.setWork('req-7', { status: 'running' });
    const own = r.submit(update({ question: 'Weekly summary', work: 'req-7' }));
    const fallback = r.submit({ agent: WATCHDOG, question: 'No report arrived for your request', work: { id: 'req-7', fallback: true } });
    assert.equal(own.delivery.mode, 'held');
    assert.equal(fallback.delivery.mode, 'held');
    r.setWork('req-7', { status: 'done' });
    advance(1100, r);
    assert.deepEqual(delivered(pings), [own.id]);
    assert.equal(fallback.delivery.work, 'fallback');
    assert.match(fallback.delivery.reason, /a stand-in note, but work “req-7” sent its own message/);
    const late = r.submit({ agent: WATCHDOG, question: 'Still no report?', work: { id: 'req-7', fallback: true } });
    assert.equal(late.delivery.work, 'fallback', 'after the real message went out, a stand-in is still held');

    // Another work with the very same title: it never sent anything, so its stand-in does ping.
    const other = r.submit({ agent: WATCHDOG, question: 'Weekly summary', work: { id: 'req-8', fallback: true } });
    assert.equal(other.delivery.mode, 'queued');
    advance(1100, r);
    assert.deepEqual(delivered(pings), [own.id, other.id]);

    // What was held is recorded by the work's id.
    const view = r.workView('req-7');
    assert.deepEqual(view.held, [fallback.id, late.id]);
    assert.deepEqual(view.delivered, [own.id]);
    const routed = r.ledger.entries.filter((e) => e.type === 'ask.routed' && e.data.id === fallback.id);
    assert.equal(routed[0].data.work, 'req-7');
    assert.ok(r.ledger.entries.some((e) => e.type === 'work.closed' && e.data.work === 'req-7' && e.data.status === 'done'));
  });

  test('a stand-in that is waiting to go out is pulled back when the real message arrives', () => {
    const { r, pings } = makeRouter();
    const fallback = r.submit({ agent: WATCHDOG, question: 'No report came back', work: { id: 'req-9', fallback: true } });
    assert.equal(fallback.delivery.mode, 'queued');
    const real = r.submit(update({ work: 'req-9' }));
    assert.equal(fallback.delivery.mode, 'held');
    advance(1100, r);
    assert.deepEqual(delivered(pings), [real.id]);
  });

  test('a message that is only a file is judged like any other message', () => {
    const { r, pings } = makeRouter();
    r.setWork('req-10', { status: 'running' });
    const file = r.submit({ agent: RESEARCHER, work: 'req-10', attachments: ['/tmp/out/report.pdf'] });
    assert.equal(file.question, 'Sent “report.pdf”');
    assert.equal(file.delivery.mode, 'held');
    assert.equal(file.delivery.work, 'interim');
    advance(1100, r);
    assert.equal(pings.length, 0, 'the file did not slip out while the work was open');
    const final = r.submit(update({ work: { id: 'req-10', final: true } }));
    advance(1100, r);
    assert.deepEqual(delivered(pings), [final.id]);
    // With no work id, a file on its own routes like any update.
    const lone = r.submit({ agent: RESEARCHER, attachments: ['https://example.com/chart.png'] });
    assert.equal(lone.delivery.mode, 'queued');
    advance(1100, r);
    assert.deepEqual(delivered(pings), [final.id, lone.id]);
  });

  test('negative control: questions and critical messages still interrupt while the work is open', () => {
    const { r, pings } = makeRouter();
    r.setWork('req-11', { status: 'running' });
    const interim = r.submit(update({ work: 'req-11' }));
    const question = r.submit(decision({ agent: RESEARCHER, question: 'Cover last year too?', work: 'req-11' }));
    assert.equal(question.delivery.mode, 'queued');
    const critical = r.submit(update({ question: 'The source is deleting its archive now', urgency: 'critical', work: 'req-11' }));
    assert.equal(critical.delivery.mode, 'interrupted', 'critical goes out at once');
    advance(1100, r);
    assert.deepEqual(delivered(pings).sort(), [critical.id, question.id].sort(), 'the question went out with the critical message');
    assert.equal(interim.delivery.mode, 'held');
    assert.equal(r.workView('req-11').open, true, 'a blocker does not end the work');
  });

  test('negative control: messages without a work id route exactly as before', () => {
    const { r, pings } = makeRouter();
    r.setWork('req-12', { status: 'running' });
    r.submit(update({ work: 'req-12' }));
    const plain = r.submit(update({ question: 'Archived 3 newsletters' }));
    assert.equal(plain.work, null);
    assert.equal(plain.delivery.mode, 'queued');
    assert.equal(plain.delivery.reason, 'normal urgency while you\'re available');
    advance(1100, r);
    assert.deepEqual(delivered(pings), [plain.id]);
    assert.ok(!('work' in r.ledger.entries.find((e) => e.type === 'ask.created' && e.data.id === plain.id).data));
    // Turned off in config, work ids are ignored.
    const off = makeRouter({ work: null });
    off.r.setWork('req-13', { status: 'running' });
    assert.equal(off.r.submit(update({ work: 'req-13' })).delivery.mode, 'queued');
  });

  test('negative control: the final message is delivered once', () => {
    const { r, pings } = makeRouter();
    r.setWork('req-14', { status: 'queued' });
    r.submit(update({ work: 'req-14' }));
    const final = r.submit(update({ question: 'Done', work: { id: 'req-14', final: true } }));
    advance(1100, r);
    r.setWork('req-14', { status: 'done' }); // a late "done" after the final message
    r.setState('focus');
    r.setState('available');
    r.deliverDigest();
    for (let i = 0; i < 5; i++) advance(1100, r);
    assert.equal(delivered(pings).filter((id) => id === final.id).length, 1);
    assert.equal(r.stats.interrupted_asks, 1);
  });

  test('work with no news for hours counts as finished; a heartbeat keeps it open', () => {
    const { r, pings } = makeRouter();
    const msg = r.submit(update({ work: { id: 'req-15', continues: true } }));
    advance(5 * 36e5, r);
    r.setWork('req-15', { status: 'running' }); // heartbeat from a long pass
    advance(5 * 36e5, r);
    assert.equal(msg.delivery.mode, 'held');
    assert.equal(pings.length, 0);
    advance(36e5, r); // six hours since the last news
    assert.match(msg.delivery.notes.join(' '), /no news from work “req-15” for 6h/);
    advance(1100, r);
    assert.deepEqual(delivered(pings), [msg.id]);
  });

  test('your snooze still wins over an open work', () => {
    const { r, pings } = makeRouter();
    const msg = r.submit(update({ work: { id: 'req-16', continues: true } }));
    r.snooze(msg.id, 10 * 60e3);
    advance(11 * 60e3, r);
    advance(1100, r);
    assert.deepEqual(delivered(pings), [msg.id]);
  });

  test('work ids are scoped: another agent key\'s work with the same id is a different work', () => {
    const { r } = makeRouter();
    r.setWork('job', { status: 'running' });
    assert.equal(r.submit(update({ work: 'job' })).delivery.mode, 'held');
    assert.equal(r.submit(update({ question: 'Other report', work: 'job' }), { scope: 'key:cloud' }).delivery.mode, 'queued');
    assert.equal(r.workView('job', 'key:cloud').open, false);
  });

  test('open work and what it holds survive a restart', () => {
    const { r } = makeRouter();
    r.setWork('req-17', { status: 'running' });
    const interim = r.submit(update({ work: 'req-17' }));
    const { r: r2, pings } = makeRouter();
    r2.load(JSON.parse(JSON.stringify(r.toJSON())));
    advance(1100, r2);
    const final = r2.submit(update({ work: { id: 'req-17', final: true } }));
    advance(1100, r2);
    assert.deepEqual(delivered(pings), [final.id]);
    assert.equal(r2.get(interim.id).delivery.mode, 'held');
  });
});
