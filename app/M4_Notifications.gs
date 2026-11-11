/**
 * M4_Notifications.gs · Member 4: Automated Notifications & Renewal Management
 *
 * Automatically monitors Member 3's compliance assessments, opens and tracks renewal cases,
 * drafts professional Gmail reminders and urgent escalations, implements human-in-the-loop
 * approval controls, enforces duplicate prevention, and maintains audit trails.
 *
 * Main functions:
 *   M4_prepareNotifications(options)    prepare reminders & sync cases from assessments
 *   M4_approveNotification(id, note)   officer approves and sends an email draft
 *   M4_rejectNotification(id, reason)  officer dismisses a drafted email
 *   M4_approveAllPending()             bulk approves all pending reminder drafts
 *   M4_getNotificationsPage()          data payload for the browser UI
 *   M4_getNotificationDetail(id)       retrieve rendered email preview and metadata
 *   M4_resolveCase(caseId, note)       manually close a renewal case
 *   test_M4_rules()                    editor self-test for notification rules
 *
 * Settings (Project Settings → Script properties, optional):
 *   COMPLIANCE_MANAGER_EMAIL   receives internal escalations and review alerts when the
 *                              supplier's internal officer field is a name, not an email.
 *
 * Writes: Notifications (SEG.TABS.NOTIFICATIONS), RenewalCases (SEG.TABS.CASES), AuditLog.
 * Reads:  Assessments (Member 3), Suppliers (Member 1), Documents (Member 1).
 */

const M4 = {
  STAGES: {
    FIRST_REMINDER: 'FIRST_REMINDER',         // 1st advance renewal reminder (> 14 days)
    FOLLOW_UP: 'FOLLOW_UP',                   // 2nd follow-up reminder (<= 14 days or due)
    URGENT_ESCALATION: 'URGENT_ESCALATION',   // Overdue/expired escalation alert
    SUBMISSION_REQUEST: 'SUBMISSION_REQUEST', // Request for missing mandatory document
    REVIEW_ALERT: 'REVIEW_ALERT',             // Internal officer alert for defective scans
    INTERNAL_ESCALATION: 'INTERNAL_ESCALATION' // Internal alert: expired, critical, or no reply after follow-up
  },

  TYPES: {
    EMAIL_EXTERNAL: 'EMAIL_EXTERNAL', // Sent to external supplier contact
    EMAIL_INTERNAL: 'EMAIL_INTERNAL'  // Sent to internal Alpha Electronics officer
  },

  APPROVAL: {
    PENDING_APPROVAL: 'PENDING_APPROVAL', // Awaiting officer sign-off
    APPROVED: 'APPROVED',                 // Signed off and sent/queued
    REJECTED: 'REJECTED',                 // Rejected by officer
    AUTO_APPROVED: 'AUTO_APPROVED'        // System auto-approved (internal alerts)
  },

  DELIVERY: {
    DRAFT: 'DRAFT',     // Prepared draft waiting for approval
    QUEUED: 'QUEUED',   // Ready to be sent
    SENT: 'SENT',       // Dispatched via GmailApp
    FAILED: 'FAILED'    // Transmission error
  },

  CASE_STATUS: {
    OPEN: 'OPEN',
    ESCALATED: 'ESCALATED',
    RESOLVED: 'RESOLVED'
  },

  CASE_TYPES: {
    EXPIRY_RENEWAL: 'EXPIRY_RENEWAL',
    CONTRACT_RENEWAL: 'CONTRACT_RENEWAL',
    EXPIRED_ESCALATION: 'EXPIRED_ESCALATION',
    ENDED_ESCALATION: 'ENDED_ESCALATION',
    MISSING_DOCUMENT: 'MISSING_DOCUMENT',
    MANUAL_REVIEW: 'MANUAL_REVIEW'
  },

  // Assessment statuses (from Member 3) that need a case and emails
  ACTION_STATUSES: ['EXPIRING_SOON', 'ENDING_SOON', 'EXPIRED', 'ENDED', 'MISSING', 'NEEDS_REVIEW'],

  FOLLOW_UP_INTERVAL_DAYS: 7, // Days after an email is sent with no replacement before the next step
  FOLLOW_UP_WITHIN_DAYS: 14,  // A follow-up also goes out once the due date is this close

  // Script property: who gets internal escalations when a supplier's internal officer has no email
  MANAGER_EMAIL_PROPERTY: 'COMPLIANCE_MANAGER_EMAIL'
};

/* ============================================================ Core Workflow Entry Point */

/**
 * Main entry point: reads Member 3's assessments, opens or updates RenewalCases and drafts
 * the emails each case needs. Safe to run any number of times a day: nothing is drafted twice.
 *
 * For every case that needs action, one email chain:
 *   1. First notice to the supplier (FIRST_REMINDER, URGENT_ESCALATION if already expired,
 *      or SUBMISSION_REQUEST if missing). Waits for officer approval.
 *   2. FOLLOW_UP to the supplier when the last email was sent 7+ days ago and the case is still
 *      open, or when the due date is 14 days away or less. Once per case; waits for approval.
 *   3. INTERNAL_ESCALATION to the responsible person inside Alpha Electronics when the document
 *      has expired or ended, the risk is CRITICAL, or the follow-up was sent 7+ days ago and the
 *      case is still open. Once per case; sent straight away (it never leaves the company).
 * NEEDS_REVIEW items only get an internal REVIEW_ALERT (sent straight away).
 * A case closes by itself when Member 3 next rates its document VALID or ACTIVE; any drafts
 * still waiting for approval are then cancelled so they can't be sent by mistake.
 *
 * options: { referenceDate: 'yyyy-MM-dd' (default today),
 *            assessments: [...] (used instead of asking Member 3; for tests) }
 * Returns: { actionableItems, casesOpened, casesUpdated, casesResolved, notificationsPrepared,
 *            pendingApproval, followUpsPrepared, escalations, internalSent, internalFailed }
 */
function M4_prepareNotifications(options) {
  const opts = options || {};
  const refDate = opts.referenceDate || SEG_today();

  // Retrieve current assessments from Member 3
  let assessments = opts.assessments;
  if (!assessments) {
    assessments = typeof M3_getAssessments === 'function'
      ? M3_getAssessments({ referenceDate: refDate })
      : [];
  }

  const suppliers = readTable(SEG.TABS.SUPPLIERS);
  const supMap = {};
  suppliers.forEach((s) => { supMap[s.supplier_id] = s; });

  const docs = readTable(SEG.TABS.DOCUMENTS);
  const docMap = {};
  docs.forEach((d) => { docMap[d.doc_id] = d; });

  const result = SEG_withLock(() => {
    const existingCases = readTable(SEG.TABS.CASES);
    const existingNotifications = readTable(SEG.TABS.NOTIFICATIONS);

    const caseIds = existingCases.map((c) => c.case_id);
    const notifIds = existingNotifications.map((n) => n.notification_id);

    const newCases = [];
    const newNotifications = [];
    const counts = { casesUpdated: 0, casesResolved: 0, followUps: 0, escalations: 0 };

    // Every email ever drafted for a case, rejected ones included: an officer who rejects a
    // reminder has decided it should not go out, so it is not drafted again the next morning.
    const notifsOf = (caseId) => existingNotifications.filter((n) => n.case_id === caseId);
    const hasStage = (caseId, stage) => notifsOf(caseId).some((n) => n.stage === stage);

    const draft = (caseRow, item, sup, stage) => {
      const internal = M4_isInternalStage(stage);
      const recipient = internal ? M4_internalRecipient(sup) : (sup.contact_email || '');
      if (!recipient) return null;
      const notifId = SEG_newId('NOT', notifIds, 3);
      notifIds.push(notifId);
      const row = {
        notification_id: notifId,
        case_id: caseRow.case_id,
        supplier_id: item.supplierId,
        doc_id: item.docId || '',
        stage: stage,
        notification_type: internal ? M4.TYPES.EMAIL_INTERNAL : M4.TYPES.EMAIL_EXTERNAL,
        recipient: recipient,
        subject: M4_formatSubject(stage, item, sup),
        approval_status: internal ? M4.APPROVAL.AUTO_APPROVED : M4.APPROVAL.PENDING_APPROVAL,
        delivery_status: internal ? M4.DELIVERY.QUEUED : M4.DELIVERY.DRAFT,
        created_at: SEG_now(),
        approved_by: internal ? 'SYSTEM' : '',
        approved_at: internal ? SEG_now() : '',
        sent_at: '',
        follow_up_due: '' // set when the email is actually sent: the 7-day clock starts then
      };
      newNotifications.push(row);
      existingNotifications.push(row);
      return row;
    };

    const escalate = (caseRow, reason) => {
      if (caseRow.status !== M4.CASE_STATUS.ESCALATED) {
        caseRow.status = M4.CASE_STATUS.ESCALATED;
        if (caseRow._row) {
          updateRow(SEG.TABS.CASES, caseRow._row, { status: M4.CASE_STATUS.ESCALATED });
          counts.casesUpdated++;
        }
        SEG_audit({
          module: 'M4', action: 'CASE_ESCALATED', recordType: 'CASE', recordId: caseRow.case_id,
          supplierId: caseRow.supplier_id, outcome: 'ESCALATED', reason: reason
        });
      }
    };

    // Filter assessments that need action
    const actionable = assessments.filter((a) => M4.ACTION_STATUSES.indexOf(a.status) !== -1);

    actionable.forEach((item) => {
      const sup = supMap[item.supplierId] || {};
      const doc = docMap[item.docId] || {};
      const reqId = item.requirementId || doc.requirement_id || '';
      const caseType = M4_caseTypeFor(item.status);

      // One open case per supplier requirement (or per document when there is no requirement)
      let caseRow = existingCases.find((c) =>
        c.supplier_id === item.supplierId &&
        c.requirement_id === reqId &&
        (reqId || c.doc_id === (item.docId || '')) &&
        c.status !== M4.CASE_STATUS.RESOLVED);

      if (!caseRow) {
        const caseId = SEG_newId('CAS', caseIds, 3);
        caseIds.push(caseId);
        caseRow = {
          case_id: caseId,
          supplier_id: item.supplierId,
          requirement_id: reqId,
          doc_id: item.docId || '',
          case_type: caseType,
          status: M4.CASE_STATUS.OPEN,
          opened_at: SEG_now(),
          resolved_at: '',
          resolution: ''
        };
        newCases.push(caseRow);
        existingCases.push(caseRow);
      } else if (caseRow.case_type !== caseType && caseRow._row) {
        // e.g. an expiring document has now expired
        caseRow.case_type = caseType;
        updateRow(SEG.TABS.CASES, caseRow._row, { case_type: caseType, doc_id: item.docId || caseRow.doc_id });
        counts.casesUpdated++;
      }
      const caseId = caseRow.case_id;

      // Documents a person must check: internal alert only, no supplier chain
      if (item.status === 'NEEDS_REVIEW') {
        if (!hasStage(caseId, M4.STAGES.REVIEW_ALERT)) draft(caseRow, item, sup, M4.STAGES.REVIEW_ALERT);
        return;
      }

      // 1. First notice to the supplier
      const firstStage = M4_firstStageFor(item.status);
      if (!hasStage(caseId, firstStage)) draft(caseRow, item, sup, firstStage);

      // 2. Follow-up to the supplier
      const sentExternal = notifsOf(caseId).filter((n) =>
        n.notification_type === M4.TYPES.EMAIL_EXTERNAL && n.delivery_status === M4.DELIVERY.SENT);
      const lastSent = sentExternal[sentExternal.length - 1];
      const noReply = !!lastSent && M4_isDue(lastSent.follow_up_due, refDate);
      const dueSoon = sentExternal.length > 0 && item.daysRemaining !== null && item.daysRemaining !== undefined &&
        item.daysRemaining >= 0 && item.daysRemaining <= M4.FOLLOW_UP_WITHIN_DAYS;
      if (!hasStage(caseId, M4.STAGES.FOLLOW_UP) && (noReply || dueSoon)) {
        if (draft(caseRow, item, sup, M4.STAGES.FOLLOW_UP)) counts.followUps++;
      }

      // 3. Internal escalation
      const sentFollowUp = sentExternal.filter((n) => n.stage === M4.STAGES.FOLLOW_UP)[0];
      let why = '';
      if (item.status === 'EXPIRED' || item.status === 'ENDED') why = 'Document has ' + item.status.toLowerCase() + '.';
      else if (item.riskLevel === 'CRITICAL') why = 'Risk level is CRITICAL.';
      else if (sentFollowUp && M4_isDue(sentFollowUp.follow_up_due, refDate)) {
        why = 'No replacement received ' + M4.FOLLOW_UP_INTERVAL_DAYS + ' days after the follow-up (' + sentFollowUp.notification_id + ').';
      }
      if (why) {
        escalate(caseRow, why);
        if (!hasStage(caseId, M4.STAGES.INTERNAL_ESCALATION)) {
          if (draft(caseRow, Object.assign({}, item, { escalationReason: why }), sup, M4.STAGES.INTERNAL_ESCALATION)) counts.escalations++;
        }
      }
    });

    // Open cases whose document is now VALID or ACTIVE: close them and cancel unsent drafts
    assessments.filter((a) => a.status === 'VALID' || a.status === 'ACTIVE').forEach((v) => {
      const reqId = v.requirementId || '';
      existingCases.filter((c) =>
        c.supplier_id === v.supplierId &&
        c.requirement_id === reqId &&
        (reqId || c.doc_id === (v.docId || '')) &&
        c.status !== M4.CASE_STATUS.RESOLVED &&
        c._row
      ).forEach((openCase) => {
        const resolution = 'Document renewed and verified compliant on ' + refDate + ' (' + (v.docId || 'replacement') + ').';
        openCase.status = M4.CASE_STATUS.RESOLVED;
        updateRow(SEG.TABS.CASES, openCase._row, {
          status: M4.CASE_STATUS.RESOLVED, resolved_at: SEG_now(), resolution: resolution
        });
        M4_cancelPendingDrafts(openCase.case_id, existingNotifications, 'Case resolved: ' + resolution);
        SEG_audit({
          module: 'M4', action: 'CASE_RESOLVED', recordType: 'CASE', recordId: openCase.case_id,
          supplierId: openCase.supplier_id, outcome: 'RESOLVED', reason: resolution
        });
        counts.casesResolved++;
      });
    });

    // Save new cases and notifications
    if (newCases.length) appendRows(SEG.TABS.CASES, newCases);
    if (newNotifications.length) appendRows(SEG.TABS.NOTIFICATIONS, newNotifications);

    return { actionable: actionable, newCases: newCases, newNotifications: newNotifications, counts: counts };
  });

  // Send internal emails now that their rows exist, so each row can be marked SENT or FAILED
  let internalSent = 0;
  let internalFailed = 0;
  const queuedIds = result.newNotifications
    .filter((n) => n.delivery_status === M4.DELIVERY.QUEUED)
    .map((n) => n.notification_id);
  if (queuedIds.length) {
    readTable(SEG.TABS.NOTIFICATIONS)
      .filter((n) => queuedIds.indexOf(n.notification_id) !== -1)
      .forEach((n) => {
        if (M4_sendSingleEmail(n)) internalSent++;
        else internalFailed++;
      });
  }

  const summary = {
    actionableItems: result.actionable.length,
    casesOpened: result.newCases.length,
    casesUpdated: result.counts.casesUpdated,
    casesResolved: result.counts.casesResolved,
    notificationsPrepared: result.newNotifications.length,
    pendingApproval: result.newNotifications.filter((n) => n.approval_status === M4.APPROVAL.PENDING_APPROVAL).length,
    followUpsPrepared: result.counts.followUps,
    escalations: result.counts.escalations,
    internalSent: internalSent,
    internalFailed: internalFailed
  };

  SEG_audit({
    module: 'M4', action: 'NOTIFICATIONS_PREPARED', recordType: 'BATCH', recordId: 'RUN',
    outcome: 'OK',
    reason: 'Prepared ' + summary.notificationsPrepared + ' email(s) across ' + summary.casesOpened + ' new case(s): ' +
      summary.followUpsPrepared + ' follow-up(s), ' + summary.escalations + ' escalation(s), ' +
      summary.casesResolved + ' case(s) resolved.'
  });

  return summary;
}

/* ============================================================ Rules (small, testable helpers) */

function M4_caseTypeFor(status) {
  switch (status) {
    case 'ENDING_SOON': return M4.CASE_TYPES.CONTRACT_RENEWAL;
    case 'EXPIRED': return M4.CASE_TYPES.EXPIRED_ESCALATION;
    case 'ENDED': return M4.CASE_TYPES.ENDED_ESCALATION;
    case 'MISSING': return M4.CASE_TYPES.MISSING_DOCUMENT;
    case 'NEEDS_REVIEW': return M4.CASE_TYPES.MANUAL_REVIEW;
    default: return M4.CASE_TYPES.EXPIRY_RENEWAL;
  }
}

/** The first email a supplier gets for a case in this status. */
function M4_firstStageFor(status) {
  if (status === 'EXPIRED' || status === 'ENDED') return M4.STAGES.URGENT_ESCALATION;
  if (status === 'MISSING') return M4.STAGES.SUBMISSION_REQUEST;
  if (status === 'NEEDS_REVIEW') return M4.STAGES.REVIEW_ALERT;
  return M4.STAGES.FIRST_REMINDER;
}

function M4_isInternalStage(stage) {
  return stage === M4.STAGES.REVIEW_ALERT || stage === M4.STAGES.INTERNAL_ESCALATION;
}

/** True when a 'yyyy-MM-dd' due date is on or before the reference date. Blank is never due. */
function M4_isDue(dueDate, refDate) {
  const due = String(dueDate || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(due) && due <= String(refDate).slice(0, 10);
}

/**
 * Who inside Alpha Electronics gets internal alerts and escalations for a supplier:
 * the supplier's internal officer if that field holds an email address, otherwise the
 * COMPLIANCE_MANAGER_EMAIL script property, otherwise the account the app runs as.
 */
function M4_internalRecipient(sup) {
  const officer = String((sup && (sup.internal_officer || sup.internalOfficer)) || '').trim();
  if (SEG_isEmail(officer)) return officer;
  let manager = '';
  try {
    manager = String(PropertiesService.getScriptProperties().getProperty(M4.MANAGER_EMAIL_PROPERTY) || '').trim();
  } catch (err) {
    manager = '';
  }
  if (SEG_isEmail(manager)) return manager;
  let owner = '';
  try {
    owner = Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail();
  } catch (err) {
    owner = '';
  }
  return SEG_isEmail(owner) ? owner : '';
}

/** Cancels a case's drafts still waiting for approval, so they can't be sent after it closes. */
function M4_cancelPendingDrafts(caseId, notifications, reason) {
  (notifications || readTable(SEG.TABS.NOTIFICATIONS))
    .filter((n) => n.case_id === caseId && n.approval_status === M4.APPROVAL.PENDING_APPROVAL && n._row)
    .forEach((n) => {
      const update = {
        approval_status: M4.APPROVAL.REJECTED, approved_by: 'SYSTEM', approved_at: SEG_now(), delivery_status: 'CANCELLED'
      };
      Object.assign(n, update);
      updateRow(SEG.TABS.NOTIFICATIONS, n._row, update);
      SEG_audit({
        module: 'M4', action: 'NOTIFICATION_CANCELLED', recordType: 'NOTIFICATION', recordId: n.notification_id,
        supplierId: n.supplier_id, outcome: 'CANCELLED', reason: reason
      });
    });
}

/* ============================================================ Approval & Sending Actions */

/**
 * Human-in-the-loop: An officer reviews and approves an email notification.
 * Marks it APPROVED and dispatches the email via Gmail.
 */
function M4_approveNotification(notificationId, officerNote) {
  const notifList = readTable(SEG.TABS.NOTIFICATIONS);
  const row = notifList.find((n) => n.notification_id === notificationId);
  if (!row) throw new Error('Notification ' + notificationId + ' was not found.');

  if (row.approval_status === M4.APPROVAL.APPROVED && row.delivery_status === M4.DELIVERY.SENT) {
    return { outcome: 'ALREADY_SENT', message: 'Notification already approved and sent.' };
  }
  if (row.approval_status === M4.APPROVAL.REJECTED) {
    throw new Error('Notification ' + notificationId + ' was rejected or cancelled, so it cannot be sent.');
  }

  return SEG_withLock(() => {
    const officer = SEG_currentUser();
    const update = {
      approval_status: M4.APPROVAL.APPROVED,
      approved_by: officer,
      approved_at: SEG_now(),
      delivery_status: M4.DELIVERY.QUEUED
    };
    updateRow(SEG.TABS.NOTIFICATIONS, row._row, update);

    // Send the email
    Object.assign(row, update);
    const sentOk = M4_sendSingleEmail(row);

    SEG_audit({
      module: 'M4', action: 'NOTIFICATION_APPROVED', recordType: 'NOTIFICATION',
      recordId: notificationId, supplierId: row.supplier_id, outcome: sentOk ? 'SENT' : 'FAILED',
      reason: 'Approved by ' + officer + (officerNote ? ': ' + officerNote : '')
    });

    return {
      notificationId: notificationId,
      approvalStatus: M4.APPROVAL.APPROVED,
      deliveryStatus: sentOk ? M4.DELIVERY.SENT : M4.DELIVERY.FAILED,
      recipient: row.recipient
    };
  });
}

/**
 * Officer rejects / cancels a notification draft.
 */
function M4_rejectNotification(notificationId, reason) {
  const notifList = readTable(SEG.TABS.NOTIFICATIONS);
  const row = notifList.find((n) => n.notification_id === notificationId);
  if (!row) throw new Error('Notification ' + notificationId + ' was not found.');

  return SEG_withLock(() => {
    const officer = SEG_currentUser();
    const update = {
      approval_status: M4.APPROVAL.REJECTED,
      approved_by: officer,
      approved_at: SEG_now(),
      delivery_status: 'CANCELLED'
    };
    updateRow(SEG.TABS.NOTIFICATIONS, row._row, update);

    SEG_audit({
      module: 'M4', action: 'NOTIFICATION_REJECTED', recordType: 'NOTIFICATION',
      recordId: notificationId, supplierId: row.supplier_id, outcome: 'REJECTED',
      reason: 'Rejected by ' + officer + ': ' + (reason || 'Dismissed by user')
    });

    return { notificationId: notificationId, status: M4.APPROVAL.REJECTED };
  });
}

/**
 * Bulk approves all notifications currently in PENDING_APPROVAL.
 */
function M4_approveAllPending() {
  const notifList = readTable(SEG.TABS.NOTIFICATIONS);
  const pending = notifList.filter((n) => n.approval_status === M4.APPROVAL.PENDING_APPROVAL);

  let approvedCount = 0;
  pending.forEach((p) => {
    try {
      M4_approveNotification(p.notification_id, 'Bulk approved via dashboard');
      approvedCount++;
    } catch (err) {
      console.warn('Could not approve ' + p.notification_id + ': ' + err.message);
    }
  });

  return { approvedCount: approvedCount, totalPending: pending.length };
}

/**
 * Manually closes/resolves a renewal case.
 */
function M4_resolveCase(caseId, resolutionNote) {
  const cases = readTable(SEG.TABS.CASES);
  const c = cases.find((x) => x.case_id === caseId);
  if (!c) throw new Error('Case ' + caseId + ' not found.');

  return SEG_withLock(() => {
    updateRow(SEG.TABS.CASES, c._row, {
      status: M4.CASE_STATUS.RESOLVED,
      resolved_at: SEG_now(),
      resolution: resolutionNote || 'Manually resolved by officer'
    });
    M4_cancelPendingDrafts(caseId, null, 'Case closed by officer: ' + (resolutionNote || 'manual resolution'));

    SEG_audit({
      module: 'M4', action: 'CASE_RESOLVED', recordType: 'CASE', recordId: caseId,
      supplierId: c.supplier_id, outcome: 'RESOLVED', reason: resolutionNote || 'Manual resolution'
    });

    return { caseId: caseId, status: M4.CASE_STATUS.RESOLVED };
  });
}

/* ============================================================ Email Transmission & Templating */

/**
 * Dispatches an approved email through GmailApp.
 */
function M4_sendSingleEmail(notification) {
  const fail = (why) => {
    console.error('Email ' + notification.notification_id + ' not sent: ' + why);
    if (notification._row) {
      updateRow(SEG.TABS.NOTIFICATIONS, notification._row, { delivery_status: M4.DELIVERY.FAILED });
    }
    notification.delivery_status = M4.DELIVERY.FAILED;
    return false;
  };

  const recipient = notification.recipient;
  if (!recipient || !SEG_isEmail(recipient)) return fail('invalid recipient "' + recipient + '"');
  // Never record an email as SENT unless Gmail really accepted it
  if (typeof GmailApp === 'undefined' || !GmailApp.sendEmail) return fail('Gmail is not available');

  const subject = notification.subject || 'Alpha Electronics Compliance Notification';
  const emailContent = M4_renderEmail(notification);

  try {
    GmailApp.sendEmail(recipient, subject, emailContent.plainText, {
      name: 'Alpha Electronics Procurement Compliance',
      htmlBody: emailContent.htmlBody
    });
  } catch (err) {
    return fail(err.message);
  }

  const update = { delivery_status: M4.DELIVERY.SENT, sent_at: SEG_now() };
  // Supplier emails start the follow-up clock: no replacement by this date → next step
  if (notification.notification_type === M4.TYPES.EMAIL_EXTERNAL) {
    update.follow_up_due = M4_calculateFollowUpDate(SEG_today(), M4.FOLLOW_UP_INTERVAL_DAYS);
  }
  if (notification._row) updateRow(SEG.TABS.NOTIFICATIONS, notification._row, update);
  Object.assign(notification, update);
  return true;
}

/**
 * Formats a clean email subject line.
 */
function M4_formatSubject(stage, item, supplier) {
  const prefix = '[Alpha Electronics Compliance] ';
  const docName = item.docTypeName || 'Document';
  const supName = supplier.supplier_name || supplier.supplierName || item.supplierName || 'Supplier';

  switch (stage) {
    case M4.STAGES.FIRST_REMINDER:
      return prefix + 'Upcoming Expiry Notice: ' + docName + ' (' + supName + ')';
    case M4.STAGES.FOLLOW_UP:
      return prefix + 'Follow-up: ' + docName + ' Renewal Still Outstanding (' + supName + ')';
    case M4.STAGES.INTERNAL_ESCALATION:
      return prefix + 'ESCALATION: ' + supName + ', ' + docName + '. ' + (item.escalationReason || 'Action required.');
    case M4.STAGES.URGENT_ESCALATION:
      return prefix + 'COMPLIANCE ALERT: ' + docName + ' Has Expired — Action Required';
    case M4.STAGES.SUBMISSION_REQUEST:
      return prefix + 'Action Required: Missing Mandatory Document (' + docName + ')';
    case M4.STAGES.REVIEW_ALERT:
    default:
      return prefix + 'Officer Review Required: Document Verification for ' + supName;
  }
}

/**
 * Generates an HTML email body matching corporate branding.
 */
function M4_renderEmail(notification) {
  let sup = {};
  try {
    if (typeof M1_getSupplier === 'function') sup = M1_getSupplier(notification.supplier_id);
  } catch (err) {
    sup = {};
  }
  const supName = sup.supplierName || sup.supplier_name || 'Valued Supplier';
  const officer = sup.internalOfficer || sup.internal_officer || 'Alpha Electronics Procurement Officer';
  const stage = notification.stage;

  let headline = 'Supplier Document Compliance Notice';
  let message = '';
  let alertBadge = '<span style="display:inline-block;padding:4px 10px;border-radius:4px;background:#EEF0FF;color:#4F46E5;font-weight:700;font-size:12px;">ACTION REQUIRED</span>';

  if (stage === M4.STAGES.FIRST_REMINDER) {
    headline = 'Advance Renewal Reminder';
    message = 'Our automated compliance monitoring system indicates that your document is scheduled to expire in the near future. To prevent disruptions to our active procurement agreements, please submit the renewed document before the expiry date.';
    alertBadge = '<span style="display:inline-block;padding:4px 10px;border-radius:4px;background:#FFF2D6;color:#8A4B00;font-weight:700;font-size:12px;">UPCOMING EXPIRY</span>';
  } else if (stage === M4.STAGES.FOLLOW_UP) {
    headline = 'Renewal Follow-Up';
    message = 'This is a follow-up to our earlier notice. We have not yet received the renewed document, and its due date is close or has passed. Please submit the renewed document as soon as possible to keep your compliance record current.';
    alertBadge = '<span style="display:inline-block;padding:4px 10px;border-radius:4px;background:#FEECEB;color:#B42318;font-weight:700;font-size:12px;">URGENT FOLLOW-UP</span>';
  } else if (stage === M4.STAGES.URGENT_ESCALATION) {
    headline = 'Notice of Expired Certification';
    message = 'Your required certification or licence has passed its expiration date. Operating without valid documentation represents a compliance violation. Please submit the renewed certificate immediately.';
    alertBadge = '<span style="display:inline-block;padding:4px 10px;border-radius:4px;background:#B42318;color:#FFFFFF;font-weight:700;font-size:12px;">EXPIRED / NON-COMPLIANT</span>';
  } else if (stage === M4.STAGES.SUBMISSION_REQUEST) {
    headline = 'Submission Request for Mandatory Document';
    message = 'According to our approved procurement policy, your account requires a mandatory document that has not yet been submitted. Please upload the required documentation to complete your compliance register.';
  } else if (stage === M4.STAGES.INTERNAL_ESCALATION) {
    headline = 'Compliance Escalation';
    message = 'A supplier compliance case has been escalated to you: ' + supName + ' still has an expired, ending or unrenewed document, or the supplier has not responded to our reminder and follow-up. Please contact the supplier and decide whether work with them should continue until a valid document is received. The reason is in the subject line.';
    alertBadge = '<span style="display:inline-block;padding:4px 10px;border-radius:4px;background:#B42318;color:#FFFFFF;font-weight:700;font-size:12px;">ESCALATED</span>';
  } else {
    headline = 'Internal Compliance Review Alert';
    message = 'An uploaded document from ' + supName + ' requires officer verification due to unreadable text or mismatched company details. Please inspect the file in Google Drive.';
  }

  // Internal emails are addressed to the compliance team, not the supplier
  const internal = notification.notification_type === M4.TYPES.EMAIL_INTERNAL || M4_isInternalStage(stage);
  const greeting = internal ? 'Compliance Team' : supName;
  const signOff = internal ? 'AlphaTrack (automated compliance monitoring)' : officer;

  const htmlBody = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F8FAFC; margin: 0; padding: 24px; color: #1E293B; }
    .container { max-width: 600px; margin: 0 auto; background: #FFFFFF; border: 1px solid #E2E8F0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .header { background: #0F172A; padding: 24px 28px; color: #FFFFFF; }
    .brand { font-size: 18px; font-weight: 800; letter-spacing: -0.02em; }
    .brand span { color: #818CF8; }
    .content { padding: 28px; font-size: 14.5px; line-height: 1.6; }
    .footer { background: #F1F5F9; padding: 18px 28px; font-size: 12px; color: #64748B; border-top: 1px solid #E2E8F0; }
    .box { background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 8px; padding: 16px; margin: 18px 0; font-size: 13.5px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="brand">Alpha<span>Track</span> · Silent Expiry Guardian</div>
      <div style="font-size:12px;color:#94A3B8;margin-top:4px;">Alpha Electronics Sdn. Bhd. Procurement &amp; Compliance</div>
    </div>
    <div class="content">
      <div style="margin-bottom:14px;">${alertBadge}</div>
      <h2 style="font-size:20px;font-weight:700;margin:0 0 12px;color:#0F172A;">${headline}</h2>
      <p>Dear <strong>${greeting}</strong>,</p>
      <p>${message}</p>

      <div class="box">
        <div><strong>Notification ID:</strong> ${notification.notification_id}</div>
        <div><strong>Supplier ID:</strong> ${notification.supplier_id}</div>
        <div><strong>Document Reference:</strong> ${notification.doc_id || 'Mandatory Requirement'}</div>
        <div><strong>Stage:</strong> ${notification.stage}</div>
        ${internal ? '<div><strong>Supplier:</strong> ' + supName + '</div><div><strong>Case:</strong> ' + (notification.case_id || '-') + '</div>' : ''}
      </div>

      ${internal ? '' : '<p>If you have already submitted the replacement document, our AI verification system will verify it during the next automated cycle.</p>'}
      <p style="margin-top:24px;">Sincerely,<br><strong>${signOff}</strong><br>Procurement &amp; Vendor Management Team<br>Alpha Electronics Sdn. Bhd.</p>
    </div>
    <div class="footer">
      This is an automated notification managed by AlphaTrack (Silent Expiry Guardian). Inquiries can be directed to your Alpha Electronics responsible officer.
    </div>
  </div>
</body>
</html>`;

  const plainText = headline + '\n\n' +
    'Dear ' + greeting + ',\n\n' +
    message + '\n\n' +
    'Notification ID: ' + notification.notification_id + '\n' +
    'Supplier ID: ' + notification.supplier_id + '\n' +
    (internal ? 'Supplier: ' + supName + '\nCase: ' + (notification.case_id || '-') + '\n' : '') +
    'Document Reference: ' + (notification.doc_id || 'Mandatory Requirement') + '\n\n' +
    'Sincerely,\n' + signOff + '\nAlpha Electronics Sdn. Bhd.';

  return { htmlBody: htmlBody, plainText: plainText };
}

function M4_calculateFollowUpDate(refDateStr, daysAhead) {
  try {
    const parts = refDateStr.split('-');
    const d = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
    d.setUTCDate(d.getUTCDate() + (daysAhead || 7));
    return d.toISOString().split('T')[0];
  } catch (err) {
    return '';
  }
}

/* ============================================================ Query APIs for Dashboard */

/**
 * Returns complete data payload for the Notifications & Renewals dashboard page.
 */
function M4_getNotificationsPage() {
  const notifs = readTable(SEG.TABS.NOTIFICATIONS);
  const cases = readTable(SEG.TABS.CASES);
  const suppliers = readTable(SEG.TABS.SUPPLIERS);
  const supMap = {};
  suppliers.forEach((s) => { supMap[s.supplier_id] = s; });

  const enrichedNotifs = notifs.map((n) => {
    const s = supMap[n.supplier_id] || {};
    return {
      notificationId: n.notification_id,
      caseId: n.case_id,
      supplierId: n.supplier_id,
      supplierName: s.supplier_name || s.supplierName || 'Unknown Supplier',
      criticality: s.criticality || 'MEDIUM',
      docId: n.doc_id,
      stage: n.stage,
      notificationType: n.notification_type,
      recipient: n.recipient,
      subject: n.subject,
      approvalStatus: n.approval_status,
      deliveryStatus: n.delivery_status,
      createdAt: n.created_at,
      approvedBy: n.approved_by,
      approvedAt: n.approved_at,
      sentAt: n.sent_at,
      followUpDue: n.follow_up_due
    };
  }).reverse(); // Most recent first

  const enrichedCases = cases.map((c) => {
    const s = supMap[c.supplier_id] || {};
    return {
      caseId: c.case_id,
      supplierId: c.supplier_id,
      supplierName: s.supplier_name || s.supplierName || 'Unknown Supplier',
      criticality: s.criticality || 'MEDIUM',
      requirementId: c.requirement_id,
      docId: c.doc_id,
      caseType: c.case_type,
      status: c.status,
      openedAt: c.opened_at,
      resolvedAt: c.resolved_at,
      resolution: c.resolution
    };
  }).reverse();

  const pendingCount = notifs.filter((n) => n.approval_status === M4.APPROVAL.PENDING_APPROVAL).length;
  const sentCount = notifs.filter((n) => n.delivery_status === M4.DELIVERY.SENT).length;
  const urgentCount = notifs.filter((n) => n.stage === M4.STAGES.URGENT_ESCALATION || n.stage === M4.STAGES.INTERNAL_ESCALATION).length;
  const activeCasesCount = cases.filter((c) => c.status !== M4.CASE_STATUS.RESOLVED).length;

  return {
    counts: {
      total: notifs.length,
      pendingApproval: pendingCount,
      sent: sentCount,
      urgentEscalations: urgentCount,
      activeCases: activeCasesCount
    },
    notifications: enrichedNotifs,
    cases: enrichedCases
  };
}

/**
 * Returns rendered preview details for an individual notification.
 */
function M4_getNotificationDetail(notificationId) {
  const notifs = readTable(SEG.TABS.NOTIFICATIONS);
  const n = notifs.find((x) => x.notification_id === notificationId);
  if (!n) throw new Error('Notification ' + notificationId + ' not found.');

  const rendered = M4_renderEmail(n);
  return {
    notification: n,
    renderedHtml: rendered.htmlBody,
    plainText: rendered.plainText
  };
}

/* ============================================================ Editor Self-Test */

function test_M4_rules() {
  let passed = 0;
  const assert = (cond, msg) => {
    if (!cond) throw new Error('Assertion failed: ' + msg);
    passed++;
  };

  // 1. Follow-up date calculation
  const nextDate = M4_calculateFollowUpDate('2026-11-11', 7);
  assert(nextDate === '2026-11-18', '7 days from 2026-11-11 is 2026-11-18');

  // 2. Subject formatting
  const sub1 = M4_formatSubject(M4.STAGES.FIRST_REMINDER, { docTypeName: 'Insurance' }, { supplierName: 'BrightClean' });
  assert(sub1.indexOf('Upcoming Expiry Notice') !== -1, 'Subject contains Upcoming Expiry Notice');

  const sub2 = M4_formatSubject(M4.STAGES.URGENT_ESCALATION, { docTypeName: 'Permit' }, { supplierName: 'SwiftHaul' });
  assert(sub2.indexOf('COMPLIANCE ALERT') !== -1, 'Subject contains COMPLIANCE ALERT');

  // 3. Email body rendering
  const mockNotif = {
    notification_id: 'NOT999',
    supplier_id: 'SUP001',
    stage: M4.STAGES.FIRST_REMINDER,
    recipient: 'test@example.com'
  };
  const rendered = M4_renderEmail(mockNotif);
  assert(rendered.htmlBody.indexOf('NOT999') !== -1, 'Email HTML body includes notification ID');
  assert(rendered.plainText.indexOf('NOT999') !== -1, 'Plain text body includes notification ID');

  // 4. First email for each status
  assert(M4_firstStageFor('EXPIRING_SOON') === M4.STAGES.FIRST_REMINDER, 'Expiring → first reminder');
  assert(M4_firstStageFor('ENDING_SOON') === M4.STAGES.FIRST_REMINDER, 'Ending contract → first reminder');
  assert(M4_firstStageFor('EXPIRED') === M4.STAGES.URGENT_ESCALATION, 'Expired → urgent notice');
  assert(M4_firstStageFor('MISSING') === M4.STAGES.SUBMISSION_REQUEST, 'Missing → submission request');
  assert(M4_caseTypeFor('ENDED') === M4.CASE_TYPES.ENDED_ESCALATION, 'Ended contract → ended case type');

  // 5. Follow-up clock: due on or after the date, never when blank
  assert(M4_isDue('2026-11-18', '2026-11-18'), 'Due on the follow-up date');
  assert(M4_isDue('2026-11-18', '2026-11-25'), 'Due after the follow-up date');
  assert(!M4_isDue('2026-11-18', '2026-11-17'), 'Not due the day before');
  assert(!M4_isDue('', '2026-11-25'), 'A blank date (email not sent yet) is never due');

  // 6. Internal emails
  assert(M4_isInternalStage(M4.STAGES.INTERNAL_ESCALATION) && M4_isInternalStage(M4.STAGES.REVIEW_ALERT), 'Escalations and review alerts are internal');
  assert(!M4_isInternalStage(M4.STAGES.FOLLOW_UP), 'Follow-ups go to the supplier');
  assert(M4_internalRecipient({ internal_officer: 'farid@alpha.example' }) === 'farid@alpha.example', 'Officer with an email gets the escalation');
  assert(SEG_isEmail(M4_internalRecipient({ internal_officer: 'Farid Hassan (Procurement)' })), 'Officer with only a name: a real email is still found');
  const sub3 = M4_formatSubject(M4.STAGES.INTERNAL_ESCALATION, { docTypeName: 'Insurance', escalationReason: 'Document has expired.' }, { supplier_name: 'BrightClean' });
  assert(sub3.indexOf('BrightClean') !== -1 && sub3.indexOf('expired') !== -1, 'Escalation subject names the supplier and the reason');
  const internalMail = M4_renderEmail({ notification_id: 'NOT998', supplier_id: 'SUP001', stage: M4.STAGES.INTERNAL_ESCALATION, notification_type: M4.TYPES.EMAIL_INTERNAL });
  assert(internalMail.plainText.indexOf('Dear Compliance Team') !== -1, 'Internal email is addressed to the compliance team');

  console.log('test_M4_rules: all ' + passed + ' checks passed.');
  return passed;
}

/* Helpers a teammate added in the Apps Script editor (kept so nothing is lost). */
function authorizeGmail() {
  GmailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'AlphaTrack Gmail permission test', 'If you got this, AlphaTrack can send email.');
}

function checkDriveAccess() {
  const id = '1Be3dxfD0a6VuqKKV8omMqAwdF7calm8C';
  try {
    console.log('OK, opened: ' + DriveApp.getFolderById(id).getName());
  } catch (e) {
    console.log('Real error: ' + e.message);
  }
}
