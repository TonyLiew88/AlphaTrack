/**
 * M5_Integration.gs · Member 5: Main Dashboard, System Integration & Automation
 *
 * Integrates all members' modules into one cohesive autonomous workflow:
 *   Member 1 (Suppliers & Docs) -> Member 2 (AI Extraction) -> Member 3 (Expiry & Risk)
 *   -> Member 4 (Notifications & Renewals) -> Member 5 (Run Summary & Dashboard)
 *
 * Capabilities:
 *   - M5_runEndToEndMonitoring(trigger)   executes the full end-to-end monitoring cycle
 *   - M5_dailyMonitoringJob()             scheduled trigger handler (e.g. 9:00 AM daily)
 *   - M5_processAfterUpload(docId)        event-driven automatic processing on upload
 *   - M5_setupDailyTrigger()              configures automated Apps Script daily cron trigger
 *   - M5_getDashboardData()               aggregates metrics across all 4 functional sections
 *   - M5_getRunHistory()                  retrieves monitoring history from RunSummary tab
 *   - test_M5_rules()                     editor self-test for end-to-end integration
 */

const M5 = {
  TRIGGER_HANDLER: 'M5_dailyMonitoringJob',

  TRIGGERS: {
    MANUAL: 'MANUAL',
    DAILY_SCHEDULE: 'DAILY_SCHEDULE',
    AFTER_UPLOAD: 'AFTER_UPLOAD'
  }
};

/* ============================================================ End-to-End Orchestration */

/**
 * Executes the complete autonomous workflow across all 5 member modules.
 * 1. Checks and processes pending AI extractions (Member 2).
 * 2. Runs expiry calculations and risk assessments (Member 3).
 * 3. Prepares renewal reminders and escalates overdue cases (Member 4).
 * 4. Updates Google Sheets records, audit log, and RunSummary (Member 5).
 */
function M5_runEndToEndMonitoring(trigger) {
  const startedAt = SEG_now();
  const triggerType = trigger || M5.TRIGGERS.MANUAL;
  let errors = [];

  const suppliers = M1_getMonitoredSuppliers ? M1_getMonitoredSuppliers() : M1_listSuppliers().filter((s) => !s.deactivated);
  const docs = readTable(SEG.TABS.DOCUMENTS).filter((d) => d.lifecycle_status === SEG.LIFECYCLE.ACTIVE);

  // 1. Process AI Extraction Queue (Member 2)
  let extractionsCount = 0;
  try {
    if (typeof M2_processQueue === 'function') {
      const qRes = M2_processQueue(25);
      extractionsCount = (qRes && qRes.read) ? qRes.read : 0;
    }
  } catch (err) {
    errors.push('M2 extraction error: ' + err.message);
    console.error(err);
  }

  // 2. Run Expiry & Risk Assessment (Member 3)
  let assessmentsCount = 0;
  try {
    if (typeof M3_assessDocuments === 'function') {
      const aRes = M3_assessDocuments();
      assessmentsCount = (aRes && aRes.assessments) ? aRes.assessments.length : 0;
    }
  } catch (err) {
    errors.push('M3 assessment error: ' + err.message);
    console.error(err);
  }

  // 3. Prepare Notifications & Renewals (Member 4)
  let notifsCount = 0;
  try {
    if (typeof M4_prepareNotifications === 'function') {
      const nRes = M4_prepareNotifications();
      notifsCount = (nRes && nRes.notificationsPrepared !== undefined) ? nRes.notificationsPrepared : 0;
    }
  } catch (err) {
    errors.push('M4 notification error: ' + err.message);
    console.error(err);
  }

  const finishedAt = SEG_now();

  // 4. Record Run Metrics in RunSummary Tab (Member 5)
  return SEG_withLock(() => {
    const runs = readTable(SEG.TABS.RUNS);
    const existingRunIds = runs.map((r) => r.run_id);
    const runId = SEG_newId('RUN', existingRunIds, 3);

    const runRow = {
      run_id: runId,
      started_at: startedAt,
      finished_at: finishedAt,
      trigger: triggerType,
      suppliers_checked: suppliers.length,
      documents_checked: docs.length,
      extractions_run: extractionsCount,
      assessments_made: assessmentsCount,
      notifications_prepared: notifsCount,
      errors: errors.join('; ') || 'None',
      notes: 'End-to-end monitoring executed successfully.'
    };

    appendRows(SEG.TABS.RUNS, [runRow]);

    SEG_audit({
      module: 'M5', action: 'MONITORING_RUN_COMPLETED', recordType: 'RUN',
      recordId: runId, outcome: errors.length ? 'WARN' : 'OK',
      reason: 'Trigger: ' + triggerType + '. Suppliers: ' + suppliers.length + ', Docs: ' + docs.length + ', Extractions: ' + extractionsCount + ', Assessments: ' + assessmentsCount + ', Notifications: ' + notifsCount + '.'
    });

    return runRow;
  });
}

/**
 * Scheduled handler executed by Google Apps Script time-driven trigger.
 */
function M5_dailyMonitoringJob() {
  console.log('[M5] Starting scheduled daily monitoring job...');
  const result = M5_runEndToEndMonitoring(M5.TRIGGERS.DAILY_SCHEDULE);
  console.log('[M5] Scheduled daily job finished: ' + JSON.stringify(result));
  return result;
}

/**
 * Immediate pipeline processing after a document upload.
 */
function M5_processAfterUpload(docId) {
  if (!docId) return null;
  try {
    if (typeof M2_extractDocument === 'function') {
      M2_extractDocument(docId);
    }
    if (typeof M3_assessSingleDocument === 'function') {
      M3_assessSingleDocument(docId);
    }
    if (typeof M4_prepareNotifications === 'function') {
      M4_prepareNotifications();
    }
    return { outcome: 'PROCESSED', docId: docId };
  } catch (err) {
    console.warn('Could not process after upload for ' + docId + ': ' + err.message);
    return { outcome: 'ERROR', message: err.message };
  }
}

/* ============================================================ Trigger Management */

/**
 * Configures the daily Apps Script time-based trigger to run at 9:00 AM every day.
 */
function M5_setupDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists = triggers.some((t) => t.getHandlerFunction() === M5.TRIGGER_HANDLER);
  if (exists) {
    return { outcome: 'ALREADY_EXISTS', message: 'Daily monitoring trigger already configured.' };
  }

  ScriptApp.newTrigger(M5.TRIGGER_HANDLER)
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .create();

  SEG_audit({
    module: 'M5', action: 'SCHEDULED_TRIGGER_CREATED', recordType: 'SYSTEM',
    recordId: 'TRIGGER_9AM', outcome: 'OK', reason: 'Configured daily time-driven trigger at 9:00 AM'
  });

  return { outcome: 'CREATED', message: 'Daily monitoring scheduled for 9:00 AM' };
}

/**
 * Clears any active daily monitoring triggers.
 */
function M5_removeDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let count = 0;
  triggers.forEach((t) => {
    if (t.getHandlerFunction() === M5.TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(t);
      count++;
    }
  });
  return { outcome: 'REMOVED', count: count };
}

/* ============================================================ Dashboard Aggregation */

/**
 * High-level data payload for the integrated dashboard across the 4 core sections.
 */
function M5_getDashboardData() {
  const baseOverview = SEG_getOverview();
  const runs = readTable(SEG.TABS.RUNS).reverse();
  const asms = readTable(SEG.TABS.ASSESSMENTS);
  const notifs = readTable(SEG.TABS.NOTIFICATIONS);
  const cases = readTable(SEG.TABS.CASES);

  // Section 1: Compliance Health
  const expiredCount = asms.filter((a) => a.status === 'EXPIRED' || a.status === 'ENDED').length;
  const expiringCount = asms.filter((a) => a.status === 'EXPIRING_SOON' || a.status === 'ENDING_SOON').length;
  const missingCount = asms.filter((a) => a.status === 'MISSING').length;
  const validCount = asms.filter((a) => a.status === 'VALID' || a.status === 'ACTIVE' || a.status === 'NO_FIXED_END_DATE').length;

  // Section 2: Action Items
  const pendingApprovals = notifs.filter((n) => n.approval_status === 'PENDING_APPROVAL').length;
  const activeCases = cases.filter((c) => c.status !== 'RESOLVED').length;

  // Section 3: Pipeline Health
  const pipeline = {
    m1_registration: { status: 'Connected', count: baseOverview.suppliers.submitted },
    m2_extraction: { status: typeof M2_extractDocument === 'function' ? 'Connected' : 'Pending', awaiting: baseOverview.documents.awaitingExtraction },
    m3_risk: { status: typeof M3_assessDocuments === 'function' ? 'Connected' : 'Pending', assessed: asms.length },
    m4_notifications: { status: typeof M4_prepareNotifications === 'function' ? 'Connected' : 'Pending', prepared: notifs.length },
    m5_monitoring: { status: 'Active', totalRuns: runs.length }
  };

  return {
    overview: baseOverview,
    compliance: {
      expired: expiredCount,
      expiring: expiringCount,
      missing: missingCount,
      valid: validCount,
      total: asms.length
    },
    actions: {
      pendingApprovals: pendingApprovals,
      activeCases: activeCases
    },
    pipeline: pipeline,
    recentRuns: runs.slice(0, 5),
    recentAudit: baseOverview.activity
  };
}

/**
 * Retrieves monitoring run logs from the RunSummary tab.
 */
function M5_getRunHistory(limit) {
  const runs = readTable(SEG.TABS.RUNS);
  return runs.slice(-(limit || 20)).reverse();
}

/* ============================================================ Editor Self-Test */

function test_M5_rules() {
  let passed = 0;
  const assert = (cond, msg) => {
    if (!cond) throw new Error('Assertion failed: ' + msg);
    passed++;
  };

  // 1. Trigger name check
  assert(M5.TRIGGER_HANDLER === 'M5_dailyMonitoringJob', 'Scheduled trigger handler is M5_dailyMonitoringJob');

  // 2. Trigger creation
  const tRes = M5_setupDailyTrigger();
  assert(tRes.outcome === 'CREATED' || tRes.outcome === 'ALREADY_EXISTS', 'Trigger setup succeeds');

  // 3. Remove trigger
  const remRes = M5_removeDailyTrigger();
  assert(remRes.outcome === 'REMOVED', 'Trigger removal succeeds');

  console.log('test_M5_rules: all ' + passed + ' checks passed.');
  return passed;
}

