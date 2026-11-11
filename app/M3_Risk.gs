/**
 * M3_Risk.gs · Member 3: Expiry Detection & Risk Analysis
 *
 * Automatically analyses document extractions from Member 2 and supplier requirements
 * from Member 1, calculates days remaining, identifies compliance statuses (valid,
 * expiring soon, expired, missing, needs review, active, ending soon, ended, no fixed end date),
 * assigns multi-factor compliance risk levels, and explains detected issues.
 *
 * Main functions:
 *   M3_assessDocuments(options)         run assessment on all monitored suppliers & documents
 *   M3_assessSingleDocument(docId)      assess one document
 *   M3_getAssessments(options)          query enriched assessments for table display
 *   M3_getRiskSummary(options)          summary KPIs, risk counts & supplier compliance scores
 *   M3_getThresholds()                  get configurable reminder thresholds
 *   M3_saveThresholds(thresholds)       update configurable thresholds
 *   test_M3_rules()                     editor self-test for logic rules
 *
 * Output: Writes to Assessments tab (SEG.TABS.ASSESSMENTS), logs to AuditLog via SEG_audit().
 */

const M3 = {
  THRESHOLDS_PROP: 'M3_CONFIG_THRESHOLDS',

  // Configurable reminder lead-times (days)
  DEFAULT_THRESHOLDS: {
    contractNoticeDays: 60,
    licenceReminderDays: 30,
    certificateReminderDays: 30,
    urgentLeadDays: 5
  },

  // Document compliance statuses
  STATUS: {
    ACTIVE: 'ACTIVE',                       // Contract currently active (> notice threshold)
    VALID: 'VALID',                         // Licence / certificate currently valid (> reminder threshold)
    ENDING_SOON: 'ENDING_SOON',             // Contract ending within renewal notice threshold
    EXPIRING_SOON: 'EXPIRING_SOON',         // Licence / certificate expiring within reminder threshold
    ENDED: 'ENDED',                         // Contract past end date
    EXPIRED: 'EXPIRED',                     // Licence / certificate past expiry date
    NO_FIXED_END_DATE: 'NO_FIXED_END_DATE', // Open-ended contract (valid, no fixed expiry)
    NEEDS_REVIEW: 'NEEDS_REVIEW',           // Extraction issue or unreadable scan needing officer review
    MISSING: 'MISSING'                      // Mandatory requirement without an uploaded document
  },

  // Compliance risk levels
  RISK_LEVELS: {
    CRITICAL: 'CRITICAL', // Immediate compliance breach (e.g. expired/missing for High-criticality supplier)
    HIGH: 'HIGH',         // Urgent attention required (e.g. expiry in <14 days, high-criticality upcoming, or review issue)
    MEDIUM: 'MEDIUM',     // Moderate risk (e.g. expiring soon within threshold, low-criticality expired)
    LOW: 'LOW'            // Compliant, valid or open-ended
  }
};

/* ============================================================ Core Date & Math Helpers */

/**
 * Calculates calendar day difference (dueDate - referenceDate).
 * Uses UTC midnight to avoid any DST or local timezone skew.
 * Returns positive if dueDate is in future, negative if past, 0 if today, null if invalid.
 */
function M3_diffDays(dueDate, referenceDate) {
  if (!dueDate) return null;
  const refStr = referenceDate || SEG_today();
  const dParts = String(dueDate).trim().split('-');
  const rParts = String(refStr).trim().split('-');
  if (dParts.length !== 3 || rParts.length !== 3) return null;

  const y1 = parseInt(dParts[0], 10);
  const m1 = parseInt(dParts[1], 10) - 1;
  const day1 = parseInt(dParts[2], 10);

  const y0 = parseInt(rParts[0], 10);
  const m0 = parseInt(rParts[1], 10) - 1;
  const day0 = parseInt(rParts[2], 10);

  if (isNaN(y1) || isNaN(m1) || isNaN(day1) || isNaN(y0) || isNaN(m0) || isNaN(day0)) return null;

  const utcDue = Date.UTC(y1, m1, day1);
  const utcRef = Date.UTC(y0, m0, day0);
  return Math.round((utcDue - utcRef) / (86400 * 1000));
}

/**
 * Retrieves the effective reminder threshold for a document or requirement.
 * Priority: Extracted notice days (contracts) > Requirement override > DocumentType default > System default
 */
function M3_getThreshold(docClass, docType, requirement, extractedFields) {
  const sys = M3_getThresholds();
  if (docClass === SEG.DOC_CLASS.CONTRACT) {
    if (extractedFields && extractedFields.renewal_notice_days !== null && extractedFields.renewal_notice_days !== undefined && extractedFields.renewal_notice_days !== '') {
      const n = Number(extractedFields.renewal_notice_days);
      if (!isNaN(n) && n > 0) return n;
    }
    if (requirement && requirement.reminder_days) {
      const n = Number(requirement.reminder_days);
      if (!isNaN(n) && n > 0) return n;
    }
    if (docType && docType.default_reminder_days) {
      const n = Number(docType.default_reminder_days);
      if (!isNaN(n) && n > 0) return n;
    }
    return sys.contractNoticeDays;
  }

  // Licences and Certificates
  if (requirement && requirement.reminder_days) {
    const n = Number(requirement.reminder_days);
    if (!isNaN(n) && n > 0) return n;
  }
  if (docType && docType.default_reminder_days) {
    const n = Number(docType.default_reminder_days);
    if (!isNaN(n) && n > 0) return n;
  }
  return docClass === SEG.DOC_CLASS.LICENCE ? sys.licenceReminderDays : sys.certificateReminderDays;
}

/**
 * Retrieves configurable thresholds from ScriptProperties or fallback defaults.
 */
function M3_getThresholds() {
  try {
    const val = PropertiesService.getScriptProperties().getProperty(M3.THRESHOLDS_PROP);
    if (val) {
      const parsed = JSON.parse(val);
      return Object.assign({}, M3.DEFAULT_THRESHOLDS, parsed);
    }
  } catch (err) {
    // fallback to defaults
  }
  return Object.assign({}, M3.DEFAULT_THRESHOLDS);
}

/**
 * Persists user-configured reminder thresholds into ScriptProperties.
 */
function M3_saveThresholds(thresholds) {
  const current = M3_getThresholds();
  const updated = {
    contractNoticeDays: Math.max(1, Number(thresholds.contractNoticeDays) || current.contractNoticeDays),
    licenceReminderDays: Math.max(1, Number(thresholds.licenceReminderDays) || current.licenceReminderDays),
    certificateReminderDays: Math.max(1, Number(thresholds.certificateReminderDays) || current.certificateReminderDays),
    urgentLeadDays: Math.max(1, Number(thresholds.urgentLeadDays) || current.urgentLeadDays)
  };
  PropertiesService.getScriptProperties().setProperty(M3.THRESHOLDS_PROP, JSON.stringify(updated));
  SEG_audit({
    module: 'M3', action: 'THRESHOLDS_UPDATED', recordType: 'SYSTEM', recordId: 'THRESHOLDS',
    outcome: 'OK', reason: 'Reminder thresholds updated: ' + JSON.stringify(updated)
  });
  return updated;
}

/* ============================================================ Risk Scoring Engine */

/**
 * Computes multi-factor compliance risk level (CRITICAL, HIGH, MEDIUM, LOW).
 * Factors:
 *   - Status severity (EXPIRED/ENDED, MISSING, NEEDS_REVIEW, EXPIRING_SOON/ENDING_SOON, VALID/ACTIVE)
 *   - Days remaining (urgent threshold <= 14 days)
 *   - Supplier criticality (HIGH, MEDIUM, LOW)
 *   - Mandatory requirement vs optional
 */
function M3_calculateRiskLevel(status, daysRemaining, supplierCriticality, mandatory, hasReviewIssue) {
  // Simple, explainable date rules (supplier criticality only affects the supplier score):
  //   overdue / missing mandatory -> CRITICAL
  //   needs review, or <= urgentLeadDays (default 5) left -> HIGH
  //   inside the reminder window (default 30 days; contracts use their notice days) -> MEDIUM
  //   otherwise -> LOW
  const urgentCutoff = M3_getThresholds().urgentLeadDays || 5;

  if (status === M3.STATUS.EXPIRED || status === M3.STATUS.ENDED) {
    return mandatory ? M3.RISK_LEVELS.CRITICAL : M3.RISK_LEVELS.HIGH;
  }
  if (status === M3.STATUS.MISSING) {
    return mandatory ? M3.RISK_LEVELS.CRITICAL : M3.RISK_LEVELS.LOW;
  }
  if (status === M3.STATUS.NEEDS_REVIEW || hasReviewIssue) {
    return M3.RISK_LEVELS.HIGH;
  }
  if (status === M3.STATUS.EXPIRING_SOON || status === M3.STATUS.ENDING_SOON) {
    if (daysRemaining !== null && daysRemaining !== undefined && daysRemaining <= urgentCutoff) return M3.RISK_LEVELS.HIGH;
    return M3.RISK_LEVELS.MEDIUM;
  }
  return M3.RISK_LEVELS.LOW;
}

/**
 * Generates an explainable human reason and prescriptive recommended action.
 */
function M3_explainAssessment(status, daysRemaining, dueDate, threshold, docClass, issues, supplier, req) {
  const reqName = req ? (req.label || req.doc_type_id) : 'Document';
  const supName = supplier ? (supplier.supplierName || supplier.supplier_name || 'Supplier') : 'Supplier';
  const officer = supplier ? (supplier.internalOfficer || supplier.internal_officer || 'Procurement Officer') : 'Procurement Officer';
  const email = supplier ? (supplier.contactEmail || supplier.contact_email || 'supplier email') : 'supplier contact';

  switch (status) {
    case M3.STATUS.MISSING:
      return {
        reason: 'Mandatory requirement "' + reqName + '" is missing. No active document has been submitted.',
        recommendedAction: 'Request mandatory document submission from ' + supName + ' (' + email + ').'
      };

    case M3.STATUS.NEEDS_REVIEW: {
      const issueList = Array.isArray(issues) ? issues : String(issues || '').split(',').map((s) => s.trim()).filter(Boolean);
      let issueDetails = [];
      if (issueList.indexOf('NAME_MISMATCH') !== -1) issueDetails.push('Holder name on document does not match registered company name');
      if (issueList.indexOf('MISSING_EXPIRY') !== -1) issueDetails.push('No expiry date printed on document despite requirement');
      if (issueList.indexOf('CONFLICTING_DATES') !== -1) issueDetails.push('Conflicting dates detected across document clauses');
      if (issueList.indexOf('UNREADABLE') !== -1) issueDetails.push('Blurry or unreadable document scan');
      if (issueList.indexOf('INVALID_DATE') !== -1) issueDetails.push('Invalid calendar date encountered');
      if (issueList.indexOf('MISSING_CERTIFICATE_NUMBER') !== -1) issueDetails.push('No licence, certificate or policy number found on document');
      if (issueList.indexOf('EXTRACTION_FAILED') !== -1) issueDetails.push('AI could not read the document');
      if (issueList.indexOf('NOT_READ') !== -1) issueDetails.push('Document has not been read by the AI yet');
      const issueMsg = issueDetails.length ? issueDetails.join('; ') : 'Document extraction flagged for verification';

      return {
        reason: issueMsg + '.',
        recommendedAction: 'Officer review required: inspect PDF in Drive, correct extraction fields or request re-upload.'
      };
    }

    case M3.STATUS.EXPIRED: {
      const overdue = Math.abs(daysRemaining || 0);
      return {
        reason: docClass + ' expired ' + overdue + ' day' + (overdue === 1 ? '' : 's') + ' ago on ' + dueDate + '.',
        recommendedAction: 'Escalate to ' + officer + ' and issue urgent renewal demand to ' + email + '.'
      };
    }

    case M3.STATUS.ENDED: {
      const overdue = Math.abs(daysRemaining || 0);
      return {
        reason: 'Contract ended ' + overdue + ' day' + (overdue === 1 ? '' : 's') + ' ago on ' + dueDate + '.',
        recommendedAction: 'Immediate contract renewal or closeout required. Escalate to ' + officer + '.'
      };
    }

    case M3.STATUS.EXPIRING_SOON:
      return {
        reason: docClass + ' expires in ' + daysRemaining + ' day' + (daysRemaining === 1 ? '' : 's') + ' on ' + dueDate + ' (Notice threshold: ' + threshold + ' days).',
        recommendedAction: 'Issue renewal reminder to ' + supName + ' (' + email + ') via Member 4 workflow.'
      };

    case M3.STATUS.ENDING_SOON:
      return {
        reason: 'Contract ends in ' + daysRemaining + ' day' + (daysRemaining === 1 ? '' : 's') + ' on ' + dueDate + ' (Renewal notice window: ' + threshold + ' days).',
        recommendedAction: 'Initiate contract review and notify internal officer (' + officer + ').'
      };

    case M3.STATUS.NO_FIXED_END_DATE:
      return {
        reason: 'Contract is open-ended with no fixed expiration date.',
        recommendedAction: 'Periodic performance review; no renewal action required.'
      };

    case M3.STATUS.ACTIVE:
      return {
        reason: 'Contract is active and valid until ' + dueDate + ' (' + daysRemaining + ' days remaining).',
        recommendedAction: 'No action required; ongoing scheduled monitoring.'
      };

    case M3.STATUS.VALID:
    default:
      if (dueDate) {
        return {
          reason: docClass + ' is valid until ' + dueDate + ' (' + daysRemaining + ' days remaining).',
          recommendedAction: 'No action required; document is in good standing.'
        };
      }
      return {
        reason: 'Document has ongoing validity (no printed expiry date required).',
        recommendedAction: 'No action required; annual registration check.'
      };
  }
}

/* ============================================================ Evaluation Functions */

/**
 * Assesses an active uploaded document against registered requirements and extraction results.
 */
function M3_evaluateDocument(doc, reading, supplier, requirement, docType, referenceDate) {
  const docClass = doc.document_class || (docType ? docType.document_class : SEG.DOC_CLASS.CERTIFICATE);
  const fields = (reading && reading.fields) ? reading.fields : {};
  const issues = ((reading && reading.issues) ? reading.issues : []).slice();
  const statusM2 = reading ? reading.processingStatus : '';
  const mandatory = requirement ? SEG_bool(requirement.mandatory, true) : true;
  const supplierCrit = supplier ? (supplier.criticality || 'MEDIUM') : 'MEDIUM';

  // Never read, or the read failed: nothing can be trusted, so a person must look (never "VALID")
  const notRead = !reading || statusM2 === 'FAILED';
  if (!reading) issues.push('NOT_READ');

  // Check for unresolved issues needing manual review
  const reviewCodes = ['NAME_MISMATCH', 'MISSING_EXPIRY', 'CONFLICTING_DATES', 'UNREADABLE', 'INVALID_DATE', 'MISSING_CERTIFICATE_NUMBER', 'EXTRACTION_FAILED', 'NOT_READ'];
  const hasReviewIssue = notRead || issues.some((code) => reviewCodes.indexOf(code) !== -1);
  // An officer who approved or corrected the reading has resolved its issues
  const isCorrected = !notRead && (statusM2 === 'CORRECTED' || statusM2 === 'APPROVED');

  let status = M3.STATUS.VALID;
  let dueDate = fields.due_date || '';
  let daysRemaining = dueDate ? M3_diffDays(dueDate, referenceDate) : null;
  const threshold = M3_getThreshold(docClass, docType, requirement, fields);

  if (hasReviewIssue && !isCorrected) {
    status = M3.STATUS.NEEDS_REVIEW;
  } else if (docClass === SEG.DOC_CLASS.CONTRACT) {
    if (!dueDate) {
      status = M3.STATUS.NO_FIXED_END_DATE;
      daysRemaining = null;
    } else if (daysRemaining < 0) {
      status = M3.STATUS.ENDED;
    } else if (daysRemaining <= threshold) {
      status = M3.STATUS.ENDING_SOON;
    } else {
      status = M3.STATUS.ACTIVE;
    }
  } else {
    // LICENCE or CERTIFICATE
    const hasExpiry = docType ? SEG_bool(docType.has_expiry, true) : true;
    if (!hasExpiry && !dueDate) {
      status = M3.STATUS.VALID;
      daysRemaining = null;
    } else if (dueDate) {
      if (daysRemaining < 0) {
        status = M3.STATUS.EXPIRED;
      } else if (daysRemaining <= threshold) {
        status = M3.STATUS.EXPIRING_SOON;
      } else {
        status = M3.STATUS.VALID;
      }
    } else {
      status = M3.STATUS.VALID;
      daysRemaining = null;
    }
  }

  const riskLevel = M3_calculateRiskLevel(status, daysRemaining, supplierCrit, mandatory, hasReviewIssue && !isCorrected);
  const explanation = M3_explainAssessment(status, daysRemaining, dueDate, threshold, docClass, issues, supplier, requirement);
  // The AI read it but no officer has signed it off yet: say so, so nobody over-trusts the date
  if (reading && reading.approved === false && status !== M3.STATUS.NEEDS_REVIEW) {
    explanation.reason += ' (AI reading not yet approved by an officer.)';
  }

  return {
    docId: doc.doc_id,
    requirementId: doc.requirement_id || (requirement ? requirement.requirement_id : ''),
    supplierId: doc.supplier_id,
    assessmentType: 'DOCUMENT',
    dueDate: dueDate,
    daysRemaining: daysRemaining,
    status: status,
    riskLevel: riskLevel,
    reason: explanation.reason,
    recommendedAction: explanation.recommendedAction,
    threshold: threshold,
    documentClass: docClass,
    issues: issues
  };
}

/**
 * Assesses an unfulfilled mandatory requirement where no document was submitted.
 */
function M3_evaluateMissingRequirement(requirement, supplier, docType, referenceDate) {
  const mandatory = SEG_bool(requirement.mandatory, true);
  const supplierCrit = supplier ? (supplier.criticality || 'MEDIUM') : 'MEDIUM';
  const status = mandatory ? M3.STATUS.MISSING : M3.STATUS.VALID;
  const riskLevel = M3_calculateRiskLevel(status, null, supplierCrit, mandatory, false);

  const explanation = M3_explainAssessment(status, null, '', 0, docType ? docType.document_class : 'DOCUMENT', [], supplier, requirement);

  return {
    docId: '',
    requirementId: requirement.requirement_id,
    supplierId: requirement.supplier_id,
    assessmentType: 'REQUIREMENT',
    dueDate: '',
    daysRemaining: null,
    status: status,
    riskLevel: riskLevel,
    reason: explanation.reason,
    recommendedAction: explanation.recommendedAction,
    threshold: 0,
    documentClass: docType ? docType.document_class : 'CERTIFICATE',
    issues: []
  };
}

/* ============================================================ Main Assessment Execution */

/**
 * Assesses every active monitored supplier and active document, identifies expiries,
 * risks, and missing documents, and updates the Assessments tab.
 *
 * options:
 *   referenceDate: 'YYYY-MM-DD' (defaults to SEG_today())
 *   supplierId: optional supplier ID filter
 *
 * Returns: { summary, assessments, generatedAt, referenceDate }
 */
function M3_assessDocuments(options) {
  const opts = options || {};
  const refDate = opts.referenceDate || SEG_today();

  const master = M1_loadMasterData();
  const docTypeMap = {};
  (master.documentTypes || []).forEach((t) => { docTypeMap[t.docTypeId] = t; });

  const suppliers = M1_listSuppliers().filter((s) => !s.deactivated && s.registrationStatus !== SEG.REGISTRATION_STATUS.DRAFT);
  const targetSuppliers = opts.supplierId ? suppliers.filter((s) => s.supplierId === opts.supplierId) : suppliers;

  const allActiveDocs = readTable(SEG.TABS.DOCUMENTS).filter((d) => d.lifecycle_status === SEG.LIFECYCLE.ACTIVE);
  const allReqs = readTable(SEG.TABS.SUPPLIER_REQS).filter((r) => SEG_bool(r.active, true));

  const extractions = readTable(SEG.TABS.EXTRACTIONS);
  const latestExtractionMap = {};
  extractions.forEach((r) => {
    latestExtractionMap[r.doc_id + '|' + r.file_id] = r;
  });

  const assessmentsToSave = [];

  targetSuppliers.forEach((sup) => {
    const supId = sup.supplierId;
    const supReqs = allReqs.filter((r) => r.supplier_id === supId);
    const supDocs = allActiveDocs.filter((d) => d.supplier_id === supId);

    // Track which requirements have been covered by an active document
    const coveredReqIds = {};

    supDocs.forEach((doc) => {
      coveredReqIds[doc.requirement_id] = true;
      const req = supReqs.find((r) => r.requirement_id === doc.requirement_id);
      const docType = docTypeMap[doc.doc_type_id];

      // Retrieve reading for this document
      let reading = null;
      if (typeof M2_latestReading === 'function') {
        try {
          reading = M2_latestReading(doc.doc_id, doc.file_id);
        } catch (e) {
          reading = null;
        }
      }
      if (!reading) {
        const row = latestExtractionMap[doc.doc_id + '|' + doc.file_id];
        if (row) {
          reading = {
            processingStatus: row.processing_status,
            issues: String(row.issues || '').split(',').map((s) => s.trim()).filter(Boolean),
            fields: typeof M2_parseJson === 'function' ? M2_parseJson(row.extracted_json) : JSON.parse(row.extracted_json || '{}'),
            extractedAt: row.extracted_at
          };
        }
      }

      const assessment = M3_evaluateDocument(doc, reading, sup, req, docType, refDate);
      assessmentsToSave.push(assessment);
    });

    // Check for mandatory requirements that have NO active document
    supReqs.forEach((req) => {
      if (!coveredReqIds[req.requirement_id] && SEG_bool(req.mandatory, true)) {
        const docType = docTypeMap[req.doc_type_id];
        const missingAssessment = M3_evaluateMissingRequirement(req, sup, docType, refDate);
        assessmentsToSave.push(missingAssessment);
      }
    });
  });

  // Persist into Assessments tab inside SEG_withLock
  const savedAssessments = SEG_withLock(() => {
    const existingAssessments = readTable(SEG.TABS.ASSESSMENTS);
    const existingIds = existingAssessments.map((a) => a.assessment_id);

    // Clear this supplier's rows (or all rows) and rewrite; other suppliers' rows are kept
    SEG_removeRows(SEG.TABS.ASSESSMENTS, (row) => {
      return !opts.supplierId || row.supplier_id === opts.supplierId;
    });

    const rowsToAppend = assessmentsToSave.map((a) => {
      const asmId = SEG_newId('ASM', existingIds, 3);
      existingIds.push(asmId);
      return {
        assessment_id: asmId,
        doc_id: a.docId || '',
        requirement_id: a.requirementId || '',
        supplier_id: a.supplierId || '',
        assessment_type: a.assessmentType || 'DOCUMENT',
        due_date: a.dueDate || '',
        days_remaining: a.daysRemaining !== null && a.daysRemaining !== undefined ? String(a.daysRemaining) : '',
        status: a.status,
        risk_level: a.riskLevel,
        reason: a.reason,
        recommended_action: a.recommendedAction,
        assessed_at: SEG_now()
      };
    });

    appendRows(SEG.TABS.ASSESSMENTS, rowsToAppend);
    return rowsToAppend;
  });

  // Calculate summary stats
  const summary = M3_calculateSummary(savedAssessments, targetSuppliers);

  SEG_audit({
    module: 'M3',
    action: 'ASSESSMENTS_COMPLETED',
    recordType: 'ASSESSMENT',
    recordId: 'BATCH',
    supplierId: opts.supplierId || 'ALL',
    outcome: 'OK',
    reason: 'Assessed ' + savedAssessments.length + ' item(s). Critical: ' + summary.byRisk.CRITICAL + ', High: ' + summary.byRisk.HIGH + ', Expired/Ended: ' + (summary.byStatus.EXPIRED + summary.byStatus.ENDED) + ', Expiring/Ending: ' + (summary.byStatus.EXPIRING_SOON + summary.byStatus.ENDING_SOON) + '.'
  });

  return {
    summary: summary,
    assessments: savedAssessments,
    referenceDate: refDate,
    generatedAt: SEG_now()
  };
}

/**
 * Re-assesses a single document (e.g. after officer approves or corrects extracted fields).
 */
function M3_assessSingleDocument(docId, options) {
  const doc = readTable(SEG.TABS.DOCUMENTS).find((d) => d.doc_id === docId);
  if (!doc) return null;
  return M3_assessDocuments(Object.assign({}, options, { supplierId: doc.supplier_id }));
}

/**
 * Computes high-level summary counts from assessment rows.
 */
function M3_calculateSummary(assessments, suppliers) {
  const byRisk = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const byStatus = {
    VALID: 0, ACTIVE: 0, EXPIRING_SOON: 0, ENDING_SOON: 0,
    EXPIRED: 0, ENDED: 0, NO_FIXED_END_DATE: 0, NEEDS_REVIEW: 0, MISSING: 0
  };

  assessments.forEach((a) => {
    if (byRisk[a.risk_level] !== undefined) byRisk[a.risk_level]++;
    if (byStatus[a.status] !== undefined) byStatus[a.status]++;
  });

  const attentionCount = byRisk.CRITICAL + byRisk.HIGH + byStatus.NEEDS_REVIEW + byStatus.MISSING;

  // Supplier risk scorecards
  const supplierScores = (suppliers || []).map((s) => {
    const sAsms = assessments.filter((a) => a.supplier_id === s.supplierId || a.supplier_id === s.supplier_id);
    const score = M3_supplierRiskScore(sAsms, s.criticality);
    return {
      supplierId: s.supplierId || s.supplier_id,
      supplierName: s.supplierName || s.supplier_name,
      criticality: s.criticality || 'MEDIUM',
      score: score.score,
      tier: score.tier,
      criticalCount: sAsms.filter((a) => a.risk_level === 'CRITICAL').length,
      highCount: sAsms.filter((a) => a.risk_level === 'HIGH').length,
      totalCount: sAsms.length
    };
  }).sort((a, b) => b.score - a.score);

  return {
    total: assessments.length,
    byRisk: byRisk,
    byStatus: byStatus,
    attentionCount: attentionCount,
    supplierScores: supplierScores
  };
}

/**
 * Computes a 0–100 Compliance Risk Score for a supplier based on their documents.
 * 0 = fully compliant; 100 = critical risk.
 */
function M3_supplierRiskScore(supplierAssessments, criticality) {
  let raw = 0;
  (supplierAssessments || []).forEach((a) => {
    if (a.status === 'EXPIRED' || a.status === 'ENDED') raw += 35;
    else if (a.status === 'MISSING') raw += 30;
    else if (a.status === 'NEEDS_REVIEW') raw += 20;
    else if (a.status === 'EXPIRING_SOON' || a.status === 'ENDING_SOON') raw += 15;
  });

  const critMult = criticality === 'HIGH' ? 1.25 : (criticality === 'MEDIUM' ? 1.0 : 0.8);
  const score = Math.min(100, Math.round(raw * critMult));

  let tier = 'LOW';
  if (score >= 60) tier = 'CRITICAL';
  else if (score >= 40) tier = 'HIGH';
  else if (score >= 20) tier = 'MODERATE';

  return { score: score, tier: tier };
}

/* ============================================================ Query APIs for UI & Teammates */

/**
 * True when the saved Assessments can no longer be trusted, so they are recalculated first:
 *   - none exist yet,
 *   - they were calculated on an earlier day (days remaining and statuses move every day),
 *   - a document was uploaded or removed since,
 *   - Member 2 read, approved or corrected a document after they were calculated.
 */
function M3_isStale(asms) {
  if (!asms.length) return true;
  const today = SEG_today();
  let oldest = '';
  const assessedDocs = {};
  asms.forEach((a) => {
    const at = String(a.assessed_at || '');
    if (at.slice(0, 10) !== today) oldest = oldest || '0';
    if (!oldest || (oldest !== '0' && at < oldest)) oldest = at;
    if (a.doc_id) assessedDocs[a.doc_id] = true;
  });
  if (oldest === '0') return true;

  const monitored = {};
  M1_listSuppliers().forEach((s) => {
    if (!s.deactivated && s.registrationStatus !== SEG.REGISTRATION_STATUS.DRAFT) monitored[s.supplierId] = true;
  });
  const activeDocs = readTable(SEG.TABS.DOCUMENTS).filter((d) => d.lifecycle_status === SEG.LIFECYCLE.ACTIVE && monitored[d.supplier_id]);
  if (activeDocs.some((d) => !assessedDocs[d.doc_id])) return true;
  const activeIds = {};
  activeDocs.forEach((d) => { activeIds[d.doc_id] = true; });
  if (Object.keys(assessedDocs).some((id) => !activeIds[id])) return true;

  const newestRead = readTable(SEG.TABS.EXTRACTIONS).reduce((m, r) => (String(r.extracted_at || '') > m ? String(r.extracted_at) : m), '');
  return !!newestRead && newestRead > oldest;
}

/** Returns the saved assessments, recalculating them first if they are stale. */
function M3_freshAssessments(referenceDate) {
  let asms = readTable(SEG.TABS.ASSESSMENTS);
  if (M3_isStale(asms)) {
    M3_assessDocuments({ referenceDate: referenceDate });
    asms = readTable(SEG.TABS.ASSESSMENTS);
  }
  return asms;
}

/**
 * Daily entry point (Member 5's scheduled job can call this, or run M3_installDailyTrigger once):
 * recalculates every assessment so countdowns and risk levels are current each morning.
 */
function M3_dailyCheck() {
  return M3_assessDocuments();
}

/** Creates one daily trigger (about 07:00 Malaysia time) for M3_dailyCheck. Safe to run twice. */
function M3_installDailyTrigger() {
  const exists = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'M3_dailyCheck');
  if (!exists) ScriptApp.newTrigger('M3_dailyCheck').timeBased().everyDays(1).atHour(7).create();
  return exists ? 'Daily trigger already exists.' : 'Daily trigger created (07:00).';
}

/** What Member 4 should do about an item: OVERDUE, URGENT (within the high-risk window), REMINDER or NONE. */
function M3_reminderStage(status, daysRemaining) {
  if (status === M3.STATUS.EXPIRED || status === M3.STATUS.ENDED || status === M3.STATUS.MISSING) return 'OVERDUE';
  if (status === M3.STATUS.EXPIRING_SOON || status === M3.STATUS.ENDING_SOON) {
    const urgent = M3_getThresholds().urgentLeadDays || 5;
    return daysRemaining !== null && daysRemaining <= urgent ? 'URGENT' : 'REMINDER';
  }
  return 'NONE';
}

/**
 * Returns enriched assessments with supplier, document and type metadata for the UI table.
 */
function M3_getAssessments(options) {
  const opts = options || {};
  const asms = M3_freshAssessments(opts.referenceDate);

  const suppliers = M1_listSuppliers();
  const supMap = {};
  suppliers.forEach((s) => { supMap[s.supplierId] = s; });

  const docs = readTable(SEG.TABS.DOCUMENTS);
  const docMap = {};
  docs.forEach((d) => { docMap[d.doc_id] = d; });

  const master = M1_loadMasterData();
  const typeMap = {};
  (master.documentTypes || []).forEach((t) => { typeMap[t.docTypeId] = t; });

  const reqs = readTable(SEG.TABS.SUPPLIER_REQS);
  const reqMap = {};
  reqs.forEach((r) => { reqMap[r.requirement_id] = r; });

  const enriched = asms.map((a) => {
    const sup = supMap[a.supplier_id] || {};
    const doc = docMap[a.doc_id] || {};
    const req = reqMap[a.requirement_id] || {};
    const typeId = doc.doc_type_id || req.doc_type_id;
    const type = typeMap[typeId] || {};

    return {
      assessmentId: a.assessment_id,
      docId: a.doc_id,
      requirementId: a.requirement_id,
      supplierId: a.supplier_id,
      supplierName: sup.supplierName || 'Unknown Supplier',
      registrationNo: sup.registrationNo || '',
      criticality: sup.criticality || 'MEDIUM',
      contactEmail: sup.contactEmail || '',
      contactPerson: sup.contactPerson || '',
      internalOfficer: sup.internalOfficer || '',
      docTypeName: type.name || req.label || 'Document',
      documentClass: type.documentClass || doc.document_class || 'CERTIFICATE',
      docFileName: doc.original_file_name || doc.file_name || '',
      fileUrl: doc.file_url || '',
      dueDate: a.due_date,
      daysRemaining: a.days_remaining !== '' ? Number(a.days_remaining) : null,
      status: a.status,
      riskLevel: a.risk_level,
      reason: a.reason,
      recommendedAction: a.recommended_action,
      reminderStage: M3_reminderStage(a.status, a.days_remaining !== '' ? Number(a.days_remaining) : null),
      mandatory: req.mandatory ? SEG_bool(req.mandatory, true) : true,
      assessedAt: a.assessed_at
    };
  });

  // Optional filtering
  let filtered = enriched;
  if (opts.riskLevel) {
    filtered = filtered.filter((item) => item.riskLevel === opts.riskLevel);
  }
  if (opts.status) {
    filtered = filtered.filter((item) => item.status === opts.status);
  }
  if (opts.documentClass) {
    filtered = filtered.filter((item) => item.documentClass === opts.documentClass);
  }
  if (opts.supplierId) {
    filtered = filtered.filter((item) => item.supplierId === opts.supplierId);
  }
  if (opts.query) {
    const q = String(opts.query).toLowerCase().trim();
    filtered = filtered.filter((item) =>
      item.supplierName.toLowerCase().indexOf(q) !== -1 ||
      item.supplierId.toLowerCase().indexOf(q) !== -1 ||
      item.docTypeName.toLowerCase().indexOf(q) !== -1 ||
      item.docId.toLowerCase().indexOf(q) !== -1 ||
      item.reason.toLowerCase().indexOf(q) !== -1
    );
  }

  return filtered;
}

/**
 * Returns overall risk summary metrics for the main Overview dashboard and M3 page.
 */
function M3_getRiskSummary(options) {
  const opts = options || {};
  const asms = M3_freshAssessments(opts.referenceDate);
  const suppliers = M1_listSuppliers().filter((s) => !s.deactivated && s.registrationStatus !== SEG.REGISTRATION_STATUS.DRAFT);
  const summary = M3_calculateSummary(asms, suppliers);
  summary.thresholds = M3_getThresholds();
  summary.referenceDate = opts.referenceDate || SEG_today();
  return summary;
}

/* ============================================================ Editor Self-Test */

/**
 * Comprehensive self-test for Member 3 logic and rules.
 * Verifies date difference, rule evaluation, risk calculation and threshold resolution.
 */
function test_M3_rules() {
  let passed = 0;
  const assert = (cond, msg) => {
    if (!cond) throw new Error('Assertion failed: ' + msg);
    passed++;
  };

  // 1. Date math
  assert(M3_diffDays('2026-11-20', '2026-11-11') === 9, 'Difference 2026-11-20 - 2026-11-11 is 9 days');
  assert(M3_diffDays('2026-10-15', '2026-11-11') === -27, 'Difference 2026-10-15 - 2026-11-11 is -27 days');
  assert(M3_diffDays('2026-11-11', '2026-11-11') === 0, 'Same day difference is 0');
  assert(M3_diffDays('', '2026-11-11') === null, 'Empty date gives null');

  // 2. Threshold resolution
  const sys = M3_getThresholds();
  assert(M3_getThreshold('CONTRACT', null, null, { renewal_notice_days: 60 }) === 60, 'Contract extracted notice days honored');
  assert(M3_getThreshold('CERTIFICATE', { default_reminder_days: 30 }, null, null) === 30, 'DocType default reminder honored');

  // 3. Risk calculation
  assert(M3_calculateRiskLevel('EXPIRED', -5, 'HIGH', true, false) === 'CRITICAL', 'Expired mandatory document on HIGH criticality supplier is CRITICAL');
  assert(M3_calculateRiskLevel('EXPIRED', -5, 'LOW', true, false) === 'CRITICAL', 'Any expired mandatory document is CRITICAL');
  assert(M3_calculateRiskLevel('MISSING', null, 'HIGH', true, false) === 'CRITICAL', 'Missing mandatory document on HIGH criticality is CRITICAL');
  assert(M3_calculateRiskLevel('EXPIRING_SOON', 5, 'LOW', true, false) === 'HIGH', 'Expiring in 5 days is HIGH');
  assert(M3_calculateRiskLevel('EXPIRING_SOON', 6, 'HIGH', true, false) === 'MEDIUM', 'Expiring in 6 days is MEDIUM');
  assert(M3_calculateRiskLevel('EXPIRING_SOON', 30, 'LOW', true, false) === 'MEDIUM', 'Expiring in 30 days is MEDIUM');
  assert(M3_calculateRiskLevel('VALID', 120, 'HIGH', true, false) === 'LOW', 'Valid document is LOW risk');
  assert(M3_calculateRiskLevel('NEEDS_REVIEW', 100, 'HIGH', true, true) === 'HIGH', 'Needs review on HIGH criticality is HIGH');

  // 4. Document evaluation scenarios
  const mockSupplier = { supplierId: 'SUP001', supplierName: 'Acme Corp', criticality: 'HIGH', contactEmail: 'test@acme.com', internalOfficer: 'John Doe' };
  const mockReq = { requirement_id: 'REQ001', label: 'Security Licence', mandatory: 'TRUE', reminder_days: 30 };
  const mockType = { doc_type_id: 'SEC_LIC', document_class: 'LICENCE', has_expiry: 'TRUE', default_reminder_days: 30 };

  // Expired licence
  const resExpired = M3_evaluateDocument(
    { doc_id: 'DOC001', requirement_id: 'REQ001', supplier_id: 'SUP001', document_class: 'LICENCE' },
    { processingStatus: 'APPROVED', issues: [], fields: { due_date: '2026-10-15' } },
    mockSupplier, mockReq, mockType, '2026-11-11'
  );
  assert(resExpired.status === 'EXPIRED', 'Past licence classified as EXPIRED');
  assert(resExpired.riskLevel === 'CRITICAL', 'Expired on HIGH criticality is CRITICAL');

  // Expiring soon certificate
  const resExpiring = M3_evaluateDocument(
    { doc_id: 'DOC002', requirement_id: 'REQ001', supplier_id: 'SUP001', document_class: 'CERTIFICATE' },
    { processingStatus: 'APPROVED', issues: [], fields: { due_date: '2026-11-20' } },
    mockSupplier, mockReq, mockType, '2026-11-11'
  );
  assert(resExpiring.status === 'EXPIRING_SOON', 'Expiring in 9 days classified as EXPIRING_SOON');
  assert(resExpiring.riskLevel === 'MEDIUM', 'Expiring in 9 days is MEDIUM');

  // Unreadable scan
  const resUnreadable = M3_evaluateDocument(
    { doc_id: 'DOC003', requirement_id: 'REQ001', supplier_id: 'SUP001', document_class: 'CERTIFICATE' },
    { processingStatus: 'NEEDS_REVIEW', issues: ['UNREADABLE'], fields: {} },
    mockSupplier, mockReq, mockType, '2026-11-11'
  );
  assert(resUnreadable.status === 'NEEDS_REVIEW', 'Unreadable scan classified as NEEDS_REVIEW');
  assert(resUnreadable.riskLevel === 'HIGH', 'Unreadable scan is HIGH');

  // Open-ended contract
  const resOpenEnded = M3_evaluateDocument(
    { doc_id: 'DOC004', requirement_id: 'REQ001', supplier_id: 'SUP001', document_class: 'CONTRACT' },
    { processingStatus: 'APPROVED', issues: [], fields: {} },
    mockSupplier, mockReq, { document_class: 'CONTRACT' }, '2026-11-11'
  );
  assert(resOpenEnded.status === 'NO_FIXED_END_DATE', 'Contract without end date classified as NO_FIXED_END_DATE');
  assert(resOpenEnded.riskLevel === 'LOW', 'Open ended contract is LOW risk');

  // Missing mandatory requirement
  const resMissing = M3_evaluateMissingRequirement(mockReq, mockSupplier, mockType, '2026-11-11');
  assert(resMissing.status === 'MISSING', 'Unfulfilled mandatory requirement is MISSING');
  assert(resMissing.riskLevel === 'CRITICAL', 'Missing on HIGH criticality is CRITICAL');

  // Never read / failed read must not look compliant
  const sampleDoc = { doc_id: 'DOC005', requirement_id: 'REQ001', supplier_id: 'SUP001', document_class: 'CERTIFICATE' };
  const resNotRead = M3_evaluateDocument(sampleDoc, null, mockSupplier, mockReq, mockType, '2026-11-11');
  assert(resNotRead.status === 'NEEDS_REVIEW', 'Document never read is NEEDS_REVIEW, not VALID');
  const resFailed = M3_evaluateDocument(sampleDoc,
    { processingStatus: 'FAILED', issues: ['EXTRACTION_FAILED'], fields: {} }, mockSupplier, mockReq, mockType, '2026-11-11');
  assert(resFailed.status === 'NEEDS_REVIEW', 'Failed read is NEEDS_REVIEW, not VALID');

  // Officer-approved reading with a known issue is resolved
  const resApproved = M3_evaluateDocument(sampleDoc,
    { processingStatus: 'APPROVED', approved: true, issues: ['NAME_MISMATCH'], fields: { due_date: '2027-06-30' } },
    mockSupplier, mockReq, mockType, '2026-11-11');
  assert(resApproved.status === 'VALID', 'APPROVED reading with NAME_MISMATCH is classified by its date, got ' + resApproved.status);

  // Unapproved reading is flagged in the reason
  const resUnapproved = M3_evaluateDocument(sampleDoc,
    { processingStatus: 'EXTRACTED', approved: false, issues: [], fields: { due_date: '2027-06-30' } },
    mockSupplier, mockReq, mockType, '2026-11-11');
  assert(/not yet approved/.test(resUnapproved.reason), 'Unapproved reading is mentioned in the reason');

  console.log('test_M3_rules: all ' + passed + ' checks passed.');
  return passed;
}

