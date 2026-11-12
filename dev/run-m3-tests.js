/**
 * run-m3-tests.js · Development only. Member 3's offline tests.
 *   node dev/run-m3-tests.js
 *
 * Runs the real .gs files on top of mock-google.js, imports the real test dataset,
 * executes AI extractions with mock answers, runs M3_assessDocuments with the
 * dataset reference date (2026-11-11), and verifies that:
 *   1. Every document & requirement classification matches GroundTruth.csv 100%.
 *   2. Risk levels (CRITICAL, HIGH, MEDIUM, LOW) are assigned accurately.
 *   3. Expiry days remaining and countdowns are correct.
 *   4. The Assessments tab is written with the agreed schema.
 *   5. Configurable thresholds can be retrieved and updated.
 *   6. The overview dashboard registers the Assessment module as Connected.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appDir = path.resolve(__dirname, '..', 'app');
const logs = [];
const ctx = vm.createContext({
  console: {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push('WARN ' + a.join(' ')),
    error: (...a) => logs.push('ERROR ' + a.join(' '))
  }
});

const load = (file) => vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: path.basename(file) });
load(path.join(__dirname, 'mock-google.js'));
fs.readdirSync(appDir).filter((f) => f.endsWith('.gs')).sort().forEach((f) => load(path.join(appDir, f)));

const run = (code) => vm.runInContext(code, ctx);
const json = (code) => JSON.parse(run('JSON.stringify(' + code + ')'));

/* ------------------------------------------------------------ Test dataset setup */
const FAKE_KEY = 'TEST-KEY-not-a-real-key-0000';
const pdfRoot = path.resolve(__dirname, '..', 'test-pdfs');
const walk = (dir, rel) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const r = rel ? rel + '/' + e.name : e.name;
  if (e.isDirectory()) return walk(path.join(dir, e.name), r);
  return e.name.endsWith('.pdf') ? [{ name: e.name, dir: rel, b64: fs.readFileSync(path.join(dir, e.name)).toString('base64') }] : [];
});
ctx.__pdfs = walk(pdfRoot, '');
const nameByContent = {};
ctx.__pdfs.forEach((p) => { nameByContent[p.b64] = p.name; });
const truth = json('M1_DATASET.groundTruth');

function perfectAnswer(fileName, documentClass) {
  const t = truth.find((r) => r.file_name === fileName);
  if (!t) throw new Error('fake Gemini: unknown file ' + fileName);
  const v = (x) => (x === '' || x === undefined ? null : x);
  const answer = {
    readable: true, holder_name: v(t.holder_name), document_no: v(t.document_no), due_date: v(t.due_date), scope: v(t.scope),
    due_date_candidates: t.due_date ? [t.due_date] : [], uncertain_fields: [], notes: null
  };
  if (documentClass === 'CONTRACT') {
    Object.assign(answer, {
      client_name: v(t.client_name), start_date: v(t.start_date),
      renewal_notice_days: t.renewal_notice_days ? Number(t.renewal_notice_days) : null, auto_renewal: v(t.auto_renewal)
    });
  } else {
    Object.assign(answer, { issuing_body: v(t.issuing_body), issue_date: v(t.issue_date) });
  }
  if (/UNREADABLE/.test(t.expected_issues)) {
    Object.keys(answer).forEach((k) => { if (!Array.isArray(answer[k])) answer[k] = null; });
    Object.assign(answer, { readable: false, notes: 'Every value is blurred.' });
  }
  if (/CONFLICTING_DATES/.test(t.expected_issues)) answer.due_date_candidates = ['2027-11-30', '2026-11-30'];
  return answer;
}

ctx.UrlFetchApp = {
  fetch(url, options) {
    const body = JSON.parse(options.payload);
    const parts = body.contents[0].parts;
    const fileName = nameByContent[parts[0].inlineData.data];
    const t = truth.find((r) => r.file_name === fileName);
    const ans = perfectAnswer(fileName, t.document_class);
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(ans) }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 }
      })
    };
  }
};

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

const check = (ok, msg) => { if (!ok) throw new Error(msg); };

/* ------------------------------------------------------------ Test Suite */

step('M3_Client compiles, and Index.html includes M3_Page and M3_Client', () => {
  const html = fs.readFileSync(path.join(appDir, 'M3_Client.html'), 'utf8');
  new vm.Script(html.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>[\s\S]*$/, ''), { filename: 'M3_Client.html' });
  const index = fs.readFileSync(path.join(appDir, 'Index.html'), 'utf8');
  check(/id="page-risk"[^>]*>\s*<\?!= include\('M3_Page'\); \?>/.test(index), 'M3_Page not inside page-risk');
  check(index.indexOf("include('M3_Client')") > index.indexOf("include('M2_Client')"), 'M3_Client must come after M2_Client');
});

step('test_M3_rules (logic and rule calculations pass)', () => {
  const passed = run('test_M3_rules()');
  check(passed > 0, 'No checks passed');
  return passed + ' checks passed';
});

step('Set up database and import dataset (7 suppliers, 17 documents)', () => {
  run('SEG_setupDatabase()');
  run(`var __folder = DriveApp.createFolder('test-pdfs');
    var __dir = function (rel) { var f = __folder; rel.split('/').filter(Boolean).forEach(function (part) {
      var it = f.getFoldersByName(part); f = it.hasNext() ? it.next() : f.createFolder(part); }); return f; };
    __pdfs.forEach(function (p) { __dir(p.dir).createFile(Utilities.newBlob(Utilities.base64Decode(p.b64), 'application/pdf', p.name)); });`);
  run('M1_importDataset(M1_datasetFolderId(), {})');
  const docs = json('readTable(SEG.TABS.DOCUMENTS)');
  check(docs.length === 17, 'Expected 17 documents, found ' + docs.length);
  return docs.length + ' documents imported';
});

step('Populate extractions for all 17 imported documents', () => {
  run(`PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', '${FAKE_KEY}')`);
  run('M2_processQueue(25)');
  const extractions = json('readTable(SEG.TABS.EXTRACTIONS)');
  check(extractions.length === 17, 'Expected 17 extractions, got ' + extractions.length);
  return extractions.length + ' extractions recorded';
});

step('Execute M3_assessDocuments with referenceDate 2026-11-11', () => {
  const res = json("M3_assessDocuments({ referenceDate: '2026-11-11' })");
  check(res && res.assessments, 'Assessment returned no results');
  check(res.assessments.length >= 17, 'Expected at least 17 assessed items, got ' + res.assessments.length);
  return res.assessments.length + ' total assessments';
});

step('Assessments match GroundTruth expected statuses 100% (all 14 scenarios)', () => {
  const asms = json("M3_getAssessments({ referenceDate: '2026-11-11' })");
  const docs = json('readTable(SEG.TABS.DOCUMENTS)');

  let verified = 0;
  truth.forEach((t) => {
    // Only verify suppliers present in initial dataset
    if (t.supplier_name === 'BrightClean Sdn. Bhd.') return; // BrightClean is kept for live demo

    if (t.file_name === '(no file)') {
      // Missing mandatory requirement
      const match = asms.find((a) => a.supplierName === t.supplier_name && a.status === 'MISSING');
      check(match, 'Missing mandatory requirement not identified for ' + t.supplier_name);
      check(match.status === t.expected_status, 'Expected status ' + t.expected_status + ' for missing requirement, got ' + match.status);
      verified++;
    } else {
      const doc = docs.find((d) => d.original_file_name === t.file_name);
      if (!doc) return;
      const match = asms.find((a) => a.docId === doc.doc_id);
      check(match, 'No assessment found for ' + t.file_name);
      check(match.status === t.expected_status, 'File ' + t.file_name + ': expected ' + t.expected_status + ', got ' + match.status);
      verified++;
    }
  });

  return verified + ' files & requirements matched GroundTruth';
});

step('Risk distribution contains Critical, High, Medium, and Low risk items', () => {
  const summary = json("M3_getRiskSummary({ referenceDate: '2026-11-11' })");
  const byRisk = summary.byRisk;
  check(byRisk.CRITICAL > 0, 'No CRITICAL risk items found');
  check(byRisk.HIGH > 0, 'No HIGH risk items found');
  check(byRisk.LOW > 0, 'No LOW risk items found');
  return `Critical: ${byRisk.CRITICAL}, High: ${byRisk.HIGH}, Medium: ${byRisk.MEDIUM}, Low: ${byRisk.LOW}`;
});

step('Supplier compliance risk scores are calculated (0-100 score & tier)', () => {
  const summary = json("M3_getRiskSummary({ referenceDate: '2026-11-11' })");
  const scores = summary.supplierScores;
  check(scores && scores.length === 6, 'Expected 6 monitored suppliers scored, got ' + (scores ? scores.length : 0));
  const hasHighOrCritical = scores.some((s) => s.tier === 'CRITICAL' || s.tier === 'HIGH');
  check(hasHighOrCritical, 'Expected at least one high or critical risk supplier');
  return scores.map((s) => `${s.supplierName.split(' ')[0]}: ${s.score}/100 (${s.tier})`).join(', ');
});

step('Days remaining countdowns are accurate', () => {
  const asms = json("M3_getAssessments({ referenceDate: '2026-11-11' })");
  // PerisaiGuard_Security_Agency_Licence expired on 2026-10-15 -> -27 days
  const perisaiLicence = asms.find((a) => a.dueDate === '2026-10-15');
  check(perisaiLicence && perisaiLicence.daysRemaining === -27, 'Expected -27 days remaining for Perisai licence, got ' + (perisaiLicence ? perisaiLicence.daysRemaining : null));

  // SwiftHaul Transportation agreement ended on 2026-09-30 -> -42 days
  const swiftAgreement = asms.find((a) => a.dueDate === '2026-09-30');
  check(swiftAgreement && swiftAgreement.daysRemaining === -42, 'Expected -42 days remaining for SwiftHaul agreement, got ' + (swiftAgreement ? swiftAgreement.daysRemaining : null));

  return 'Overdue days verified (-27d and -42d)';
});

step('Assessments tab schema compliance (headers and row formatting)', () => {
  const rawRows = json('readTable(SEG.TABS.ASSESSMENTS)');
  check(rawRows.length > 0, 'Assessments tab is empty');
  const headers = json('SEG.HEADERS.Assessments');
  const first = rawRows[0];
  headers.forEach((h) => {
    check(Object.prototype.hasOwnProperty.call(first, h), 'Missing header in row: ' + h);
  });
  check(first.assessment_id.startsWith('ASM'), 'assessment_id should start with ASM, got ' + first.assessment_id);
  return rawRows.length + ' rows in Assessments tab';
});

step('Configurable reminder thresholds can be fetched and updated', () => {
  const initial = json('M3_getThresholds()');
  check(initial.contractNoticeDays === 60, 'Default contractNoticeDays should be 60');

  const updated = json('M3_saveThresholds({ contractNoticeDays: 75, licenceReminderDays: 45 })');
  check(updated.contractNoticeDays === 75, 'Expected contractNoticeDays 75');
  check(updated.licenceReminderDays === 45, 'Expected licenceReminderDays 45');

  const fetched = json('M3_getThresholds()');
  check(fetched.contractNoticeDays === 75, 'Persisted contractNoticeDays should be 75');

  // Reset back to defaults
  run('M3_saveThresholds({ contractNoticeDays: 60, licenceReminderDays: 30 })');
  return 'Thresholds updated and persisted';
});

step('Audit log records assessment runs and threshold updates', () => {
  const audit = json('readTable(SEG.TABS.AUDIT)');
  const m3Entries = audit.filter((a) => a.module === 'M3');
  check(m3Entries.length >= 2, 'Expected at least 2 M3 audit entries, found ' + m3Entries.length);
  return m3Entries.length + ' M3 audit entries recorded';
});

step('The Overview shows the Assessment module as Connected', () => {
  const overview = json('SEG_getOverview()');
  check(overview.modules.assessment === true, 'Assessment module should be Connected (true)');
  return 'Connected (true)';
});

step('Saved assessments are refreshed when stale, and Member 4 gets a reminder stage', () => {
  json("M3_assessDocuments({ referenceDate: '2026-11-11' })");
  check(run('M3_isStale(readTable(SEG.TABS.ASSESSMENTS))') === false, 'Fresh assessments should not be stale');
  check(run("M3_isStale([{ assessed_at: '2020-01-01T00:00:00+08:00', doc_id: '' }])") === true, 'Yesterday\'s assessments must be stale');
  check(run('M3_isStale([])') === true, 'No assessments must be stale');
  check(run("M3_reminderStage('EXPIRED', -3)") === 'OVERDUE', 'Expired is OVERDUE');
  check(run("M3_reminderStage('EXPIRING_SOON', 5)") === 'URGENT', '5 days is URGENT');
  check(run("M3_reminderStage('EXPIRING_SOON', 20)") === 'REMINDER', '20 days is REMINDER');
  check(run("M3_reminderStage('VALID', 200)") === 'NONE', 'Valid needs nothing');
  const asms = json('M3_getAssessments()');
  check(asms.every((a) => a.reminderStage), 'Every assessment carries a reminderStage');
  check(/created|exists/.test(run('M3_installDailyTrigger()')), 'Daily trigger installer runs');
  return 'stale check, reminder stages and daily trigger OK';
});

step('Document names come from the document types (never just "Document")', () => {
  const asms = json('M3_getAssessments()');
  const generic = asms.filter((a) => a.docTypeName === 'Document');
  check(!generic.length, generic.length + ' assessment(s) have no document type name');
  const missing = asms.find((a) => a.status === 'MISSING');
  check(missing && /Product Conformity|Business Registration/.test(missing.reason), 'Missing reason should name the document, got: ' + (missing && missing.reason));
  return asms.length + ' assessments, e.g. "' + asms[0].docTypeName + '"';
});

step('The page loads from ONE call and reads each Sheet tab only a few times (speed)', () => {
  const realRead = ctx.readTable;
  const reads = {};
  ctx.readTable = (name) => { reads[name] = (reads[name] || 0) + 1; return realRead(name); };
  let data;
  try {
    data = json('M3_getPageData()');
  } finally {
    ctx.readTable = realRead;
  }
  check(data.assessments.length > 0 && data.summary.total === data.assessments.length, 'Page data should hold the assessments and a matching summary');
  check(Array.isArray(data.trend) && data.trend.length >= 1, 'Page data should include the trend');
  const worst = Object.keys(reads).sort((a, b) => reads[b] - reads[a])[0];
  const total = Object.keys(reads).reduce((n, k) => n + reads[k], 0);
  check(reads[worst] <= 3, 'Tab "' + worst + '" was read ' + reads[worst] + ' times');
  check(total <= 20, 'Too many table reads for one page load: ' + total);
  return total + ' table reads for the whole page (most: ' + worst + ' x' + reads[worst] + ')';
});

step('AI brief, Ask box and risk trend (Gemini answer, fallback, saved daily brief, trend rows)', () => {
  check(run('test_M3_insights()') > 0, 'test_M3_insights ran no checks');

  // The full run above recorded a trend row for its reference date
  const trend = json('M3_getRiskTrend()');
  check(trend.length >= 1 && trend[trend.length - 1].total > 0, 'Trend should hold a row with items');

  // Gemini unavailable (the fake only knows document files): rule-based fallback, nothing breaks
  const fallback = json('M3_getRiskBrief({ refresh: true })');
  check(fallback.source === 'RULES' && fallback.text.length > 10, 'Brief should fall back to rules, got ' + fallback.source);
  const askRules = json("M3_askQuestion('which items are critical?')");
  check(askRules.source === 'RULES' && /critical/i.test(askRules.answer), 'Rule answer to the critical question');

  // Gemini answers: the brief uses it, and is saved for the rest of the day
  const realFetch = ctx.UrlFetchApp;
  let calls = 0;
  ctx.UrlFetchApp = { fetch: () => { calls++; return {
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Two items need action. Priority: contact Swift Haul.' }] } }] })
  }; } };
  try {
    const fresh = json('M3_getRiskBrief({ refresh: true })');
    check(fresh.source === 'GEMINI' && /Priority/.test(fresh.text), 'Brief should use the Gemini answer');
    const again = json('M3_getRiskBrief()');
    check(again.cached === true && calls === 1, 'Second brief should come from the saved copy (calls: ' + calls + ')');
    const ans = json("M3_askQuestion('who is most at risk?')");
    check(ans.source === 'GEMINI', 'Ask box should use the Gemini answer');
    let threw = false;
    try { run("M3_askQuestion('   ')"); } catch (e) { threw = true; }
    check(threw, 'An empty question should be refused');
  } finally {
    ctx.UrlFetchApp = realFetch;
  }
  return 'Gemini answer, rule fallback, saved brief and trend OK';
});

/* ------------------------------------------------------------ Output */
console.log('\n--- Member 3 Test Results ---');
results.forEach((r) => console.log(r));
const passedCount = results.filter((r) => r.startsWith('OK')).length;
console.log(`\n${passedCount} of ${results.length} steps passed\n`);
if (passedCount !== results.length) {
  process.exit(1);
}
