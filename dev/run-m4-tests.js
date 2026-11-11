/**
 * run-m4-tests.js · Development only. Member 4's offline tests.
 *   node dev/run-m4-tests.js
 *
 * Runs the real .gs files on top of mock-google.js, registers the demo suppliers through
 * Member 1's real functions, then feeds Member 4 exact assessments (the shape Member 3's
 * M3_getAssessments() returns) on chosen dates. Gmail is FAKE: emails are recorded, not sent.
 * So these tests check the rules: cases, approval, duplicates, follow-ups, escalation,
 * case closing and delivery status. They do not check how the email looks in a real inbox;
 * do that once in Apps Script by approving one email to your own address.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appDir = path.resolve(__dirname, '..', 'app');
const logs = [];
const ctx = vm.createContext({ console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')) } });
const load = (file) => vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: path.basename(file) });
load(path.join(__dirname, 'mock-google.js'));
fs.readdirSync(appDir).filter((f) => f.endsWith('.gs')).sort().forEach((f) => load(path.join(appDir, f)));
load(path.join(__dirname, 'demo-data.js'));
const run = (code) => vm.runInContext(code, ctx);
const json = (code) => JSON.parse(run('JSON.stringify(' + code + ')'));

const results = [];
function step(label, fn) {
  const before = logs.length;
  try {
    const note = fn();
    results.push('OK      ' + label + (note !== undefined ? '   (' + note + ')' : ''));
  } catch (err) {
    results.push('FAILED  ' + label + ': ' + err.message);
    logs.slice(before).filter((l) => /FAIL|ERROR/.test(l)).forEach((l) => results.push('          ' + l));
  }
}
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const expectThrow = (code, pattern) => {
  try { run(code); } catch (err) {
    if (pattern && !pattern.test(err.message)) throw new Error('wrong message: ' + err.message);
    return err.message;
  }
  throw new Error('did not throw');
};

/* ------------------------------------------------------------ Helpers */
const gmail = () => ctx.__mock.gmail;
const today = run('SEG_today()');
const plus = (days) => run('M4_calculateFollowUpDate(' + JSON.stringify(today) + ', ' + days + ')');
const notifs = () => json('readTable(SEG.TABS.NOTIFICATIONS)');
const cases = () => json('readTable(SEG.TABS.CASES)');
const caseFor = (sup, req) => cases().filter((c) => c.supplier_id === sup && c.requirement_id === req);
const notifsFor = (caseId) => notifs().filter((n) => n.case_id === caseId);

// One assessment in the shape M3_getAssessments() returns
function asm(supplierId, requirementId, status, daysRemaining, extra) {
  return Object.assign({
    assessmentId: 'ASM-T', docId: 'DOC-' + requirementId, requirementId: requirementId, supplierId: supplierId,
    docTypeName: 'Insurance Certificate', documentClass: 'CERTIFICATE',
    daysRemaining: daysRemaining, status: status, riskLevel: 'MEDIUM', reason: 'test'
  }, extra || {});
}
const prepare = (assessments, refDate) =>
  json('M4_prepareNotifications(' + JSON.stringify({ assessments: assessments, referenceDate: refDate || today }) + ')');

/* ------------------------------------------------------------ Setup */
step('Setup: database and demo suppliers', () => {
  run('SEG_setupDatabase()');
  run('DEV_seedDemo()');
  const sups = json('readTable(SEG.TABS.SUPPLIERS)');
  check(sups.length === 3, 'expected 3 demo suppliers, got ' + sups.length);
  return sups.length + ' suppliers, today is ' + today;
});

step('test_M4_rules (the Apps Script editor test) passes', () => run('test_M4_rules()') + ' checks passed');

/* ------------------------------------------------------------ The full chain on one case */
// SUP001 / REQ0001: insurance expiring in 25 days
step('1. An expiring document opens a case and drafts a first reminder that waits for approval', () => {
  const s = prepare([asm('SUP001', 'REQ0001', 'EXPIRING_SOON', 25)]);
  check(s.casesOpened === 1 && s.notificationsPrepared === 1 && s.pendingApproval === 1, JSON.stringify(s));
  const c = caseFor('SUP001', 'REQ0001');
  check(c.length === 1 && c[0].status === 'OPEN', 'case not OPEN');
  const n = notifsFor(c[0].case_id);
  check(n.length === 1 && n[0].stage === 'FIRST_REMINDER' && n[0].approval_status === 'PENDING_APPROVAL' && n[0].delivery_status === 'DRAFT', JSON.stringify(n));
  check(n[0].recipient === 'yourteam+brightclean@gmail.com', 'wrong recipient ' + n[0].recipient);
  check(n[0].follow_up_due === '', 'follow-up clock should not start before the email is sent');
  check(gmail().sent.length === 0, 'nothing may be sent before approval');
  return c[0].case_id + ', ' + n[0].notification_id;
});

step('2. Running the job again drafts nothing new (duplicate prevention)', () => {
  const before = notifs().length;
  const s = prepare([asm('SUP001', 'REQ0001', 'EXPIRING_SOON', 25)]);
  check(s.casesOpened === 0 && s.notificationsPrepared === 0, JSON.stringify(s));
  check(notifs().length === before && caseFor('SUP001', 'REQ0001').length === 1, 'rows were added');
});

step('3. The subject names the real supplier, not "Supplier"', () => {
  const n = notifs()[0];
  check(n.subject.indexOf('BrightClean Sdn. Bhd.') !== -1, n.subject);
  return n.subject;
});

step('4. Approving sends exactly one email, marks it SENT and starts the 7-day clock', () => {
  const id = notifsFor(caseFor('SUP001', 'REQ0001')[0].case_id)[0].notification_id;
  const r = json('M4_approveNotification("' + id + '")');
  check(r.deliveryStatus === 'SENT', JSON.stringify(r));
  check(gmail().sent.length === 1 && gmail().sent[0].to === 'yourteam+brightclean@gmail.com', 'Gmail did not get exactly one email');
  const n = notifs().find((x) => x.notification_id === id);
  check(n.delivery_status === 'SENT' && n.sent_at && n.follow_up_due === plus(7), JSON.stringify(n));
  return 'follow-up due ' + n.follow_up_due;
});

step('5. No follow-up while the supplier still has time to reply (day 3)', () => {
  const s = prepare([asm('SUP001', 'REQ0001', 'EXPIRING_SOON', 22)], plus(3));
  check(s.notificationsPrepared === 0, JSON.stringify(s));
});

step('6. 7 days with no replacement → a follow-up is drafted, once', () => {
  const s = prepare([asm('SUP001', 'REQ0001', 'EXPIRING_SOON', 18)], plus(7));
  check(s.followUpsPrepared === 1 && s.pendingApproval === 1, JSON.stringify(s));
  const again = prepare([asm('SUP001', 'REQ0001', 'EXPIRING_SOON', 18)], plus(7));
  check(again.notificationsPrepared === 0, 'second run drafted again: ' + JSON.stringify(again));
  const fu = notifsFor(caseFor('SUP001', 'REQ0001')[0].case_id).filter((n) => n.stage === 'FOLLOW_UP');
  check(fu.length === 1 && fu[0].approval_status === 'PENDING_APPROVAL', JSON.stringify(fu));
  check(caseFor('SUP001', 'REQ0001')[0].status === 'OPEN', 'case should not be escalated yet');
});

step('7. 7 days after the follow-up with still no replacement → case escalated and the compliance team emailed', () => {
  const c = caseFor('SUP001', 'REQ0001')[0];
  const fu = notifsFor(c.case_id).find((n) => n.stage === 'FOLLOW_UP');
  run('M4_approveNotification("' + fu.notification_id + '")');
  const sentBefore = gmail().sent.length;
  // No email address set for the officer ("Procurement Officer") and no manager setting:
  // the escalation goes to the account the app runs as.
  const s = prepare([asm('SUP001', 'REQ0001', 'EXPIRING_SOON', 11)], plus(7));
  check(s.escalations === 1 && s.internalSent === 1, JSON.stringify(s));
  check(caseFor('SUP001', 'REQ0001')[0].status === 'ESCALATED', 'case not ESCALATED');
  const esc = notifsFor(c.case_id).find((n) => n.stage === 'INTERNAL_ESCALATION');
  check(esc && esc.notification_type === 'EMAIL_INTERNAL' && esc.approval_status === 'AUTO_APPROVED', JSON.stringify(esc));
  check(esc.delivery_status === 'SENT', 'internal email left as ' + esc.delivery_status);
  check(esc.recipient === 'procurement.officer@alpha-electronics.example', 'escalation went to ' + esc.recipient);
  check(gmail().sent.length === sentBefore + 1 && gmail().sent[sentBefore].body.indexOf('Dear Compliance Team') !== -1, 'internal email not addressed to the compliance team');
  check(/No replacement received 7 days after the follow-up/.test(esc.subject), esc.subject);
  return esc.subject;
});

step('8. After escalation the supplier gets no more emails and nothing is escalated twice', () => {
  const before = notifs().length;
  const s = prepare([asm('SUP001', 'REQ0001', 'EXPIRING_SOON', 4)], plus(14));
  check(s.notificationsPrepared === 0, JSON.stringify(s));
  check(notifs().length === before, 'rows were added');
});

step('9. A valid replacement closes the case', () => {
  const s = prepare([asm('SUP001', 'REQ0001', 'VALID', 365, { docId: 'DOC-RENEWED' })], plus(15));
  check(s.casesResolved === 1, JSON.stringify(s));
  const c = caseFor('SUP001', 'REQ0001')[0];
  check(c.status === 'RESOLVED' && c.resolved_at && /DOC-RENEWED/.test(c.resolution), JSON.stringify(c));
});

step('10. If the same document becomes a problem again later, a NEW case is opened', () => {
  const s = prepare([asm('SUP001', 'REQ0001', 'EXPIRING_SOON', 30)], plus(300));
  check(s.casesOpened === 1, JSON.stringify(s));
  check(caseFor('SUP001', 'REQ0001').length === 2, 'expected 2 cases for REQ0001');
});

/* ------------------------------------------------------------ Other statuses */
step('11. An expired document escalates at once: urgent notice to the supplier (needs approval) + internal email to the manager', () => {
  run('PropertiesService.getScriptProperties().setProperty("COMPLIANCE_MANAGER_EMAIL", "compliance.manager@alpha-electronics.example")');
  const s = prepare([asm('SUP002', 'REQ0004', 'EXPIRED', -3, { riskLevel: 'HIGH' })]);
  const c = caseFor('SUP002', 'REQ0004')[0];
  check(c.status === 'ESCALATED' && c.case_type === 'EXPIRED_ESCALATION', JSON.stringify(c));
  const n = notifsFor(c.case_id);
  const urgent = n.find((x) => x.stage === 'URGENT_ESCALATION');
  const internal = n.find((x) => x.stage === 'INTERNAL_ESCALATION');
  check(urgent && urgent.approval_status === 'PENDING_APPROVAL' && urgent.recipient === 'yourteam+secureguard@gmail.com', JSON.stringify(urgent));
  check(internal && internal.delivery_status === 'SENT' && internal.recipient === 'compliance.manager@alpha-electronics.example', JSON.stringify(internal));
  check(s.escalations === 1, JSON.stringify(s));
  return 'internal email to ' + internal.recipient;
});

step('12. An officer with an email address in "internal officer" gets the escalation instead of the manager', () => {
  run('(function(){ const s = readTable(SEG.TABS.SUPPLIERS).find(x => x.supplier_id === "SUP002"); updateRow(SEG.TABS.SUPPLIERS, s._row, { internal_officer: "facilities@alpha-electronics.example" }); })()');
  prepare([asm('SUP002', 'REQ0005', 'EXPIRING_SOON', 5, { riskLevel: 'CRITICAL' })]);
  const internal = notifsFor(caseFor('SUP002', 'REQ0005')[0].case_id).find((x) => x.stage === 'INTERNAL_ESCALATION');
  check(internal && internal.recipient === 'facilities@alpha-electronics.example', JSON.stringify(internal));
  check(/CRITICAL/.test(internal.subject), internal.subject);
});

step('13. When a case closes, drafts still waiting for approval are cancelled and cannot be sent', () => {
  const c = caseFor('SUP002', 'REQ0004')[0];
  const urgent = notifsFor(c.case_id).find((x) => x.stage === 'URGENT_ESCALATION');
  prepare([asm('SUP002', 'REQ0004', 'VALID', 300)]);
  const after = notifs().find((x) => x.notification_id === urgent.notification_id);
  check(after.approval_status === 'REJECTED' && after.delivery_status === 'CANCELLED' && after.approved_by === 'SYSTEM', JSON.stringify(after));
  const sentBefore = gmail().sent.length;
  expectThrow('M4_approveNotification("' + urgent.notification_id + '")', /rejected or cancelled/);
  check(gmail().sent.length === sentBefore, 'a cancelled draft was sent');
});

step('14. A missing document gets a submission request; rejecting it sends nothing and it is not drafted again', () => {
  prepare([asm('SUP001', 'REQ0002', 'MISSING', null, { docId: '' })]);
  const c = caseFor('SUP001', 'REQ0002')[0];
  check(c.case_type === 'MISSING_DOCUMENT', JSON.stringify(c));
  const req = notifsFor(c.case_id).find((x) => x.stage === 'SUBMISSION_REQUEST');
  check(req && req.approval_status === 'PENDING_APPROVAL', JSON.stringify(req));
  const sentBefore = gmail().sent.length;
  run('M4_rejectNotification("' + req.notification_id + '", "Supplier already confirmed by phone")');
  check(gmail().sent.length === sentBefore, 'rejecting sent an email');
  const s = prepare([asm('SUP001', 'REQ0002', 'MISSING', null, { docId: '' })], plus(10));
  check(s.notificationsPrepared === 0, 'rejected email came back: ' + JSON.stringify(s));
});

step('15. A document that needs a person to check it gets an internal review alert only', () => {
  prepare([asm('SUP001', 'REQ0003', 'NEEDS_REVIEW', null)]);
  const n = notifsFor(caseFor('SUP001', 'REQ0003')[0].case_id);
  check(n.length === 1 && n[0].stage === 'REVIEW_ALERT' && n[0].delivery_status === 'SENT', JSON.stringify(n));
  check(n[0].recipient === 'compliance.manager@alpha-electronics.example', 'review alert went to ' + n[0].recipient);
});

step('16. A due date 14 days away or less brings the follow-up forward, but only after the first email was sent', () => {
  prepare([asm('SUP002', 'REQ0006', 'EXPIRING_SOON', 10)]);
  const c = caseFor('SUP002', 'REQ0006')[0];
  let n = notifsFor(c.case_id);
  check(n.length === 1 && n[0].stage === 'FIRST_REMINDER', 'expected only the first reminder while it is unsent: ' + JSON.stringify(n.map((x) => x.stage)));
  run('M4_approveNotification("' + n[0].notification_id + '")');
  const s = prepare([asm('SUP002', 'REQ0006', 'EXPIRING_SOON', 9)], plus(1));
  check(s.followUpsPrepared === 1, JSON.stringify(s));
});

/* ------------------------------------------------------------ Delivery status */
step('17. If Gmail fails, an approved email is marked FAILED, not SENT, and the clock does not start', () => {
  prepare([asm('SUP003', 'REQ0007', 'EXPIRING_SOON', 40)]);
  const n = notifsFor(caseFor('SUP003', 'REQ0007')[0].case_id)[0];
  gmail().down = true;
  const r = json('M4_approveNotification("' + n.notification_id + '")');
  gmail().down = false;
  const after = notifs().find((x) => x.notification_id === n.notification_id);
  check(r.deliveryStatus === 'FAILED' && after.delivery_status === 'FAILED' && !after.sent_at && !after.follow_up_due, JSON.stringify(after));
});

step('18. If Gmail fails for an internal alert, it is marked FAILED, not left as queued', () => {
  gmail().down = true;
  const s = prepare([asm('SUP003', 'REQ0008', 'NEEDS_REVIEW', null)]);
  gmail().down = false;
  const n = notifsFor(caseFor('SUP003', 'REQ0008')[0].case_id)[0];
  check(s.internalFailed === 1 && n.delivery_status === 'FAILED', JSON.stringify(n));
});

step('19. Without Gmail at all, nothing is recorded as SENT', () => {
  prepare([asm('SUP003', 'REQ0009', 'EXPIRING_SOON', 50)]);
  const n = notifsFor(caseFor('SUP003', 'REQ0009')[0].case_id)[0];
  const saved = ctx.GmailApp;
  ctx.GmailApp = undefined;
  try {
    const r = json('M4_approveNotification("' + n.notification_id + '")');
    check(r.deliveryStatus === 'FAILED', JSON.stringify(r));
  } finally {
    ctx.GmailApp = saved;
  }
  check(notifs().find((x) => x.notification_id === n.notification_id).delivery_status === 'FAILED', 'not FAILED');
});

/* ------------------------------------------------------------ Page and hand-off */
step('20. Closing a case by hand cancels its unsent drafts', () => {
  prepare([asm('SUP003', 'REQ0010', 'EXPIRING_SOON', 60)]);
  const c = caseFor('SUP003', 'REQ0010')[0];
  run('M4_resolveCase("' + c.case_id + '", "Supplier replaced by another vendor")');
  const n = notifsFor(c.case_id)[0];
  check(n.delivery_status === 'CANCELLED', JSON.stringify(n));
});

step('21. The Notifications page shows real supplier names and counts escalations', () => {
  const p = json('M4_getNotificationsPage()');
  check(p.cases.every((c) => c.supplierName !== 'Unknown Supplier'), 'a case shows Unknown Supplier');
  check(p.notifications.every((n) => n.supplierName !== 'Unknown Supplier'), 'a notification shows Unknown Supplier');
  check(p.counts.urgentEscalations >= 3, JSON.stringify(p.counts));
  return p.counts.total + ' emails, ' + p.counts.activeCases + ' open cases, ' + p.counts.sent + ' sent';
});

step('22. Escalations, closures and cancellations are in the audit log', () => {
  const actions = json('readTable(SEG.TABS.AUDIT).filter(a => a.module === "M4").map(a => a.action)');
  ['NOTIFICATIONS_PREPARED', 'NOTIFICATION_APPROVED', 'NOTIFICATION_REJECTED', 'CASE_ESCALATED', 'CASE_RESOLVED', 'NOTIFICATION_CANCELLED']
    .forEach((a) => check(actions.indexOf(a) !== -1, 'no ' + a + ' in the audit log'));
  return actions.length + ' Member 4 audit entries';
});

step('23. Member 5 hand-off: the daily job can call M4_prepareNotifications() with real Member 3 data', () => {
  const s = json('M4_prepareNotifications()');
  ['actionableItems', 'casesOpened', 'casesUpdated', 'notificationsPrepared', 'pendingApproval']
    .forEach((k) => check(typeof s[k] === 'number', 'summary has no ' + k));
  return JSON.stringify(s);
});

const failed = results.filter((r) => r.startsWith('FAILED')).length;
console.log(results.join('\n'));
console.log('\n' + (results.length - failed) + ' of ' + results.length + ' steps passed');
process.exit(failed ? 1 : 0);
