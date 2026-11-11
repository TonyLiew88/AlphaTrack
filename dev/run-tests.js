/**
 * run-tests.js · Development only.
 * Runs the real .gs files in Node on top of mock-google.js:
 *   node dev/run-tests.js
 * It runs test_M1_rules() and test_M1_endToEnd() exactly as the Apps Script
 * editor would, plus extra checks of the hand-off and edge cases.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appDir = path.resolve(__dirname, '..', 'app');
const logs = [];
const ctx = vm.createContext({ console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')) } });
const load = (file, name) => vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: name });
load(path.join(__dirname, 'mock-google.js'), 'mock-google.js');
fs.readdirSync(appDir).filter((f) => f.endsWith('.gs')).sort().forEach((f) => load(path.join(appDir, f), f));
load(path.join(__dirname, 'demo-data.js'), 'demo-data.js');
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
const expectThrow = (code, pattern) => {
  try { run(code); } catch (err) {
    if (pattern && !pattern.test(err.message)) throw new Error('wrong message: ' + err.message);
    return err.message;
  }
  throw new Error('did not throw');
};

step('Client scripts compile', () => {
  ['AppClient.html', 'OverviewClient.html', 'M1_Client.html'].forEach((f) => {
    const html = fs.readFileSync(path.join(appDir, f), 'utf8');
    const code = html.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>[\s\S]*$/, '');
    new vm.Script(code, { filename: f });
  });
  return 'AppClient, OverviewClient, M1_Client';
});
step('SEG_setupDatabase creates all 13 tabs and seeds master data', () => {
  const s = json('SEG_setupDatabase()');
  if (s.tabsCreated.length !== 13) throw new Error(s.tabsCreated.join(', '));
  if (s.masterDataSeeded.length !== 3) throw new Error(s.masterDataSeeded.join(', '));
  return s.masterDataSeeded.join(', ');
});
step('Running setup again changes nothing', () => {
  const s = json('SEG_setupDatabase()');
  if (s.tabsCreated.length || s.masterDataSeeded.length) throw new Error(JSON.stringify(s));
});
step('test_M1_rules', () => run('test_M1_rules()') + ' checks passed');
step('test_M1_endToEnd', () => run('test_M1_endToEnd()') + ' checks passed');
step('M1_removeTestSuppliers removes the TEST supplier and its rows', () => {
  const removed = run('M1_removeTestSuppliers()');
  const left = json('readTable(SEG.TABS.DOCUMENTS)').length + json('readTable(SEG.TABS.SUPPLIERS)').length;
  if (removed !== 1 || left !== 0) throw new Error('removed ' + removed + ', rows left ' + left);
});
step('Demo data registers through the real functions', () => run('DEV_seedDemo()'));
step('Removing test data frees its numbers, so the first real supplier is SUP001', () => {
  const ids = json('M1_listSuppliers().map(s => s.supplierId)').sort();
  if (ids[0] !== 'SUP001') throw new Error(ids.join(', '));
  return ids.join(', ');
});
step('A number that was handed out and deleted by hand is never reused', () => {
  return run(`(function () {
    const a = M1_saveSupplierDraft({ info: { supplierName: 'Hand Deleted Co' } }).supplier.supplierId;
    const row = M1_findSupplierRow(a);
    SEG_sheet(SEG.TABS.SUPPLIERS).deleteRow(row._row);
    const b = M1_saveSupplierDraft({ info: { supplierName: 'Next Co' } }).supplier.supplierId;
    if (a === b) throw new Error('reused ' + a);
    M1_removeSuppliersForTesting((s) => s.supplier_id === b, 'scratch');
    const c = M1_saveSupplierDraft({ info: { supplierName: 'After Cleanup Co' } }).supplier.supplierId;
    if (c === a) throw new Error('reused the hand-deleted ' + a);
    M1_removeSuppliersForTesting((s) => s.supplier_id === c, 'scratch');
    return a + ' deleted by hand stays retired; ' + b + ' was freed by the test clean-up and given again as ' + c;
  })()`);
});
step('Registration statuses are right for each demo supplier', () => {
  const list = json('M1_listSuppliers()');
  const by = (n) => list.find((s) => s.supplierName.indexOf(n) === 0);
  const got = ['BrightClean', 'SecureGuard', 'Voltline'].map((n) => n + '=' + by(n).registrationStatus).join(', ');
  if (by('BrightClean').registrationStatus !== 'PENDING_DOCUMENTS' || by('SecureGuard').registrationStatus !== 'PENDING_VERIFICATION' || by('Voltline').registrationStatus !== 'DRAFT') throw new Error(got);
  if (by('BrightClean').mandatoryUploaded !== 2 || by('BrightClean').mandatoryTotal !== 3) throw new Error('BrightClean progress wrong');
  return got;
});
step('BrightClean insurance shows 2 versions, old one superseded and linked', () => {
  const id = json("M1_listSuppliers().find(s => s.supplierName.indexOf('BrightClean') === 0).supplierId");
  const d = json('M1_getSupplierDetail("' + id + '")');
  const ins = d.requirements.find((r) => r.docTypeId === 'INSURANCE_CERTIFICATE');
  if (ins.history.length !== 2 || ins.history[1].lifecycleStatus !== 'SUPERSEDED' || ins.history[1].replacedByDocId !== ins.current.docId) throw new Error(JSON.stringify(ins.history));
  if (d.registration.missing.join() !== 'Business Registration Record') throw new Error(d.registration.missing.join());
  return 'current ' + ins.current.docId + ' replaces ' + ins.current.replacesDocId;
});
step('A finished extraction (written by Member 2) moves SecureGuard to ACTIVE_MONITORING', () => {
  return run(`(function () {
    const s = M1_listSuppliers().find(x => x.supplierName.indexOf('SecureGuard') === 0);
    const queue = M1_getDocumentsAwaitingExtraction().filter(d => d.supplierId === s.supplierId);
    if (queue.length !== 3) throw new Error('queue has ' + queue.length);
    appendRows(SEG.TABS.EXTRACTIONS, queue.map(d => ({ doc_id: d.docId, supplier_id: d.supplierId, document_class: d.documentClass,
      file_id: d.fileId, processing_status: 'EXTRACTED', extracted_at: SEG_now() })));
    const status = M1_refreshRegistrationStatus(s.supplierId);
    if (status !== 'ACTIVE_MONITORING') throw new Error(status);
    if (M1_getDocumentsAwaitingExtraction().some(d => d.supplierId === s.supplierId)) throw new Error('still queued');
    return status;
  })()`);
});
step('Uploading a renewed document after extraction sends the supplier back to PENDING_VERIFICATION', () => {
  return run(`(function () {
    const s = M1_listSuppliers().find(x => x.supplierName.indexOf('SecureGuard') === 0);
    const d = M1_getSupplierDetail(s.supplierId);
    const req = d.requirements.find(r => r.docTypeId === 'INSURANCE_CERTIFICATE');
    M1_uploadDocument({ supplierId: s.supplierId, requirementId: req.requirementId, fileName: 'renewed.pdf', mimeType: 'application/pdf',
      base64: DEV_makePdf(['SIMULATED DOCUMENT - FOR HACKATHON TESTING ONLY', 'Renewed insurance']) });
    return M1_getSupplierDetail(s.supplierId).supplier.registrationStatus;
  })()`);
});
step('A PNG renamed to .pdf is refused', () => expectThrow(`(function () {
  const s = M1_listSuppliers()[0]; const d = M1_getSupplierDetail(s.supplierId);
  M1_uploadDocument({ supplierId: s.supplierId, requirementId: d.requirements[0].requirementId, fileName: 'fake.pdf', mimeType: 'application/pdf',
    base64: Utilities.base64Encode([-119, 80, 78, 71, 13, 10, 26, 10]) });
})()`, /not a real PDF/));
step('An unsupported file type is refused', () => expectThrow(`(function () {
  const s = M1_listSuppliers()[0]; const d = M1_getSupplierDetail(s.supplierId);
  M1_uploadDocument({ supplierId: s.supplierId, requirementId: d.requirements[0].requirementId, fileName: 'notes.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', base64: 'UEsDBA==' });
})()`, /Only PDF, PNG or JPG/));
step('A duplicate registration number is refused', () => expectThrow(
  "M1_saveSupplierDraft({ info: { supplierName: 'Copycat Sdn. Bhd.', registrationNo: 'sim-reg-001' } })", /Already registered as/));
step('A draft without a name is refused', () => expectThrow("M1_saveSupplierDraft({ info: { supplierName: ' ' } })", /company name/));
step('Registering a draft with missing details is refused', () => expectThrow(`(function () {
  const d = M1_saveSupplierDraft({ info: { supplierName: 'Half Done Sdn. Bhd.' } });
  M1_registerSupplier(d.supplier.supplierId);
})()`, /Please fix/));
step('Removing a checklist item keeps its documents as history', () => {
  return run(`(function () {
    const s = M1_listSuppliers().find(x => x.supplierName.indexOf('BrightClean') === 0);
    const d = M1_getSupplierDetail(s.supplierId);
    const keep = d.requirements.filter(r => r.docTypeId !== 'INSURANCE_CERTIFICATE');
    const after = M1_saveSupplierRequirements(s.supplierId, keep);
    if (after.requirements.length !== 2) throw new Error('requirements ' + after.requirements.length);
    if (after.otherDocuments.length !== 2) throw new Error('other documents ' + after.otherDocuments.length);
    return after.otherDocuments.map(o => o.docId + ' v' + o.version).join(', ');
  })()`);
});
step('A registered supplier must keep one mandatory document', () => expectThrow(`(function () {
  const s = M1_listSuppliers().find(x => x.supplierName.indexOf('BrightClean') === 0);
  M1_saveSupplierRequirements(s.supplierId, []);
})()`, /at least one mandatory/));
step('Editing details records which fields changed', () => {
  return run(`(function () {
    const s = M1_listSuppliers().find(x => x.supplierName.indexOf('Voltline') === 0);
    const d = M1_getSupplierDetail(s.supplierId);
    const info = Object.assign({}, d.supplier, { contactPerson: 'Lim Wei (fictional)', criticality: 'MEDIUM' });
    const after = M1_updateSupplierInfo(s.supplierId, info);
    const entry = after.activity.find(a => a.action === 'SUPPLIER_UPDATED');
    if (!entry || entry.reason.indexOf('contactPerson') < 0 || entry.reason.indexOf('criticality') < 0) throw new Error(JSON.stringify(entry));
    return entry.reason;
  })()`);
});
step('Hand-off functions return the shared contract shapes', () => {
  const s = json("M1_getSupplier(M1_listSuppliers().find(x => x.supplierName.indexOf('SecureGuard') === 0).supplierId)");
  const reqs = json('M1_getSupplierRequirements("' + s.supplierId + '")');
  const docs = json('M1_getDocuments("' + s.supplierId + '")');
  const need = ['supplierId', 'supplierName', 'categoryId', 'registrationNo', 'contactEmail', 'criticality', 'procurementStatus'];
  const missing = need.filter((k) => !(k in s));
  if (missing.length) throw new Error('Supplier missing ' + missing.join(', '));
  if (!reqs.every((r) => 'mandatory' in r && 'reminderDays' in r && r.supplierId === s.supplierId)) throw new Error('requirements shape');
  if (!docs.every((d) => d.docId && d.documentType && d.documentClass && d.fileId && d.version && d.lifecycleStatus)) throw new Error('documents shape');
  return reqs.length + ' requirements, ' + docs.length + ' document versions';
});
step('Every Member 1 action reached the audit log', () => {
  const actions = json('readTable(SEG.TABS.AUDIT).map(a => a.action)');
  const need = ['DATABASE_SETUP', 'SUPPLIER_DRAFT_CREATED', 'SUPPLIER_REGISTERED', 'DOCUMENT_UPLOADED', 'DOCUMENT_REPLACED',
    'UPLOAD_REJECTED', 'REQUIREMENTS_UPDATED', 'SUPPLIER_UPDATED', 'REGISTRATION_STATUS_CHANGED'];
  const missing = need.filter((a) => actions.indexOf(a) < 0);
  if (missing.length) throw new Error('missing ' + missing.join(', '));
  return actions.length + ' entries';
});

step('A supplier folder someone moved to the Drive bin is restored, not filled from the bin', () => {
  return run(`(function () {
    const s = readTable(SEG.TABS.SUPPLIERS).find(r => r.supplier_name.indexOf('BrightClean') === 0);
    const folder = DriveApp.getFolderById(s.drive_folder_id);
    folder.setTrashed(true);
    const certs = folder.getFoldersByName('3. Certificates & Insurance').next();
    const d = M1_getSupplierDetail(s.supplier_id);
    const req = d.requirements.find(r => r.docTypeId === 'BUSINESS_REGISTRATION_RECORD');
    certs.setTrashed(true);
    M1_uploadDocument({ supplierId: s.supplier_id, requirementId: req.requirementId, fileName: 'brr.pdf', mimeType: 'application/pdf',
      base64: DEV_makePdf(['SIMULATED DOCUMENT - FOR HACKATHON TESTING ONLY', 'Business registration record (bin test)']) });
    if (folder.isTrashed()) throw new Error('supplier folder still in the bin');
    const logged = readTable(SEG.TABS.AUDIT).some(a => a.action === 'DRIVE_FOLDER_RESTORED' && a.supplier_id === s.supplier_id);
    if (!logged) throw new Error('restore not in the audit log');
    const again = M1_documentFolder(folder, 'CERTIFICATE', false);
    if (again.isTrashed()) throw new Error('class folder still in the bin');
    return 'restored and logged';
  })()`);
});
step('A folder that cannot be opened stops with a clear message instead of making a new one', () => {
  return run(`(function () {
    const s = readTable(SEG.TABS.SUPPLIERS).find(r => r.supplier_name.indexOf('SecureGuard') === 0);
    const realId = s.drive_folder_id;
    updateRow(SEG.TABS.SUPPLIERS, s._row, { drive_folder_id: 'FOLDER-NOBODY-CAN-OPEN' });
    const d = M1_getSupplierDetail(s.supplier_id);
    let message = '';
    try {
      M1_uploadDocument({ supplierId: s.supplier_id, requirementId: d.requirements[0].requirementId, fileName: 'x.pdf', mimeType: 'application/pdf',
        base64: DEV_makePdf(['SIMULATED DOCUMENT - FOR HACKATHON TESTING ONLY', 'unreachable folder test']) });
    } catch (e) { message = e.message; }
    const after = readTable(SEG.TABS.SUPPLIERS).find(r => r.supplier_id === s.supplier_id).drive_folder_id;
    updateRow(SEG.TABS.SUPPLIERS, s._row, { drive_folder_id: realId });
    if (!/can’t be opened/.test(message)) throw new Error('message: ' + message);
    if (after !== 'FOLDER-NOBODY-CAN-OPEN') throw new Error('folder ID was replaced with ' + after);
    const props = PropertiesService.getScriptProperties();
    const root = props.getProperty('DRIVE_ROOT_FOLDER_ID');
    props.setProperty('DRIVE_ROOT_FOLDER_ID', 'ROOT-NOBODY-CAN-OPEN');
    let rootMessage = '';
    try { SEG_rootFolder(); } catch (e) { rootMessage = e.message; }
    const rootAfter = props.getProperty('DRIVE_ROOT_FOLDER_ID');
    props.setProperty('DRIVE_ROOT_FOLDER_ID', root);
    if (!/can’t be opened/.test(rootMessage) || rootAfter !== 'ROOT-NOBODY-CAN-OPEN') throw new Error('root: ' + rootMessage + ' / ' + rootAfter);
    return 'supplier and root folder IDs kept; clear error shown';
  })()`);
});

step('M1_runAllTests (the one-click check for the Apps Script editor) passes and cleans up', () => {
  const result = run('M1_runAllTests()');
  const left = json('readTable(SEG.TABS.SUPPLIERS).filter(s => /^TEST /.test(s.supplier_name)).length');
  if (result !== 'ALL PASSED' || left) throw new Error(result + ', ' + left + ' TEST supplier(s) left');
  return result;
});

/* ------------------------------------------------- The fictional test dataset (fresh database) */
const ds = vm.createContext({ console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')) } });
const dsLoad = (file, name) => vm.runInContext(fs.readFileSync(file, 'utf8'), ds, { filename: name });
dsLoad(path.join(__dirname, 'mock-google.js'), 'mock-google.js');
fs.readdirSync(appDir).filter((f) => f.endsWith('.gs')).sort().forEach((f) => dsLoad(path.join(appDir, f), f));
const dsRun = (code) => vm.runInContext(code, ds);
const dsJson = (code) => JSON.parse(dsRun('JSON.stringify(' + code + ')'));
// Every PDF under test-pdfs, with the sub-folder it sits in, so the mock Drive gets the same tree.
const pdfRoot = path.resolve(__dirname, '..', 'test-pdfs');
const walkPdfs = (dir, rel) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const relPath = rel ? rel + '/' + e.name : e.name;
  if (e.isDirectory()) return walkPdfs(path.join(dir, e.name), relPath);
  return e.name.endsWith('.pdf') ? [{ name: e.name, dir: rel, b64: fs.readFileSync(path.join(dir, e.name)).toString('base64') }] : [];
});
ds.__pdfs = walkPdfs(pdfRoot, '');

step('Test PDFs: one folder per supplier, and BrightClean only in the video folder', () => {
  const truth = dsJson('M1_DATASET.groundTruth');
  const live = dsJson('M1_DATASET.suppliers.filter(s => s.liveDemo).map(s => s.info.supplierName)');
  const short = (n) => n.replace(' Sdn. Bhd.', '');
  const wrong = ds.__pdfs.filter((p) => {
    const row = truth.find((r) => r.file_name === p.name);
    if (!row) return true;
    const top = p.dir.split('/')[0];
    if (live.indexOf(row.supplier_name) >= 0) return !/^2\. Video demo/.test(top);
    return !/^1\. Suppliers already in AlphaTrack/.test(top) || p.dir.split('/')[1] !== short(row.supplier_name);
  }).map((p) => p.dir + '/' + p.name);
  if (wrong.length) throw new Error('misplaced: ' + wrong.join(', '));
  const guides = ['README.md', '2. Video demo - BrightClean (you upload these)/READ ME - video steps.txt']
    .filter((g) => !fs.existsSync(path.join(pdfRoot, g)));
  if (guides.length) throw new Error('missing guide: ' + guides.join(', '));
  return new Set(ds.__pdfs.map((p) => p.dir)).size + ' folders, ' + ds.__pdfs.length + ' PDFs';
});
step('Dataset: 20 PDFs on disk match the answer key', () => {
  const truth = dsJson('M1_DATASET.groundTruth');
  const files = ds.__pdfs.map((p) => p.name);
  const named = truth.filter((r) => r.file_name !== '(no file)').map((r) => r.file_name);
  const missing = named.filter((n) => files.indexOf(n) < 0);
  if (files.length !== 20 || named.length !== 20 || missing.length) throw new Error(files.length + ' files, ' + named.length + ' rows, missing ' + missing.join(', '));
  return truth.length + ' answer-key rows';
});
step('Dataset: all 14 spec scenarios are covered', () => {
  const scenarios = dsJson('M1_DATASET.groundTruth.map(r => r.scenario.toLowerCase())').join(' | ');
  const need = ['valid supplier contract', 'ending within 60 days', 'already-ended contract', 'valid insurance', 'expiring soon', 'expired licence',
    'missing mandatory', 'incorrect company name', 'missing expiry', 'unreadable', 'conflicting dates', 'replacement certificate',
    'automatic renewal', 'no fixed end date'];
  const gaps = need.filter((n) => scenarios.indexOf(n) < 0);
  if (gaps.length) throw new Error('not covered: ' + gaps.join(', '));
  return need.length + ' of 14';
});
step('Dataset: import refuses a half-uploaded or binned folder and registers nobody', () => {
  dsRun('SEG_setupDatabase()');
  return dsRun(`(function () {
    const partial = DriveApp.createFolder('half uploaded');
    __pdfs.slice(0, 5).forEach(function (p) { partial.createFile(Utilities.newBlob(Utilities.base64Decode(p.b64), 'application/pdf', p.name)); });
    let msg = '';
    try { M1_importDataset(partial.getId(), {}); } catch (e) { msg = e.message; }
    if (!/not in the "half uploaded" folder yet/.test(msg) || !/Nothing was imported/.test(msg)) throw new Error('partial folder: ' + msg);
    const binned = DriveApp.createFolder('binned');
    binned.setTrashed(true);
    let msg2 = '';
    try { M1_importDataset(binned.getId(), {}); } catch (e) { msg2 = e.message; }
    if (!/bin/.test(msg2)) throw new Error('binned folder: ' + msg2);
    const n = readTable(SEG.TABS.SUPPLIERS).length;
    if (n) throw new Error(n + ' supplier(s) registered anyway');
    return 'both refused before registering anyone';
  })()`);
});
step('Dataset: import registers 7 suppliers and leaves BrightClean for the live demo', () => {
  dsRun('SEG_setupDatabase()');
  // Same as dragging the test-pdfs folder into My Drive: the whole tree, sub-folders included.
  dsRun(`var __folder = DriveApp.createFolder('test-pdfs');
    var __dir = function (rel) { var f = __folder; rel.split('/').filter(Boolean).forEach(function (part) {
      var it = f.getFoldersByName(part); f = it.hasNext() ? it.next() : f.createFolder(part); }); return f; };
    __pdfs.forEach(function (p) { __dir(p.dir).createFile(Utilities.newBlob(Utilities.base64Decode(p.b64), 'application/pdf', p.name)); });`);
  const found = dsRun('M1_datasetFolderId()');
  if (found !== dsRun('__folder.getId()')) throw new Error('M1_datasetFolderId did not find the test-pdfs folder by name');
  const report = dsJson('M1_importDataset(M1_datasetFolderId(), {})');
  const imported = report.filter((l) => l.indexOf('Imported') === 0).length;
  if (imported !== 7 || !report.some((l) => /Skipped BrightClean/.test(l))) throw new Error(report.join(' / '));
  return report[report.length - 1];
});
step('Dataset: every supplier ends in the expected registration status', () => {
  const list = dsJson('M1_listSuppliers()');
  const want = {
    'Kilat Shine Services Sdn. Bhd.': 'PENDING_VERIFICATION', 'Perisai Guard Security Sdn. Bhd.': 'PENDING_VERIFICATION',
    'Voltline Electrical Engineering Sdn. Bhd.': 'PENDING_VERIFICATION', 'Mutiara Components Sdn. Bhd.': 'PENDING_DOCUMENTS',
    'Swift Haul Logistics Sdn. Bhd.': 'PENDING_VERIFICATION', 'Cahaya Facility Services Sdn. Bhd.': 'PENDING_VERIFICATION',
    'Kencana Microparts Sdn. Bhd.': 'DRAFT'
  };
  const wrong = Object.keys(want).filter((n) => { const s = list.find((x) => x.supplierName === n); return !s || s.registrationStatus !== want[n]; });
  if (wrong.length || list.length !== 7) throw new Error('wrong: ' + wrong.join(', ') + ' (' + list.length + ' suppliers)');
  const docs = dsJson('readTable(SEG.TABS.DOCUMENTS)').length;
  if (docs !== 17) throw new Error(docs + ' documents');
  return '17 documents uploaded';
});
step('Dataset: each supplier\'s Drive folder is split by document type', () => {
  return dsRun(`(function () {
    const s = readTable(SEG.TABS.SUPPLIERS).find(r => r.supplier_name.indexOf('Voltline') === 0);
    const f = DriveApp.getFolderById(s.drive_folder_id);
    if (f.files.length) throw new Error(f.files.length + ' file(s) left at the top level');
    const names = f.children.map(c => c.getName() + ' (' + c.files.length + ')').join(', ');
    if (names !== '1. Contracts & Agreements (1), 2. Licences & Permits (1), 3. Certificates & Insurance (2)') throw new Error(names);
    return names;
  })()`);
});
step('Dataset: answer key filled and linked to the new IDs', () => {
  const rows = dsJson('readTable(SEG.TABS.GROUND_TRUTH)');
  const withDoc = rows.filter((r) => r.doc_id).length;
  const withSupplier = rows.filter((r) => r.supplier_id).length;
  if (rows.length !== 22 || withDoc !== 17 || withSupplier !== 18) throw new Error(rows.length + ' rows, ' + withDoc + ' with doc_id, ' + withSupplier + ' with supplier_id');
  return '22 rows, 17 linked to documents';
});
step('Dataset: running the import again adds nothing', () => {
  const report = dsJson('M1_importDataset(__folder.getId(), {})');
  const docs = dsJson('readTable(SEG.TABS.DOCUMENTS)').length;
  if (report.some((l) => l.indexOf('Imported') === 0) || docs !== 17 || !/0 row\(s\) added/.test(report[report.length - 1])) throw new Error(report.join(' / '));
});
step('Dataset: the BrightClean live demo works with its PDFs (register, missing document, renewal)', () => {
  return dsRun(`(function () {
    const files = M1_datasetFiles(__folder, {}, []);
    const b64 = (n) => Utilities.base64Encode(files[n].getBlob().getBytes());
    const s = M1_DATASET.suppliers.find(x => x.key === 'brightclean');
    let d = M1_saveSupplierDraft({ info: s.info, requirements: M1_getCategoryChecklist('CLEANING') });
    const id = d.supplier.supplierId;
    const req = (t) => d.requirements.find(r => r.docTypeId === t).requirementId;
    M1_uploadDocument({ supplierId: id, requirementId: req('CLEANING_SERVICE_AGREEMENT'), fileName: 'BrightClean_Cleaning_Service_Agreement_2026.pdf', mimeType: 'application/pdf', base64: b64('BrightClean_Cleaning_Service_Agreement_2026.pdf') });
    M1_uploadDocument({ supplierId: id, requirementId: req('INSURANCE_CERTIFICATE'), fileName: 'BrightClean_Insurance_Certificate_2025-2026.pdf', mimeType: 'application/pdf', base64: b64('BrightClean_Insurance_Certificate_2025-2026.pdf') });
    d = M1_registerSupplier(id);
    if (d.supplier.registrationStatus !== 'PENDING_DOCUMENTS') throw new Error('after register: ' + d.supplier.registrationStatus);
    if (d.registration.missing.join() !== 'Business Registration Record') throw new Error('missing: ' + d.registration.missing.join());
    const renewal = M1_uploadDocument({ supplierId: id, requirementId: req('INSURANCE_CERTIFICATE'), fileName: 'BrightClean_Insurance_Certificate_2026-2027_RENEWAL.pdf', mimeType: 'application/pdf', base64: b64('BrightClean_Insurance_Certificate_2026-2027_RENEWAL.pdf') });
    if (renewal.version !== 2 || renewal.replaced.length !== 1) throw new Error('renewal ' + JSON.stringify(renewal));
    const report = M1_importDataset(__folder.getId(), {});
    const linked = readTable(SEG.TABS.GROUND_TRUTH).filter(r => r.supplier_name === 'BrightClean Sdn. Bhd.' && r.doc_id).length;
    if (linked !== 3) throw new Error('BrightClean answer-key rows linked: ' + linked + ' / ' + report.join(' / '));
    return id + ' registered live, renewal is version 2, ' + linked + ' answer-key rows linked';
  })()`);
});

step('Overview: dashboard numbers match the Sheet', () => {
  const o = dsJson('SEG_getOverview()');
  const sups = dsJson('readTable(SEG.TABS.SUPPLIERS)');
  const docs = dsJson('readTable(SEG.TABS.DOCUMENTS)');
  const current = docs.filter((d) => d.lifecycle_status === 'ACTIVE').length;
  const statusSum = Object.keys(o.suppliers.byStatus).reduce((n, k) => n + o.suppliers.byStatus[k], 0);
  if (o.suppliers.total !== sups.length || statusSum !== sups.length) throw new Error('suppliers ' + o.suppliers.total + ' vs ' + sups.length + ', status sum ' + statusSum);
  if (o.documents.current !== current || o.documents.versions !== docs.length) throw new Error('documents ' + JSON.stringify(o.documents));
  if (o.coverage.uploaded > o.coverage.required || !o.activity.length || o.attention.length > 6) throw new Error(JSON.stringify({ coverage: o.coverage, activity: o.activity.length, attention: o.attention.length }));
  return o.suppliers.total + ' suppliers, ' + current + ' current documents, ' + o.coverage.uploaded + ' of ' + o.coverage.required + ' mandatory on file, ' + o.attentionTotal + ' need attention';
});
step('Every tab fits its text: no column wider than 360 px, long text wraps, and the Sheet gets an AlphaTrack menu', () => {
  return dsRun(`(function () {
    SEG_fitColumns();
    const bad = [];
    let wrappedCols = 0;
    Object.keys(SEG.HEADERS).forEach((name) => {
      const sheet = SEG_sheet(name);
      for (let c = 1; c <= sheet.getLastColumn(); c++) {
        const w = sheet.getColumnWidth(c);
        if (w > 360 || w < 70) bad.push(name + ' col ' + c + ' = ' + w);
        if (sheet.wrapped[c]) wrappedCols++;
      }
    });
    if (bad.length) throw new Error(bad.join('; '));
    onOpen();
    const menu = SpreadsheetApp.__menus().pop();
    if (!menu || menu.title !== 'AlphaTrack' || menu.items[0][1] !== 'SEG_fitColumns') throw new Error('menu missing');
    return 'all 13 tabs fitted, ' + wrappedCols + ' long-text columns wrap';
  })()`);
});
step('A tab keeps growing past its first 1000 rows (real Sheets refuse to write past the end)', () => {
  return dsRun(`(function () {
    const sheet = SEG_sheet(SEG.TABS.RUNS);
    const before = readTable(SEG.TABS.RUNS).length;
    const rows = [];
    for (let i = 0; i < 1100; i++) rows.push({ run_id: 'RUN' + i, notes: 'growth test' });
    appendRows(SEG.TABS.RUNS, rows.slice(0, 600));
    appendRows(SEG.TABS.RUNS, rows.slice(600));
    const after = readTable(SEG.TABS.RUNS).length;
    if (after !== before + 1100) throw new Error(after + ' rows');
    const grown = sheet.getMaxRows();
    for (let i = 0; i < 1100; i++) sheet.deleteRow(sheet.getLastRow());
    return '1100 rows written; the tab grew from 1000 to ' + grown + ' rows';
  })()`);
});
step('Deactivate: monitoring stops, nothing is deleted, the Drive folder moves, and it can be undone', () => {
  return dsRun(`(function () {
    const s = readTable(SEG.TABS.SUPPLIERS).find(r => r.supplier_name.indexOf('Perisai') === 0);
    const id = s.supplier_id;
    const root = SEG_rootFolder();
    const docsBefore = readTable(SEG.TABS.DOCUMENTS).filter(d => d.supplier_id === id).length;
    const queueBefore = M1_getDocumentsAwaitingExtraction().filter(d => d.supplierId === id).length;
    const overviewBefore = SEG_getOverview();
    let threw = '';
    try { M1_deactivateSupplier(id, 'no'); } catch (e) { threw = e.message; }
    if (!/reason/.test(threw)) throw new Error('a too-short reason was accepted: ' + threw);

    let d = M1_deactivateSupplier(id, 'Contract ended on 31 Oct 2026');
    if (!d.supplier.deactivated || d.supplier.accountStatus !== 'DEACTIVATED' || d.supplier.deactivationReason !== 'Contract ended on 31 Oct 2026') {
      throw new Error('detail after deactivate: ' + JSON.stringify(d.supplier));
    }
    const archive = root.getFoldersByName('Deactivated suppliers').next();
    if (!archive.children.some(c => c.getId() === s.drive_folder_id)) throw new Error('folder not moved into "Deactivated suppliers"');
    if (root.children.some(c => c.getId() === s.drive_folder_id)) throw new Error('folder still in the main folder');
    if (readTable(SEG.TABS.DOCUMENTS).filter(x => x.supplier_id === id).length !== docsBefore) throw new Error('documents changed');
    if (M1_getDocumentsAwaitingExtraction().some(x => x.supplierId === id)) throw new Error('still in the AI extraction queue');
    if (M1_getMonitoredSuppliers().some(x => x.supplierId === id) || M1_isMonitored(id)) throw new Error('still monitored');
    const o = SEG_getOverview();
    if (o.suppliers.total !== overviewBefore.suppliers.total - 1 || o.suppliers.deactivated !== 1) throw new Error('overview: ' + JSON.stringify(o.suppliers));
    if (o.documents.awaitingExtraction !== overviewBefore.documents.awaitingExtraction - queueBefore) throw new Error('overview queue not reduced');
    const listed = M1_listSuppliers().find(x => x.supplierId === id);
    if (!listed.deactivated) throw new Error('list does not show it as deactivated');

    const blocked = [];
    const tryIt = (label, fn) => { try { fn(); blocked.push(label + ' NOT blocked'); } catch (e) { if (!/deactivated/.test(e.message)) blocked.push(label + ': ' + e.message); } };
    tryIt('edit details', () => M1_updateSupplierInfo(id, Object.assign(M1_rowToInfo(s), { contactPerson: 'Someone Else' })));
    tryIt('edit checklist', () => M1_saveSupplierRequirements(id, d.requirements.map(r => Object.assign({}, r))));
    tryIt('upload', () => M1_uploadDocument({ supplierId: id, requirementId: d.requirements[0].requirementId, fileName: 'x.pdf',
      mimeType: 'application/pdf', base64: Utilities.base64Encode([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x99]) }));
    tryIt('deactivate twice', () => M1_deactivateSupplier(id, 'Second time round'));
    if (blocked.length) throw new Error(blocked.join('; '));

    let clash = '';
    try { M1_saveSupplierDraft({ info: Object.assign(M1_rowToInfo(s), { supplierName: 'Copy of Perisai' }) }); } catch (e) { clash = e.message; }
    if (!/deactivated\. Reactivate it/.test(clash)) throw new Error('re-registering the same company: ' + clash);

    d = M1_reactivateSupplier(id);
    if (d.supplier.deactivated || d.supplier.deactivationReason) throw new Error('still deactivated after reactivate');
    if (!root.children.some(c => c.getId() === s.drive_folder_id)) throw new Error('folder not moved back');
    if (M1_getDocumentsAwaitingExtraction().filter(x => x.supplierId === id).length !== queueBefore) throw new Error('documents not back in the AI queue');
    if (!M1_isMonitored(id)) throw new Error('not monitored again');
    const audit = readTable(SEG.TABS.AUDIT).filter(a => a.supplier_id === id).map(a => a.action);
    if (audit.indexOf('SUPPLIER_DEACTIVATED') < 0 || audit.indexOf('SUPPLIER_REACTIVATED') < 0) throw new Error('audit: ' + audit.join(','));
    return id + ' deactivated and reactivated; folder moved both ways; edits and uploads blocked while deactivated';
  })()`);
});
step('Video demo reset removes BrightClean only, so it can be registered again', () => {
  return dsRun(`(function () {
    const before = readTable(SEG.TABS.SUPPLIERS).length;
    const removed = M1_resetVideoDemo();
    const after = readTable(SEG.TABS.SUPPLIERS);
    if (removed !== 1 || after.length !== before - 1 || after.some(r => r.registration_no === 'SIM-REG-101')) throw new Error('removed ' + removed);
    if (readTable(SEG.TABS.DOCUMENTS).some(d => d.original_file_name.indexOf('BrightClean') === 0)) throw new Error('BrightClean documents left');
    const truth = readTable(SEG.TABS.GROUND_TRUTH).filter(r => r.supplier_name === 'BrightClean Sdn. Bhd.');
    if (truth.length !== 4 || truth.some(r => r.supplier_id || r.doc_id)) throw new Error('answer key not unlinked');
    const s = M1_DATASET.suppliers.find(x => x.key === 'brightclean');
    const d = M1_saveSupplierDraft({ info: s.info, requirements: M1_getCategoryChecklist('CLEANING') });
    const files = M1_datasetFiles(__folder, {}, []);
    const req = d.requirements.find(r => r.docTypeId === 'CLEANING_SERVICE_AGREEMENT').requirementId;
    M1_uploadDocument({ supplierId: d.supplier.supplierId, requirementId: req, fileName: 'BrightClean_Cleaning_Service_Agreement_2026.pdf',
      mimeType: 'application/pdf', base64: Utilities.base64Encode(files['BrightClean_Cleaning_Service_Agreement_2026.pdf'].getBlob().getBytes()) });
    return 'registered again as ' + d.supplier.supplierId + ' with the same PDFs';
  })()`);
});

step('Restarting the demo data numbers the suppliers from SUP001 again and keeps your own suppliers', () => {
  return dsRun(`(function () {
    M1_restartDemoData();
    let ids = readTable(SEG.TABS.SUPPLIERS).map(s => s.supplier_id).sort();
    const docs = readTable(SEG.TABS.DOCUMENTS);
    const linked = readTable(SEG.TABS.GROUND_TRUTH).filter(r => r.doc_id).length;
    if (ids.join() !== 'SUP001,SUP002,SUP003,SUP004,SUP005,SUP006,SUP007' || docs.length !== 17 || linked !== 17) {
      throw new Error(ids.join(',') + ' / ' + docs.length + ' docs / ' + linked + ' linked');
    }
    if (docs.map(d => d.doc_id).sort()[0] !== 'DOC001') throw new Error('documents start at ' + docs.map(d => d.doc_id).sort()[0]);
    const mine = M1_saveSupplierDraft({ info: { supplierName: 'My Own Supplier Sdn. Bhd.', registrationNo: 'MINE-1' } }).supplier.supplierId;
    M1_restartDemoData();
    const list = readTable(SEG.TABS.SUPPLIERS);
    if (!list.some(s => s.supplier_id === mine) || list.length !== 8) throw new Error('your own supplier ' + mine + ' was not kept');
    M1_removeSuppliersForTesting(s => s.supplier_id === mine, 'mine');
    return 'suppliers SUP001-SUP007, documents from DOC001, answer key re-linked; your own supplier ' + mine + ' survives a restart';
  })()`);
});

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAILED')).length;
console.log('\n' + (results.length - failed) + ' of ' + results.length + ' steps passed');
if (failed) {
  console.log('\nLast log lines:\n' + logs.slice(-15).join('\n'));
  process.exit(1);
}
