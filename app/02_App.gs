/**
 * 02_App.gs · Web app shell and Overview · Owner: Member 5 (integration)
 *
 * Serves the single AlphaTrack dashboard. Each member's page lives in its own
 * HTML files and is pulled in with include().
 */

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle(SEG.APP_NAME + ' · ' + SEG.COMPANY)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Used inside the HTML templates: <?!= include('Styles'); ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Basic facts the page needs on load. Called by AppClient. */
function SEG_getAppInfo() {
  const ss = SEG_spreadsheet();
  const missingTabs = Object.keys(SEG.HEADERS).filter((name) => !ss.getSheetByName(name));
  return {
    appName: SEG.APP_NAME,
    tagline: SEG.TAGLINE,
    company: SEG.COMPANY,
    user: SEG_currentUser(),
    today: SEG_today(),
    spreadsheetUrl: ss.getUrl(),
    setupNeeded: missingTabs.length > 0,
    missingTabs: missingTabs
  };
}

/**
 * Everything the Overview page shows, worked out from the records the modules keep.
 * Member 1's records are live today. Expiry, risk and notification figures join here
 * when Members 2-4 connect their modules (see `modules`).
 */
function SEG_getOverview() {
  const master = M1_loadMasterData();
  const everyone = M1_listSuppliers();
  // Deactivated suppliers are kept but no longer monitored, so they leave every figure below.
  const suppliers = everyone.filter((s) => !s.deactivated);
  const monitoredIds = {};
  suppliers.forEach((s) => { monitoredIds[s.supplierId] = true; });
  const docs = readTable(SEG.TABS.DOCUMENTS).filter((d) => monitoredIds[d.supplier_id]);
  const current = docs.filter((d) => d.lifecycle_status === SEG.LIFECYCLE.ACTIVE);
  const queue = M1_getDocumentsAwaitingExtraction();
  const names = {};
  everyone.forEach((s) => { names[s.supplierId] = s.supplierName; });

  const byStatus = {};
  Object.keys(SEG.REGISTRATION_STATUS).forEach((s) => { byStatus[s] = 0; });
  suppliers.forEach((s) => { byStatus[s.registrationStatus] = (byStatus[s.registrationStatus] || 0) + 1; });

  const submitted = suppliers.filter((s) => s.registrationStatus !== SEG.REGISTRATION_STATUS.DRAFT);
  const coverage = submitted.reduce((acc, s) => {
    acc.required += s.mandatoryTotal;
    acc.uploaded += s.mandatoryUploaded;
    return acc;
  }, { required: 0, uploaded: 0 });

  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const rankOf = (c) => (Object.prototype.hasOwnProperty.call(rank, c) ? rank[c] : 3);
  const attention = suppliers
    .filter((s) => s.registrationStatus === SEG.REGISTRATION_STATUS.PENDING_DOCUMENTS || s.registrationStatus === SEG.REGISTRATION_STATUS.DRAFT)
    .map((s) => ({
      supplierId: s.supplierId,
      supplierName: s.supplierName,
      criticality: s.criticality,
      kind: s.registrationStatus === SEG.REGISTRATION_STATUS.DRAFT ? 'DRAFT' : 'MISSING',
      detail: s.registrationStatus === SEG.REGISTRATION_STATUS.DRAFT
        ? 'Registration not finished'
        : 'Missing: ' + (s.missing || []).join(', ')
    }))
    .sort((a, b) => (a.kind === b.kind ? 0 : (a.kind === 'MISSING' ? -1 : 1)) || (rankOf(a.criticality) - rankOf(b.criticality)));

  const activity = readTable(SEG.TABS.AUDIT)
    .slice(-8)
    .reverse()
    .map((a) => ({
      timestamp: a.timestamp, actor: a.actor, module: a.module, action: a.action, recordId: a.record_id,
      supplierId: a.supplier_id, supplierName: names[a.supplier_id] || '', reason: a.reason
    }));

  return {
    generatedAt: SEG_now(),
    suppliers: {
      total: suppliers.length,
      submitted: submitted.length,
      drafts: byStatus.DRAFT || 0,
      deactivated: everyone.length - suppliers.length,
      byStatus: byStatus,
      byCategory: master.categories
        .map((c) => ({ id: c.categoryId, name: c.name, count: suppliers.filter((s) => s.categoryId === c.categoryId).length }))
        .sort((a, b) => b.count - a.count)
        .concat((() => {
          // Drafts saved before a category was chosen (or with a category that has since been switched off).
          const n = suppliers.filter((s) => !master.categories.some((c) => c.categoryId === s.categoryId)).length;
          return n ? [{ id: '', name: 'No category yet', count: n }] : [];
        })()),
      byCriticality: SEG.CRITICALITY.map((level) => ({ level: level, count: suppliers.filter((s) => s.criticality === level).length }))
    },
    documents: {
      current: current.length,
      versions: docs.length,
      renewals: docs.filter((d) => d.replaces_doc_id).length,
      awaitingExtraction: queue.length,
      byClass: [SEG.DOC_CLASS.CONTRACT, SEG.DOC_CLASS.LICENCE, SEG.DOC_CLASS.CERTIFICATE]
        .map((cls) => ({ documentClass: cls, count: current.filter((d) => d.document_class === cls).length }))
    },
    coverage: coverage,
    attention: attention.slice(0, 6),
    attentionTotal: attention.length,
    activity: activity,
    modules: {
      extraction: typeof M2_extractDocument === 'function',
      assessment: typeof M3_assessDocuments === 'function',
      notifications: typeof M4_prepareNotifications === 'function'
    }
  };
}
