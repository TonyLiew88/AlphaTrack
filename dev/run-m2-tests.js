/**
 * run-m2-tests.js · Development only. Member 2's offline tests.
 *   node dev/run-m2-tests.js
 *
 * Runs the real .gs files on top of mock-google.js, imports the real test dataset
 * (the 17 PDFs in test-pdfs), and replaces Gemini with a FAKE that answers what each
 * PDF really says (taken from the answer key). So these tests check the plumbing and
 * the rules: queue, cache, issues, statuses, retries, failures, corrections, audit.
 * They do NOT measure how well the real Gemini reads; that is done in Apps Script
 * with the real key (Phase 3).
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
const run = (code) => vm.runInContext(code, ctx);
const json = (code) => JSON.parse(run('JSON.stringify(' + code + ')'));

/* ------------------------------------------------------------ The fake Gemini */
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

const fake = { mode: 'answer', calls: [], status: 200 };
// What a perfect reader would answer for each test PDF.
function perfectAnswer(fileName, documentClass) {
  const t = truth.find((r) => r.file_name === fileName);
  if (!t) throw new Error('fake Gemini: unknown file ' + fileName);
  const v = (x) => (x === '' || x === undefined ? null : x);
  const answer = {
    readable: true, holder_name: v(t.holder_name), document_no: v(t.document_no), due_date: v(t.due_date), scope: v(t.scope),
    due_date_candidates: t.due_date ? [t.due_date] : [], uncertain_fields: [], notes: null
  };
  if (documentClass === 'CONTRACT') {
    Object.assign(answer, { client_name: v(t.client_name), start_date: v(t.start_date),
      renewal_notice_days: t.renewal_notice_days ? Number(t.renewal_notice_days) : null, auto_renewal: v(t.auto_renewal) });
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
    const call = { url: url, headers: options.headers, body: body };
    fake.calls.push(call);
    const respond = (code, obj) => ({ getResponseCode: () => code, getContentText: () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });
    if (fake.mode === 'status') return respond(fake.status, fake.body || { error: { message: 'fake error' } });
    if (fake.mode === 'garbage') return respond(200, '<html>not json</html>');
    const parts = body.contents[0].parts;
    if (!parts[0].inlineData) return respond(200, { candidates: [{ content: { parts: [{ text: 'OK' }] } }] });
    const fileName = nameByContent[parts[0].inlineData.data];
    const docClass = /holder_name is the SUPPLIER/.test(parts[1].text) ? 'CONTRACT' : 'OTHER';
    call.fileName = fileName;
    return respond(200, { candidates: [{ content: { parts: [{ text: JSON.stringify(perfectAnswer(fileName, docClass)) }] }, finishReason: 'STOP' }] });
  }
};

/* ------------------------------------------------------------ Steps */
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
const latestRows = () => {
  const rows = json('readTable(SEG.TABS.EXTRACTIONS)');
  const last = {};
  rows.forEach((r) => { last[r.doc_id + '|' + r.file_id] = r; });
  return Object.keys(last).map((k) => last[k]);
};
const fileNameOf = (docId) => json('readTable(SEG.TABS.DOCUMENTS)').find((d) => d.doc_id === docId).original_file_name;
const reviewIssues = (issues) => String(issues || '').split(',').map((s) => s.trim())
  .filter((c) => c && json('M2_ISSUES')[c].effect !== 'INFO').sort().join(',');

step('M2_Client compiles, and Index.html includes the page after OverviewClient', () => {
  const html = fs.readFileSync(path.join(appDir, 'M2_Client.html'), 'utf8');
  new vm.Script(html.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>[\s\S]*$/, ''), { filename: 'M2_Client.html' });
  const index = fs.readFileSync(path.join(appDir, 'Index.html'), 'utf8');
  check(/id="page-ai"[^>]*>\s*<\?!= include\('M2_Page'\); \?>/.test(index), 'M2_Page not inside page-ai');
  check(index.indexOf("include('M2_Client')") > index.indexOf("include('OverviewClient')"), 'M2_Client must come after OverviewClient');
});
step('test_M2_rules (the same test the Apps Script editor runs)', () => run('test_M2_rules()') + ' checks passed');

step('Import the real test dataset: 7 suppliers, 17 PDFs waiting', () => {
  run('SEG_setupDatabase()');
  run(`var __folder = DriveApp.createFolder('test-pdfs');
    var __dir = function (rel) { var f = __folder; rel.split('/').filter(Boolean).forEach(function (part) {
      var it = f.getFoldersByName(part); f = it.hasNext() ? it.next() : f.createFolder(part); }); return f; };
    __pdfs.forEach(function (p) { __dir(p.dir).createFile(Utilities.newBlob(Utilities.base64Decode(p.b64), 'application/pdf', p.name)); });`);
  run('M1_importDataset(M1_datasetFolderId(), {})');
  const waiting = json('M1_getDocumentsAwaitingExtraction()').length;
  check(waiting === 17, waiting + ' waiting');
  return waiting + ' waiting';
});

step('Page before any reading: 17 documents, all waiting, key not set', () => {
  const p = json('M2_getAnalysisPage()');
  check(p.counts.total === 17 && p.counts.waiting === 17 && p.keySet === false, JSON.stringify(p.counts) + ' key ' + p.keySet);
  check(p.documents.every((d) => d.supplierName && d.docTypeName && d.fileUrl && d.fieldNames.length), 'incomplete document entry');
  return JSON.stringify(p.counts);
});

step('Without a key every reading ends FAILED with a clear reason, and nothing crashes', () => {
  const r = json('M2_extractDocument(M1_getDocumentsAwaitingExtraction()[0].docId)');
  check(r.processingStatus === 'FAILED' && /GEMINI_API_KEY/.test(r.message), JSON.stringify(r));
  check(fake.calls.length === 0, 'Gemini was called without a key');
  return r.message;
});

step('A document that failed 3 times (no key) is given up and skipped', () => {
  const docId = json('M1_getDocumentsAwaitingExtraction()[0].docId');
  run(`M2_extractDocument('${docId}'); M2_extractDocument('${docId}')`);
  const r = json(`M2_extractDocument('${docId}')`);
  check(r.outcome === 'SKIPPED' && /failed 3 times/.test(r.message), JSON.stringify(r));
  return docId + ' given up';
});

step('With the key, M2_readOneDocument reads ONE document and does not get stuck on the given-up one', () => {
  run(`PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', '${FAKE_KEY}')`);
  const s = json('M2_readOneDocument()');
  check(s.read === 1 && s.skipped === 1 && fake.calls.length === 1, JSON.stringify(s).slice(0, 300));
  return 'skipped ' + s.results[0].docId + ', read ' + s.results[1].docId;
});

step('M2_retryFailedDocuments reads the given-up document again after the cause is fixed', () => {
  const s = json('M2_retryFailedDocuments()');
  check(s.failedBefore === 1 && s.retried === 1 && s.stillFailed === 0 && fake.calls.length === 2, JSON.stringify(s).slice(0, 300));
  return s.results[0].docId + ' ' + s.results[0].processingStatus;
});

step('M2_processQueue reads the other 15; all 17 are read with 17 Gemini calls in total', () => {
  const s = json('M2_processQueue()');
  check(s.waiting === 15 && s.read === 15 && s.failed === 0, JSON.stringify(s).slice(0, 300));
  check(fake.calls.length === 17, fake.calls.length + ' Gemini calls');
  return s.read + ' read now, ' + fake.calls.length + ' Gemini calls in total';
});

step('The request: key in a header (not the URL), default model, temperature 0, a JSON schema', () => {
  const c = fake.calls[0];
  check(c.url.indexOf(FAKE_KEY) === -1 && c.headers['x-goog-api-key'] === FAKE_KEY, 'key placement');
  check(/\/models\/gemini-flash-latest:generateContent$/.test(c.url), c.url);
  check(c.body.generationConfig.temperature === 0 && c.body.generationConfig.responseMimeType === 'application/json' &&
    c.body.generationConfig.responseSchema.type === 'OBJECT', 'generationConfig');
  return c.url.replace(/^.*\/models\//, '');
});

step('Every document\'s issues match the answer key (17 of 17)', () => {
  const wrong = [];
  latestRows().forEach((r) => {
    const t = truth.find((g) => g.file_name === fileNameOf(r.doc_id));
    const want = String(t.expected_issues || '').split(',').map((s) => s.trim()).filter(Boolean).sort().join(',');
    if (reviewIssues(r.issues) !== want) wrong.push(t.file_name + ': got "' + r.issues + '", want "' + want + '"');
  });
  check(wrong.length === 0, wrong.join(' | '));
  return '17 of 17';
});

step('test_M2_accuracy scores a perfect reader 100 % on fields and 17 of 17 on issues', () => {
  const r = json('test_M2_accuracy()');
  check(r.docsTotal === 17 && r.docsRight === 17 && r.fieldsRight === r.fieldsTotal && r.notRead.length === 0,
    JSON.stringify(r).slice(0, 400));
  return r.fieldsRight + ' of ' + r.fieldsTotal + ' fields, ' + r.docsRight + ' of ' + r.docsTotal + ' documents';
});

step('test_M2_accuracy catches a wrong date, a wrong name and a guessed value on the blurred scan', () => {
  const r = json(`(function () {
    const docs = readTable(SEG.TABS.DOCUMENTS);
    const id = (name) => docs.find(d => d.original_file_name === name).doc_id;
    const rows = readTable(SEG.TABS.EXTRACTIONS).map(x => {
      const j = JSON.parse(x.extracted_json);
      if (x.doc_id === id('KilatShine_Insurance_Certificate.pdf')) j.due_date = '2099-01-01';
      if (x.doc_id === id('Mutiara_ISO_9001_Certificate.pdf')) j.holder_name = 'Some Other Company Sdn Bhd';
      if (x.doc_id === id('Cahaya_Insurance_Certificate_scan.pdf')) j.document_no = 'GUESSED-123';
      return Object.assign({}, x, { extracted_json: JSON.stringify(j) });
    });
    return M2_measureAccuracy(readTable(SEG.TABS.GROUND_TRUTH), docs, rows);
  })()`);
  check(r.fieldsTotal - r.fieldsRight === 3, (r.fieldsTotal - r.fieldsRight) + ' wrong fields found, want 3');
  check(r.lines.filter((l) => l.indexOf('CHECK') === 0).length === 3, r.lines.join(' | '));
  return r.fieldsRight + ' of ' + r.fieldsTotal;
});

step('The 6 required cases end as the brief says', () => {
  const byFile = {};
  latestRows().forEach((r) => { byFile[fileNameOf(r.doc_id)] = r; });
  const f = (n) => byFile[n];
  const j = (n) => JSON.parse(f(n).extracted_json);
  check(f('Voltline_Contractor_Registration.pdf').issues === 'NAME_MISMATCH', 'name mismatch');
  check(f('Voltline_Electrical_Competency_Certificate.pdf').issues === 'MISSING_EXPIRY' && j('Voltline_Electrical_Competency_Certificate.pdf').due_date === null, 'missing expiry');
  check(f('SwiftHaul_Insurance_Certificate.pdf').issues === 'CONFLICTING_DATES' && j('SwiftHaul_Insurance_Certificate.pdf').due_date === null, 'conflicting dates');
  check(f('Cahaya_Insurance_Certificate_scan.pdf').processing_status === 'NEEDS_REVIEW' && f('Cahaya_Insurance_Certificate_scan.pdf').issues === 'UNREADABLE', 'unreadable');
  check(f('Voltline_Electrical_Maintenance_Agreement.pdf').issues === 'MISSING_CONTRACT_END_DATE' &&
    f('Voltline_Electrical_Maintenance_Agreement.pdf').processing_status === 'EXTRACTED', 'open-ended contract');
  check(j('KilatShine_Cleaning_Service_Agreement.pdf').auto_renewal === 'YES', 'auto renewal');
  check(!('client_name' in j('KilatShine_Insurance_Certificate.pdf')) && 'client_name' in j('KilatShine_Cleaning_Service_Agreement.pdf'), 'fields per class');
  return 'name, expiry, conflict, unreadable, open-ended, auto-renewal';
});

step('Page after reading: 13 read, 4 need review (name, expiry, conflict, unreadable), 0 failed, 0 waiting', () => {
  const p = json('M2_getAnalysisPage()');
  check(p.keySet === true, 'key not seen');
  check(p.counts.ok === 13 && p.counts.review === 4 && p.counts.failed === 0 && p.counts.waiting === 0, JSON.stringify(p.counts));
  const review = p.documents.filter((d) => d.state === 'REVIEW').map((d) => d.issues.map((i) => i.code).join('+')).sort().join(', ');
  check(review === 'CONFLICTING_DATES, MISSING_EXPIRY, NAME_MISMATCH, UNREADABLE', review);
  const open = p.documents.find((d) => d.fileName === 'Voltline_Electrical_Maintenance_Agreement.pdf');
  check(open.state === 'OK' && open.issues[0].effect === 'INFO', 'an open-ended contract must not need review');
  const swift = p.documents.find((d) => d.fileName === 'SwiftHaul_Insurance_Certificate.pdf');
  check(swift.conflictingDates.join() === '2026-11-30,2027-11-30', 'conflicting dates not shown: ' + swift.conflictingDates);
  return JSON.stringify(p.counts);
});

step('Suppliers move to Active monitoring once every mandatory document is read', () => {
  const list = json('M1_listSuppliers()');
  const want = {
    'Kilat Shine Services Sdn. Bhd.': 'ACTIVE_MONITORING', 'Perisai Guard Security Sdn. Bhd.': 'ACTIVE_MONITORING',
    'Voltline Electrical Engineering Sdn. Bhd.': 'ACTIVE_MONITORING', 'Swift Haul Logistics Sdn. Bhd.': 'ACTIVE_MONITORING',
    'Cahaya Facility Services Sdn. Bhd.': 'PENDING_VERIFICATION', 'Mutiara Components Sdn. Bhd.': 'PENDING_DOCUMENTS',
    'Kencana Microparts Sdn. Bhd.': 'DRAFT'
  };
  const wrong = Object.keys(want).filter((n) => list.find((s) => s.supplierName === n).registrationStatus !== want[n]);
  check(wrong.length === 0, 'wrong: ' + wrong.join(', '));
  return '4 active, Cahaya waits for the unreadable scan';
});

step('A second run calls Gemini 0 times (cache), and the unreadable scan is not re-sent', () => {
  const before = fake.calls.length;
  const s = json('M2_processQueue()');
  check(fake.calls.length === before, (fake.calls.length - before) + ' extra calls');
  check(s.waiting === 1 && s.cached === 1, JSON.stringify(s).slice(0, 200));
  return s.waiting + ' still waiting (the scan, cached as NEEDS_REVIEW)';
});

step('Audit log: one EXTRACTION_DONE per reading, and the key appears in no tab', () => {
  const done = json("readTable(SEG.TABS.AUDIT).filter(a => a.module === 'M2' && a.action === 'EXTRACTION_DONE')").length;
  check(done === 17, done + ' audit lines');
  const dump = run("JSON.stringify(Object.keys(SEG.HEADERS).map(t => readTable(t)))");
  check(dump.indexOf(FAKE_KEY) === -1, 'the key was written into a tab');
  return done + ' audit lines';
});

step('HTTP 500 is tried 3 times, then saved as FAILED with the reason', () => {
  const docId = json("readTable(SEG.TABS.DOCUMENTS).find(d => d.original_file_name === 'Cahaya_Insurance_Certificate_scan.pdf').doc_id");
  fake.mode = 'status'; fake.status = 500;
  const before = fake.calls.length;
  const r = json(`M2_reanalyse('${docId}')`);
  check(fake.calls.length - before === 3, (fake.calls.length - before) + ' tries');
  check(r.processingStatus === 'FAILED' && /HTTP 500/.test(r.message), JSON.stringify(r));
  return r.message;
});

step('HTTP 403 (bad key) is tried once only', () => {
  const docId = json("readTable(SEG.TABS.DOCUMENTS).find(d => d.original_file_name === 'Cahaya_Insurance_Certificate_scan.pdf').doc_id");
  fake.status = 403;
  const before = fake.calls.length;
  const r = json(`M2_extractDocument('${docId}')`);
  check(fake.calls.length - before === 1 && /API key/.test(r.message), JSON.stringify(r));
  return r.message;
});

step('A broken (non-JSON) answer is FAILED, and after 3 failures the queue stops trying', () => {
  const docId = json("readTable(SEG.TABS.DOCUMENTS).find(d => d.original_file_name === 'Cahaya_Insurance_Certificate_scan.pdf').doc_id");
  fake.mode = 'garbage';
  const r = json(`M2_extractDocument('${docId}')`);
  check(r.processingStatus === 'FAILED' && /not JSON/.test(r.message), JSON.stringify(r));
  const before = fake.calls.length;
  const again = json(`M2_extractDocument('${docId}')`);
  check(again.outcome === 'SKIPPED' && fake.calls.length === before, JSON.stringify(again));
  const page = json('M2_getAnalysisPage()').documents.find((d) => d.docId === docId);
  // The earlier NEEDS_REVIEW reading still counts; the failed attempts are only mentioned.
  check(page.state === 'REVIEW' && page.gaveUp === true && /not JSON/.test(page.lastAttemptError) && page.issues[0].code === 'UNREADABLE',
    'page: ' + JSON.stringify(page).slice(0, 300));
  fake.mode = 'answer';
  return again.message;
});

step('HTTP 429 per minute: waits as long as Gemini asks (here 7 s), keeps the good reading on the page', () => {
  const docId = json("readTable(SEG.TABS.DOCUMENTS).find(d => d.original_file_name === 'Mutiara_ISO_9001_Certificate.pdf').doc_id");
  const sleeps = [];
  run('var __sleep = Utilities.sleep');
  ctx.__record = (ms) => sleeps.push(ms);
  run('Utilities.sleep = function (ms) { __record(ms); }');
  fake.mode = 'status'; fake.status = 429;
  fake.body = { error: { code: 429, details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '7s' }] } };
  const before = fake.calls.length;
  const r = json(`M2_reanalyse('${docId}')`);
  check(fake.calls.length - before === 3 && sleeps.join() === '8000,8000', 'tries ' + (fake.calls.length - before) + ', sleeps ' + sleeps.join());
  check(r.processingStatus === 'FAILED' && /PerMinute/.test(r.message) && /in a minute/.test(r.message), r.message);
  const page = json('M2_getAnalysisPage()').documents.find((d) => d.docId === docId);
  check(page.state === 'OK' && page.processingStatus === 'EXTRACTED' && /PerMinute/.test(page.lastAttemptError), JSON.stringify(page).slice(0, 300));
  const reading = json(`(function () { const d = readTable(SEG.TABS.DOCUMENTS).find(x => x.doc_id === '${docId}'); return M2_latestReading(d.doc_id, d.file_id); })()`);
  check(reading.processingStatus === 'EXTRACTED' && reading.fields.holder_name, 'M2_latestReading must skip the failed row');
  return 'slept ' + sleeps.join(' + ') + ' ms, page still shows the good reading';
});

step('HTTP 429 per day: stops after one try with a clear message', () => {
  const docId = json("readTable(SEG.TABS.DOCUMENTS).find(d => d.original_file_name === 'Mutiara_ISO_9001_Certificate.pdf').doc_id");
  fake.body.error.details[0].violations[0].quotaId = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';
  const before = fake.calls.length;
  const r = json(`M2_reanalyse('${docId}')`);
  check(fake.calls.length - before === 1 && /DAILY/.test(r.message), 'tries ' + (fake.calls.length - before) + ': ' + r.message);
  fake.mode = 'answer'; fake.body = null;
  run('Utilities.sleep = __sleep');
  return r.message.slice(0, 80) + '...';
});

step('Page Re-analyse button: reads again, keeps the old reading, refuses an unknown document', () => {
  const docId = json("readTable(SEG.TABS.DOCUMENTS).find(d => d.original_file_name === 'Mutiara_Supply_Agreement.pdf').doc_id");
  const before = fake.calls.length;
  const out = json(`M2_pageReanalyse('${docId}')`);
  check(fake.calls.length === before + 1 && out.result.processingStatus === 'EXTRACTED' && out.page.documents.length === 17, JSON.stringify(out.result));
  const rows = json(`readTable(SEG.TABS.EXTRACTIONS).filter(x => x.doc_id === '${docId}')`).length;
  check(rows === 2, rows + ' rows (the old reading must stay as history)');
  let msg = '';
  try { run(`M2_pageReanalyse('DOC999')`); } catch (e) { msg = e.message; }
  check(/No document/.test(msg), 'unknown document not refused: ' + msg);
  return 'history kept: ' + rows + ' readings';
});

step('An officer correction saves CORRECTED, logs what changed, and activates the supplier', () => {
  const docId = json("readTable(SEG.TABS.DOCUMENTS).find(d => d.original_file_name === 'Cahaya_Insurance_Certificate_scan.pdf').doc_id");
  let msg = '';
  try { run(`M2_correctExtraction('${docId}', { due_date: '31/05/2027' }, 'typo')`); } catch (e) { msg = e.message; }
  check(/YYYY-MM-DD/.test(msg), 'bad date not refused: ' + msg);
  try { run(`M2_correctExtraction('${docId}', { due_date: '2027-05-31' }, '  ')`); } catch (e) { msg = e.message; }
  check(/note/.test(msg), 'empty note not refused');
  const r = json(`M2_correctExtraction('${docId}', { holder_name: 'Cahaya Facility Services Sdn. Bhd.', document_no: 'PAY-PL-2026-58830',
    issuing_body: 'Payung Insurance Berhad (simulated insurer)', issue_date: '2026-06-01', due_date: '2027-05-31' }, 'Read from the paper copy')`);
  check(r.processingStatus === 'CORRECTED' && r.issues.length === 0, JSON.stringify(r));
  const audit = json("readTable(SEG.TABS.AUDIT).filter(a => a.action === 'EXTRACTION_CORRECTED')");
  check(audit.length === 1 && JSON.parse(audit[0].details).changed.length === 5, 'audit');
  const cahaya = json('M1_listSuppliers()').find((s) => s.supplierName === 'Cahaya Facility Services Sdn. Bhd.');
  check(cahaya.registrationStatus === 'ACTIVE_MONITORING', cahaya.registrationStatus);
  check(json('M1_getDocumentsAwaitingExtraction()').length === 0, 'queue not empty');
  const page = json('M2_getAnalysisPage()').documents.find((d) => d.docId === docId);
  check(page.state === 'OK' && page.processingStatus === 'CORRECTED' && page.correctionNote === 'Read from the paper copy' && page.correctedBy, 'page view');
  return '5 fields changed, Cahaya now active, queue empty';
});

step('Page Correct form: a name the officer leaves different keeps NAME_MISMATCH', () => {
  const docId = json("readTable(SEG.TABS.DOCUMENTS).find(d => d.original_file_name === 'Voltline_Contractor_Registration.pdf').doc_id");
  const out = json(`M2_pageCorrect('${docId}', {}, 'Checked: the name really is printed like this')`);
  check(out.result.changed.length === 0 && out.result.issues.join() === 'NAME_MISMATCH', JSON.stringify(out.result));
  check(out.page.documents.find((d) => d.docId === docId).state === 'REVIEW', 'should still need review');
  return 'still needs review';
});

step('M2_rereadOutdated reads again only what an older prompt read, never an officer correction', () => {
  check(json('M2_rereadOutdated()').outdated === 0, 'readings of the current prompt counted as outdated');
  // Make two readings look as if the old prompt (no prompt_version) had made them.
  run(`(function () {
    const docs = readTable(SEG.TABS.DOCUMENTS);
    const ids = ['KilatShine_Insurance_Certificate.pdf', 'Voltline_Electrical_Maintenance_Agreement.pdf']
      .map(n => docs.find(d => d.original_file_name === n).doc_id);
    readTable(SEG.TABS.EXTRACTIONS).forEach(x => {
      if (ids.indexOf(x.doc_id) === -1) return;
      const j = JSON.parse(x.extracted_json); delete j.prompt_version;
      updateRow(SEG.TABS.EXTRACTIONS, x._row, { extracted_json: JSON.stringify(j) });
    });
  })()`);
  const before = fake.calls.length;
  const r = json('M2_rereadOutdated()');
  check(r.outdated === 2 && r.reread === 2 && r.left === 0 && fake.calls.length === before + 2, JSON.stringify(r).slice(0, 300));
  check(json('M2_rereadOutdated()').outdated === 0, 'a second run should find nothing');
  return '2 read again, the corrected Cahaya scan left alone';
});

step('The Overview shows the AI module as Connected', () => {
  check(json('SEG_getOverview()').modules.extraction === true, 'not connected');
});

console.log(results.join('\n'));
const failed = results.filter((r) => r.indexOf('FAILED') === 0).length;
console.log('\n' + (results.length - failed) + ' of ' + results.length + ' steps passed');
process.exit(failed ? 1 : 0);
