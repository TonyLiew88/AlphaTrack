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
  ['AppClient.html', 'M1_Client.html'].forEach((f) => {
    const html = fs.readFileSync(path.join(appDir, f), 'utf8');
    const code = html.replace(/^[\s\S]*?<script>/, '').replace(/<\/script>[\s\S]*$/, '');
    new vm.Script(code, { filename: f });
  });
  return 'AppClient, M1_Client';
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
step('IDs are never reused after rows are deleted', () => {
  const ids = json('M1_listSuppliers().map(s => s.supplierId)');
  if (ids.indexOf('SUP001') >= 0) throw new Error(ids.join(', '));
  return ids.sort().join(', ');
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

/* ------------------------------------------------- The fictional test dataset (fresh database) */
const ds = vm.createContext({ console: { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push('WARN ' + a.join(' ')), error: (...a) => logs.push('ERROR ' + a.join(' ')) } });
const dsLoad = (file, name) => vm.runInContext(fs.readFileSync(file, 'utf8'), ds, { filename: name });
dsLoad(path.join(__dirname, 'mock-google.js'), 'mock-google.js');
fs.readdirSync(appDir).filter((f) => f.endsWith('.gs')).sort().forEach((f) => dsLoad(path.join(appDir, f), f));
const dsRun = (code) => vm.runInContext(code, ds);
const dsJson = (code) => JSON.parse(dsRun('JSON.stringify(' + code + ')'));
const pdfDir = path.resolve(__dirname, '..', 'dataset', 'pdfs');
ds.__pdfs = fs.readdirSync(pdfDir).filter((f) => f.endsWith('.pdf')).map((f) => ({ name: f, b64: fs.readFileSync(path.join(pdfDir, f)).toString('base64') }));

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
step('Dataset: import registers 7 suppliers and leaves BrightClean for the live demo', () => {
  dsRun('SEG_setupDatabase()');
  dsRun("var __folder = DriveApp.createFolder('dataset'); __pdfs.forEach(function (p) { __folder.createFile(Utilities.newBlob(Utilities.base64Decode(p.b64), 'application/pdf', p.name)); });");
  const report = dsJson('M1_importDataset(__folder.getId(), {})');
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
    const files = {}; const it = __folder.getFiles(); while (it.hasNext()) { const f = it.next(); files[f.getName()] = f; }
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

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAILED')).length;
console.log('\n' + (results.length - failed) + ' of ' + results.length + ' steps passed');
if (failed) {
  console.log('\nLast log lines:\n' + logs.slice(-15).join('\n'));
  process.exit(1);
}
