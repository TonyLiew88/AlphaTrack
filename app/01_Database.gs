/**
 * 01_Database.gs · Shared helpers · Owner: Member 5 (integration)
 *
 * Sheet access, IDs, dates, locking, the audit log and the hand-off to AI extraction.
 * Every module uses these instead of talking to SpreadsheetApp directly.
 *
 * Run SEG_setupDatabase() once from the editor before anything else.
 */

/* ------------------------------------------------------------------ Setup */

/**
 * Creates any missing tabs with their headers, formats every tab as plain text
 * (so IDs and dates are never auto-converted), creates the Drive root folder and
 * seeds Member 1's master data. Safe to run again: it never deletes anything.
 */
function SEG_setupDatabase() {
  const ss = SEG_spreadsheet();
  const props = PropertiesService.getScriptProperties();
  props.setProperty('SPREADSHEET_ID', ss.getId());

  const created = [];
  Object.keys(SEG.HEADERS).forEach((name) => {
    const headers = SEG.HEADERS[name];
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      created.push(name);
    }
    const lastCol = sheet.getLastColumn();
    const existing = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map((h) => String(h).trim()) : [];
    const missing = headers.filter((h) => existing.indexOf(h) === -1);
    if (missing.length) sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    const width = existing.length + missing.length;
    sheet.getRange(1, 1, sheet.getMaxRows(), width).setNumberFormat('@');
    sheet.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#0F172A').setFontColor('#FFFFFF');
    sheet.setFrozenRows(1);
  });

  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  const root = SEG_rootFolder();
  const seeded = typeof M1_seedMasterData === 'function' ? M1_seedMasterData() : [];

  SEG_audit({
    module: 'M5', action: 'DATABASE_SETUP', recordType: 'SYSTEM', recordId: ss.getId(), outcome: 'OK',
    reason: 'Tabs created: ' + (created.join(', ') || 'none') + '. Master data seeded: ' + (seeded.join(', ') || 'none') + '.'
  });
  const summary = {
    tabsCreated: created,
    masterDataSeeded: seeded,
    spreadsheetUrl: ss.getUrl(),
    driveFolderUrl: root.getUrl()
  };
  console.log('Setup complete:\n' + JSON.stringify(summary, null, 2));
  return summary;
}

/* ------------------------------------------------------------- Locations */

/** The database spreadsheet: the one this script is bound to, or SPREADSHEET_ID. */
function SEG_spreadsheet() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function SEG_sheet(name) {
  const sheet = SEG_spreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('The "' + name + '" tab is missing. Run SEG_setupDatabase() from the Apps Script editor.');
  return sheet;
}

/** Drive folder that holds one sub-folder per supplier. Created on first use. */
function SEG_rootFolder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DRIVE_ROOT_FOLDER_ID');
  if (id) return SEG_openFolder(id, 'The main supplier documents folder', 'the DRIVE_ROOT_FOLDER_ID script property', '');
  const folder = DriveApp.createFolder(SEG.ROOT_FOLDER_NAME);
  props.setProperty('DRIVE_ROOT_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * Opens a folder the app saved earlier.
 * - In the Drive bin: it is restored and the restore is logged, so documents never sit in the bin.
 * - Can't be opened at all (no access, or deleted for good): stops with a clear message instead of
 *   quietly making a replacement, which would split one supplier's documents across folders or
 *   move the shared folder into whoever happened to run the code.
 */
function SEG_openFolder(id, what, whereStored, supplierId) {
  let folder;
  try {
    folder = DriveApp.getFolderById(id);
  } catch (err) {
    throw new Error(what + ' (Drive folder ' + id + ') can’t be opened by ' + SEG_currentUser() + '. Ask its owner to share it ' +
      'with you, or run this from the account that set the app up. If the folder was deleted for good, clear ' + whereStored +
      ' and try again, and a new folder will be created.');
  }
  if (folder.isTrashed()) {
    folder.setTrashed(false);
    SEG_audit({
      module: 'SYSTEM', action: 'DRIVE_FOLDER_RESTORED', recordType: 'FOLDER', recordId: id, supplierId: supplierId || '',
      outcome: 'RESTORED', reason: what + ' was in the Drive bin. It has been restored so its documents are kept.'
    });
  }
  return folder;
}

/* ---------------------------------------------------------------- Tables */

/**
 * Reads a tab into objects keyed by header name. Each object also carries _row
 * (its sheet row number) for updateRow(). Cell values come back as strings.
 */
function readTable(name) {
  const sheet = SEG_sheet(name);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map((h) => String(h).trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const cells = values[i];
    if (cells.every((c) => c === '' || c === null)) continue;
    const obj = { _row: i + 1 };
    headers.forEach((h, c) => {
      if (h) obj[h] = SEG_fromCell(cells[c]);
    });
    rows.push(obj);
  }
  return rows;
}

/** Appends objects as rows. Keys must match header names; unknown keys are ignored. */
function appendRows(name, objects) {
  if (!objects || !objects.length) return;
  const sheet = SEG_sheet(name);
  const headers = SEG_headersOf(sheet);
  const rows = objects.map((o) => headers.map((h) => SEG_toCell(o[h])));
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
}

/** Changes some cells of one row. changes = { column_name: value, ... } */
function updateRow(name, rowNumber, changes) {
  const sheet = SEG_sheet(name);
  const headers = SEG_headersOf(sheet);
  const range = sheet.getRange(rowNumber, 1, 1, headers.length);
  const cells = range.getValues()[0];
  Object.keys(changes).forEach((key) => {
    if (key === '_row') return;
    const col = headers.indexOf(key);
    if (col === -1) throw new Error('The "' + name + '" tab has no "' + key + '" column. Run SEG_setupDatabase().');
    cells[col] = SEG_toCell(changes[key]);
  });
  range.setValues([cells]);
}

function SEG_headersOf(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map((h) => String(h).trim());
}

function SEG_fromCell(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    const time = Utilities.formatDate(value, SEG.TIMEZONE, 'HH:mm:ss');
    return time === '00:00:00' ? SEG_isoDate(value) : SEG_isoDateTime(value);
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

function SEG_toCell(value) {
  if (value === undefined || value === null) return '';
  if (value === true) return 'TRUE';
  if (value === false) return 'FALSE';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/* ------------------------------------------------------------ Small tools */

/**
 * Runs fn while holding the script lock, so two uploads at the same moment
 * can't create the same ID. Keep the work inside short.
 */
function SEG_withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/** nextId('SUP', ['SUP001', 'SUP009'], 3) -> 'SUP010' */
function nextId(prefix, existingIds, width) {
  let max = 0;
  existingIds.forEach((id) => {
    const text = String(id || '');
    if (text.indexOf(prefix) !== 0) return;
    const n = Number(text.slice(prefix.length));
    if (!isNaN(n)) max = Math.max(max, n);
  });
  return prefix + String(max + 1).padStart(width || 3, '0');
}

/**
 * A new ID that is never reused, even if rows are deleted later: it remembers the
 * highest number handed out in Script Properties. Call it inside SEG_withLock.
 * SEG_newId('DOC', existingIds, 3) -> 'DOC014'
 */
function SEG_newId(prefix, existingIds, width) {
  const props = PropertiesService.getScriptProperties();
  const key = 'LAST_ID_' + prefix;
  const fromRows = Number(nextId(prefix, existingIds, 1).slice(prefix.length)) - 1;
  const n = Math.max(fromRows, Number(props.getProperty(key)) || 0) + 1;
  props.setProperty(key, String(n));
  return prefix + String(n).padStart(width || 3, '0');
}

/** 'TRUE', true, 'yes', '1' -> true. Blank -> fallback. */
function SEG_bool(value, fallback) {
  if (value === true || value === false) return value;
  const s = String(value === undefined || value === null ? '' : value).trim().toUpperCase();
  if (s === '') return fallback === undefined ? false : fallback;
  return s === 'TRUE' || s === 'YES' || s === 'Y' || s === '1';
}

/** For comparing names and numbers: 'BrightClean Sdn. Bhd.' -> 'BRIGHTCLEANSDNBHD' */
function SEG_cleanText(value) {
  return String(value === null || value === undefined ? '' : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function SEG_isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function SEG_isoDate(date) {
  return Utilities.formatDate(date, SEG.TIMEZONE, 'yyyy-MM-dd');
}

function SEG_isoDateTime(date) {
  return Utilities.formatDate(date, SEG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/** Now and today in Malaysia time, as ISO strings. */
function SEG_now() {
  return SEG_isoDateTime(new Date());
}

function SEG_today() {
  return SEG_isoDate(new Date());
}

function SEG_currentUser() {
  let email = '';
  try {
    email = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
  } catch (err) {
    email = '';
  }
  return email || 'unknown user';
}

/* ------------------------------------------------------------- Audit log */

/**
 * Appends one line to the AuditLog tab. Never throws: a failed audit write
 * must not stop the real work.
 * entry = { module, action, recordType, recordId, supplierId, outcome, reason, details }
 */
function SEG_audit(entry) {
  try {
    appendRows(SEG.TABS.AUDIT, [{
      timestamp: SEG_now(),
      actor: SEG_currentUser(),
      module: entry.module || '',
      action: entry.action || '',
      record_type: entry.recordType || '',
      record_id: entry.recordId || '',
      supplier_id: entry.supplierId || '',
      outcome: entry.outcome || 'OK',
      reason: entry.reason || '',
      details: entry.details === undefined ? '' : entry.details
    }]);
  } catch (err) {
    console.error('Audit log write failed: ' + err.message);
  }
}

/* ----------------------------------------------- Hand-off to AI extraction */

/**
 * Called by Member 1 straight after a document is uploaded.
 *
 * The extraction queue is simply: Documents rows that have extraction_requested_at
 * and no successful Extractions row for that doc_id and file_id yet
 * (see M1_getDocumentsAwaitingExtraction). Nothing is uploaded twice.
 *
 * When Member 5 adds M5_processExtractionQueue(), this schedules it to run about a
 * minute later, so the user's upload isn't kept waiting for Gemini. That handler
 * should delete its own one-off trigger when it runs.
 */
function SEG_requestExtraction(docId) {
  if (typeof M5_processExtractionQueue === 'function') {
    try {
      SEG_scheduleOnce('M5_processExtractionQueue', 60 * 1000);
      return 'SCHEDULED';
    } catch (err) {
      console.warn('Could not schedule extraction for ' + docId + ': ' + err.message);
    }
  }
  return 'QUEUED';
}

/** Creates a one-off time trigger for handlerName unless one is already waiting. */
function SEG_scheduleOnce(handlerName, delayMs) {
  const waiting = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === handlerName);
  if (!waiting) ScriptApp.newTrigger(handlerName).timeBased().after(delayMs).create();
}

/* ----------------------------------------------------------------- Tests */

/**
 * Tiny test helper used by every module:
 *   SEG_test('test_M1_rules', (expect) => { expect('label', condition, 'detail'); });
 * Prints PASS/FAIL lines and throws if anything failed, so the run shows red.
 */
function SEG_test(name, fn) {
  const results = [];
  const expect = (label, ok, detail) => results.push({ label: label, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  try {
    fn(expect);
  } catch (err) {
    results.push({ label: 'Stopped with an error', ok: false, detail: err.message });
  }
  results.forEach((r) => console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.label + (r.detail ? '   (' + r.detail + ')' : '')));
  const failed = results.filter((r) => !r.ok).length;
  console.log(name + ': ' + (results.length - failed) + ' of ' + results.length + ' checks passed');
  if (failed) throw new Error(name + ': ' + failed + ' check(s) failed. Read the FAIL lines above.');
  return results.length;
}
