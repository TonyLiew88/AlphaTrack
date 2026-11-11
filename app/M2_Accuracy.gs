/**
 * M2_Accuracy.gs · Member 2: how well did Gemini read the test documents?
 *
 * TEST CODE ONLY. It compares the AI's readings in the Extractions tab with the
 * answer key in the GroundTruth tab. The live workflow (M2_Extraction.gs) never
 * reads GroundTruth; only this file does, and nothing calls it automatically.
 *
 * Run test_M2_accuracy from the editor after M2_processQueue has read the documents.
 * It prints one line per document and two scores:
 *   Fields: every key field compared with the answer key (scope is free text, so it is left out)
 *   Issues: documents whose REVIEW issues are exactly the expected ones
 * Officer corrections are ignored: the score is about the AI's own reading.
 */

/** Fields compared for each class (scope is left out: it is free text). */
const M2_ACCURACY_FIELDS = {
  CONTRACT: ['holder_name', 'client_name', 'document_no', 'start_date', 'due_date', 'renewal_notice_days', 'auto_renewal'],
  LICENCE: ['holder_name', 'document_no', 'issuing_body', 'issue_date', 'due_date'],
  CERTIFICATE: ['holder_name', 'document_no', 'issuing_body', 'issue_date', 'due_date']
};

function test_M2_accuracy() {
  const report = M2_measureAccuracy(
    readTable(SEG.TABS.GROUND_TRUTH),
    readTable(SEG.TABS.DOCUMENTS),
    readTable(SEG.TABS.EXTRACTIONS)
  );
  report.lines.forEach((line) => console.log(line));
  console.log('Fields: ' + report.fieldsRight + ' of ' + report.fieldsTotal + ' correct (' + report.fieldPercent + ' %)');
  console.log('Issues: ' + report.docsRight + ' of ' + report.docsTotal + ' documents exactly as expected');
  if (report.notRead.length) console.log('Not read yet: ' + report.notRead.join(', '));
  return report;
}

/**
 * Pure: compares the latest AI reading of each current document with its answer-key row.
 * Returns { lines, fieldsRight, fieldsTotal, fieldPercent, docsRight, docsTotal, notRead }.
 */
function M2_measureAccuracy(truthRows, documentRows, extractionRows) {
  const lines = [];
  const notRead = [];
  let fieldsRight = 0;
  let fieldsTotal = 0;
  let docsRight = 0;
  let docsTotal = 0;

  documentRows.filter((d) => d.lifecycle_status === SEG.LIFECYCLE.ACTIVE).forEach((doc) => {
    const truth = truthRows.find((t) => t.doc_id === doc.doc_id) ||
      truthRows.find((t) => t.file_name && t.file_name === doc.original_file_name);
    if (!truth) return; // not part of the test dataset
    const readings = extractionRows.filter((x) => x.doc_id === doc.doc_id && x.file_id === doc.file_id &&
      x.processing_status !== M2.STATUS.CORRECTED && x.processing_status !== M2.STATUS.FAILED);
    if (!readings.length) {
      notRead.push(doc.doc_id);
      return;
    }
    const got = M2_parseJson(readings[readings.length - 1].extracted_json);
    const gotIssues = String(readings[readings.length - 1].issues || '').split(',').map((s) => s.trim())
      .filter((c) => c && (!M2_ISSUES[c] || M2_ISSUES[c].effect !== 'INFO')).sort().join(',');
    const wantIssues = String(truth.expected_issues || '').split(',').map((s) => s.trim()).filter(Boolean).sort().join(',');
    const unreadable = wantIssues.split(',').indexOf('UNREADABLE') !== -1;

    const docClass = String(truth.document_class || doc.document_class).toUpperCase();
    const wrong = [];
    (M2_ACCURACY_FIELDS[docClass] || M2_ACCURACY_FIELDS.CERTIFICATE).forEach((field) => {
      // For the blurred scan the right answer is "nothing": the AI must not guess.
      const want = unreadable ? '' : truth[field];
      fieldsTotal++;
      if (M2_sameValue(field, want, got[field])) fieldsRight++;
      else wrong.push(field + ' (got "' + (got[field] === null || got[field] === undefined ? '' : got[field]) + '", want "' + (want || '') + '")');
    });

    docsTotal++;
    const issuesOk = gotIssues === wantIssues;
    if (issuesOk) docsRight++;
    lines.push((issuesOk && !wrong.length ? 'OK    ' : 'CHECK ') + doc.doc_id + '  ' + truth.file_name +
      (issuesOk ? '' : '  issues "' + gotIssues + '", want "' + wantIssues + '"') +
      (wrong.length ? '  fields: ' + wrong.join('; ') : ''));
  });

  return {
    lines: lines,
    fieldsRight: fieldsRight,
    fieldsTotal: fieldsTotal,
    fieldPercent: fieldsTotal ? Math.round((fieldsRight / fieldsTotal) * 1000) / 10 : 0,
    docsRight: docsRight,
    docsTotal: docsTotal,
    notRead: notRead
  };
}

/** One field: same meaning, ignoring case, spaces and punctuation (and "Sdn. Bhd." vs "SDN BHD" for names). */
function M2_sameValue(field, want, got) {
  const empty = (v) => v === null || v === undefined || String(v).trim() === '';
  if (empty(want) || empty(got)) return empty(want) && empty(got);
  if (field === 'holder_name' || field === 'client_name') return M2_sameCompany(want, got);
  if (field === 'renewal_notice_days') return Number(want) === Number(got);
  if (field === 'auto_renewal') return String(want).toUpperCase() === String(got).toUpperCase();
  if (M2.DATE_FIELDS.indexOf(field) !== -1) return String(want).trim() === String(got).trim();
  return SEG_cleanText(want) === SEG_cleanText(got);
}
