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
 * Writes: Notifications (SEG.TABS.NOTIFICATIONS), RenewalCases (SEG.TABS.CASES), AuditLog.
 * Reads:  Assessments (Member 3), Suppliers (Member 1), Documents (Member 1).
 */

const M4 = {
  STAGES: {
    FIRST_REMINDER: 'FIRST_REMINDER',         // 1st advance renewal reminder (> 14 days)
    FOLLOW_UP: 'FOLLOW_UP',                   // 2nd follow-up reminder (<= 14 days or due)
    URGENT_ESCALATION: 'URGENT_ESCALATION',   // Overdue/expired escalation alert
    SUBMISSION_REQUEST: 'SUBMISSION_REQUEST', // Request for missing mandatory document
    REVIEW_ALERT: 'REVIEW_ALERT'              // Internal officer alert for defective scans
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

  FOLLOW_UP_INTERVAL_DAYS: 7 // Cooldown days between follow-ups
};

/* ============================================================ Core Workflow Entry Point */

/**
 * Main entry point: Analyses Member 3's assessments, creates or updates RenewalCases,
 * and drafts required reminders with duplicate protection.
 *
 * Returns: { summary, casesCreated, notificationsPrepared }
 */
function M4_prepareNotifications(options) {
  const opts = options || {};
  const refDate = opts.referenceDate || SEG_today();

  // Retrieve current assessments from Member 3
  let assessments = [];
  if (typeof M3_getAssessments === 'function') {
    assessments = M3_getAssessments({ referenceDate: refDate });
  } else {
    assessments = readTable(SEG.TABS.ASSESSMENTS);
  }

  const suppliers = readTable(SEG.TABS.SUPPLIERS);
  const supMap = {};
  suppliers.forEach((s) => { supMap[s.supplier_id] = s; });

  const docs = readTable(SEG.TABS.DOCUMENTS);
  const docMap = {};
  docs.forEach((d) => { docMap[d.doc_id] = d; });

  return SEG_withLock(() => {
    const existingCases = readTable(SEG.TABS.CASES);
    const existingNotifications = readTable(SEG.TABS.NOTIFICATIONS);

    const caseIds = existingCases.map((c) => c.case_id);
    const notifIds = existingNotifications.map((n) => n.notification_id);

    const newCases = [];
    const newNotifications = [];
    let casesUpdated = 0;

    // Filter assessments that need action
    const actionable = assessments.filter((a) => {
      return a.status === 'EXPIRING_SOON' ||
             a.status === 'ENDING_SOON' ||
             a.status === 'EXPIRED' ||
             a.status === 'ENDED' ||
             a.status === 'MISSING' ||
             a.status === 'NEEDS_REVIEW';
    });

    actionable.forEach((item) => {
      const sup = supMap[item.supplierId] || {};
      const doc = docMap[item.docId] || {};
      const reqId = item.requirementId || doc.requirement_id || '';

      // Determine appropriate case type
      let caseType = M4.CASE_TYPES.EXPIRY_RENEWAL;
      if (item.status === 'ENDING_SOON') caseType = M4.CASE_TYPES.CONTRACT_RENEWAL;
      else if (item.status === 'EXPIRED') caseType = M4.CASE_TYPES.EXPIRED_ESCALATION;
      else if (item.status === 'ENDED') caseType = M4.CASE_TYPES.ENDED_ESCALATION;
      else if (item.status === 'MISSING') caseType = M4.CASE_TYPES.MISSING_DOCUMENT;
      else if (item.status === 'NEEDS_REVIEW') caseType = M4.CASE_TYPES.MANUAL_REVIEW;

      // Check if an open/active case already exists for this requirement/doc
      let caseRow = existingCases.find((c) => {
        return c.supplier_id === item.supplierId &&
               c.requirement_id === reqId &&
               c.status !== M4.CASE_STATUS.RESOLVED;
      });

      let caseId = '';
      if (!caseRow) {
        caseId = SEG_newId('CAS', caseIds, 3);
        caseIds.push(caseId);
        caseRow = {
          case_id: caseId,
          supplier_id: item.supplierId,
          requirement_id: reqId,
          doc_id: item.docId || '',
          case_type: caseType,
          status: (item.status === 'EXPIRED' || item.status === 'ENDED' || item.riskLevel === 'CRITICAL')
            ? M4.CASE_STATUS.ESCALATED
            : M4.CASE_STATUS.OPEN,
          opened_at: SEG_now(),
          resolved_at: '',
          resolution: ''
        };
        newCases.push(caseRow);
        existingCases.push(caseRow);
      } else {
        caseId = caseRow.case_id;
        // Escalate case if it transitioned to expired
        if ((item.status === 'EXPIRED' || item.status === 'ENDED' || item.riskLevel === 'CRITICAL') && caseRow.status !== M4.CASE_STATUS.ESCALATED) {
          caseRow.status = M4.CASE_STATUS.ESCALATED;
          updateRow(SEG.TABS.CASES, caseRow._row, { status: M4.CASE_STATUS.ESCALATED });
          casesUpdated++;
        }
      }

      // Determine required notification stage
      let stage = M4.STAGES.FIRST_REMINDER;
      let notifType = M4.TYPES.EMAIL_EXTERNAL;
      let recipient = sup.contact_email || sup.contactEmail || '';

      if (item.status === 'EXPIRED' || item.status === 'ENDED') {
        stage = M4.STAGES.URGENT_ESCALATION;
      } else if (item.status === 'MISSING') {
        stage = M4.STAGES.SUBMISSION_REQUEST;
      } else if (item.status === 'NEEDS_REVIEW') {
        stage = M4.STAGES.REVIEW_ALERT;
        notifType = M4.TYPES.EMAIL_INTERNAL;
        recipient = sup.internal_officer || sup.internalOfficer || Session.getActiveUser().getEmail();
      } else if (item.daysRemaining !== null && item.daysRemaining <= 14) {
        stage = M4.STAGES.FOLLOW_UP;
      }

      // Duplicate Prevention Check:
      // Has this exact stage already been drafted, approved, or sent for this case?
      const alreadyNotified = existingNotifications.some((n) => {
        return n.case_id === caseId &&
               n.stage === stage &&
               n.approval_status !== M4.APPROVAL.REJECTED;
      });

      if (!alreadyNotified && recipient) {
        const notifId = SEG_newId('NOT', notifIds, 3);
        notifIds.push(notifId);

        const subject = M4_formatSubject(stage, item, sup);
        const autoApprove = (notifType === M4.TYPES.EMAIL_INTERNAL);

        const notifRow = {
          notification_id: notifId,
          case_id: caseId,
          supplier_id: item.supplierId,
          doc_id: item.docId || '',
          stage: stage,
          notification_type: notifType,
          recipient: recipient,
          subject: subject,
          approval_status: autoApprove ? M4.APPROVAL.AUTO_APPROVED : M4.APPROVAL.PENDING_APPROVAL,
          delivery_status: autoApprove ? M4.DELIVERY.QUEUED : M4.DELIVERY.DRAFT,
          created_at: SEG_now(),
          approved_by: autoApprove ? 'SYSTEM' : '',
          approved_at: autoApprove ? SEG_now() : '',
          sent_at: '',
          follow_up_due: M4_calculateFollowUpDate(refDate, M4.FOLLOW_UP_INTERVAL_DAYS)
        };

        newNotifications.push(notifRow);
        existingNotifications.push(notifRow);
      }
    });

    // Check for open cases whose document is now VALID or ACTIVE -> Resolve them
    const validAssessments = assessments.filter((a) => a.status === 'VALID' || a.status === 'ACTIVE');
    validAssessments.forEach((v) => {
      const openCase = existingCases.find((c) => {
        return c.supplier_id === v.supplierId &&
               c.requirement_id === (v.requirementId || '') &&
               c.status !== M4.CASE_STATUS.RESOLVED;
      });
      if (openCase && openCase._row) {
        updateRow(SEG.TABS.CASES, openCase._row, {
          status: M4.CASE_STATUS.RESOLVED,
          resolved_at: SEG_now(),
          resolution: 'Document renewed and verified compliant on ' + SEG_today() + '.'
        });
        casesUpdated++;
      }
    });

    // Append new cases and notifications
    if (newCases.length) appendRows(SEG.TABS.CASES, newCases);
    if (newNotifications.length) appendRows(SEG.TABS.NOTIFICATIONS, newNotifications);

    // Auto-send auto-approved internal notifications
    const toAutoSend = newNotifications.filter((n) => n.delivery_status === M4.DELIVERY.QUEUED);
    toAutoSend.forEach((n) => {
      M4_sendSingleEmail(n);
    });

    const summary = {
      actionableItems: actionable.length,
      casesOpened: newCases.length,
      casesUpdated: casesUpdated,
      notificationsPrepared: newNotifications.length,
      pendingApproval: newNotifications.filter((n) => n.approval_status === M4.APPROVAL.PENDING_APPROVAL).length
    };

    SEG_audit({
      module: 'M4', action: 'NOTIFICATIONS_PREPARED', recordType: 'BATCH', recordId: 'RUN',
      outcome: 'OK', reason: 'Prepared ' + newNotifications.length + ' reminder draft(s) across ' + newCases.length + ' new case(s).'
    });

    return summary;
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
  const recipient = notification.recipient;
  if (!recipient || !SEG_isEmail(recipient)) {
    console.warn('Invalid recipient email for notification ' + notification.notification_id + ': ' + recipient);
    return false;
  }

  const subject = notification.subject || 'Alpha Electronics Compliance Notification';
  const emailContent = M4_renderEmail(notification);

  try {
    if (typeof GmailApp !== 'undefined' && GmailApp.sendEmail) {
      GmailApp.sendEmail(recipient, subject, emailContent.plainText, {
        name: 'Alpha Electronics Procurement Compliance',
        htmlBody: emailContent.htmlBody
      });
    }

    if (notification._row) {
      updateRow(SEG.TABS.NOTIFICATIONS, notification._row, {
        delivery_status: M4.DELIVERY.SENT,
        sent_at: SEG_now()
      });
    }
    return true;
  } catch (err) {
    console.error('Failed to send email ' + notification.notification_id + ': ' + err.message);
    if (notification._row) {
      updateRow(SEG.TABS.NOTIFICATIONS, notification._row, {
        delivery_status: M4.DELIVERY.FAILED
      });
    }
    return false;
  }
}

/**
 * Formats a clean email subject line.
 */
function M4_formatSubject(stage, item, supplier) {
  const prefix = '[Alpha Electronics Compliance] ';
  const docName = item.docTypeName || 'Document';
  const supName = supplier.supplierName || 'Supplier';

  switch (stage) {
    case M4.STAGES.FIRST_REMINDER:
      return prefix + 'Upcoming Expiry Notice: ' + docName + ' (' + supName + ')';
    case M4.STAGES.FOLLOW_UP:
      return prefix + 'URGENT Follow-up: ' + docName + ' Renewal Due Soon';
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
    headline = 'Urgent Renewal Follow-Up';
    message = 'This is a follow-up reminder that your compliance document will expire imminently. Immediate renewal action is required to ensure continued operational authorization.';
    alertBadge = '<span style="display:inline-block;padding:4px 10px;border-radius:4px;background:#FEECEB;color:#B42318;font-weight:700;font-size:12px;">URGENT FOLLOW-UP</span>';
  } else if (stage === M4.STAGES.URGENT_ESCALATION) {
    headline = 'Notice of Expired Certification';
    message = 'Your required certification or licence has passed its expiration date. Operating without valid documentation represents a compliance violation. Please submit the renewed certificate immediately.';
    alertBadge = '<span style="display:inline-block;padding:4px 10px;border-radius:4px;background:#B42318;color:#FFFFFF;font-weight:700;font-size:12px;">EXPIRED / NON-COMPLIANT</span>';
  } else if (stage === M4.STAGES.SUBMISSION_REQUEST) {
    headline = 'Submission Request for Mandatory Document';
    message = 'According to our approved procurement policy, your account requires a mandatory document that has not yet been submitted. Please upload the required documentation to complete your compliance register.';
  } else {
    headline = 'Internal Compliance Review Alert';
    message = 'An uploaded document requires officer verification due to unreadable text or mismatched company details. Please inspect the file in Google Drive.';
  }

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
      <p>Dear <strong>${supName}</strong>,</p>
      <p>${message}</p>

      <div class="box">
        <div><strong>Notification ID:</strong> ${notification.notification_id}</div>
        <div><strong>Supplier ID:</strong> ${notification.supplier_id}</div>
        <div><strong>Document Reference:</strong> ${notification.doc_id || 'Mandatory Requirement'}</div>
        <div><strong>Stage:</strong> ${notification.stage}</div>
      </div>

      <p>If you have already submitted the replacement document, our AI verification system will verify it during the next automated cycle.</p>
      <p style="margin-top:24px;">Sincerely,<br><strong>${officer}</strong><br>Procurement &amp; Vendor Management Team<br>Alpha Electronics Sdn. Bhd.</p>
    </div>
    <div class="footer">
      This is an automated notification managed by AlphaTrack (Silent Expiry Guardian). Inquiries can be directed to your Alpha Electronics responsible officer.
    </div>
  </div>
</body>
</html>`;

  const plainText = headline + '\n\n' +
    'Dear ' + supName + ',\n\n' +
    message + '\n\n' +
    'Notification ID: ' + notification.notification_id + '\n' +
    'Supplier ID: ' + notification.supplier_id + '\n' +
    'Document Reference: ' + (notification.doc_id || 'Mandatory Requirement') + '\n\n' +
    'Sincerely,\n' + officer + '\nAlpha Electronics Sdn. Bhd.';

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
      supplierName: s.supplierName || 'Unknown Supplier',
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
  const urgentCount = notifs.filter((n) => n.stage === M4.STAGES.URGENT_ESCALATION).length;
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

  console.log('test_M4_rules: all ' + passed + ' checks passed.');
  return passed;
}

