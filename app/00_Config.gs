/**
 * 00_Config.gs · Shared contract · Owner: Member 5 (integration)
 *
 * Tab names, column headers, status values and limits used by every module.
 * Every member keeps this file identical. To change it, agree with Member 5 first
 * and tell the whole team.
 *
 * Columns for tabs owned by Members 2–5 are a starting point. Each owner may add
 * columns at the END of their own tab. Never rename or reorder existing columns,
 * because other modules read them by name.
 */
const SEG = {
  APP_NAME: 'AlphaTrack',
  TAGLINE: 'Stay ahead of every supplier expiry',
  COMPANY: 'Alpha Electronics Sdn. Bhd.',
  TIMEZONE: 'Asia/Kuala_Lumpur',
  ROOT_FOLDER_NAME: 'AlphaTrack - Supplier Documents',

  TABS: {
    SUPPLIERS: 'Suppliers',                  // Member 1
    CATEGORIES: 'SupplierCategories',        // Member 1
    DOC_TYPES: 'DocumentTypes',              // Member 1
    CATEGORY_REQS: 'CategoryRequirements',   // Member 1
    SUPPLIER_REQS: 'SupplierRequirements',   // Member 1
    DOCUMENTS: 'Documents',                  // Member 1
    EXTRACTIONS: 'Extractions',              // Member 2
    ASSESSMENTS: 'Assessments',              // Member 3
    NOTIFICATIONS: 'Notifications',          // Member 4
    CASES: 'RenewalCases',                   // Member 4
    AUDIT: 'AuditLog',                       // shared: every module appends through SEG_audit()
    RUNS: 'RunSummary',                      // Member 5
    GROUND_TRUTH: 'GroundTruth'              // testing only: live logic must never read it
  },

  HEADERS: {
    Suppliers: ['supplier_id', 'supplier_name', 'registration_no', 'category_id', 'goods_services', 'contact_person',
      'contact_email', 'internal_officer', 'criticality', 'procurement_ref', 'procurement_status', 'registration_status',
      'drive_folder_id', 'submitted_at', 'created_at', 'updated_at', 'created_by',
      'account_status', 'deactivated_at', 'deactivated_by', 'deactivation_reason'],
    SupplierCategories: ['category_id', 'category_name', 'description', 'active'],
    DocumentTypes: ['doc_type_id', 'doc_type_name', 'document_class', 'has_expiry', 'default_reminder_days', 'description', 'active'],
    CategoryRequirements: ['category_id', 'doc_type_id', 'mandatory', 'reminder_days', 'notes'],
    SupplierRequirements: ['requirement_id', 'supplier_id', 'doc_type_id', 'label', 'mandatory', 'reminder_days',
      'review_date', 'source', 'active', 'updated_at'],
    Documents: ['doc_id', 'supplier_id', 'requirement_id', 'doc_type_id', 'document_class', 'version', 'lifecycle_status',
      'replaces_doc_id', 'replaced_by_doc_id', 'file_id', 'file_name', 'original_file_name', 'mime_type', 'file_size',
      'file_hash', 'file_url', 'uploaded_at', 'uploaded_by', 'extraction_requested_at'],
    Extractions: ['doc_id', 'supplier_id', 'document_class', 'file_id', 'processing_status', 'extracted_json', 'issues',
      'extracted_at', 'model', 'corrected_by', 'corrected_at'],
    Assessments: ['assessment_id', 'doc_id', 'requirement_id', 'supplier_id', 'assessment_type', 'due_date', 'days_remaining',
      'status', 'risk_level', 'reason', 'recommended_action', 'assessed_at'],
    Notifications: ['notification_id', 'case_id', 'supplier_id', 'doc_id', 'stage', 'notification_type', 'recipient', 'subject',
      'approval_status', 'delivery_status', 'created_at', 'approved_by', 'approved_at', 'sent_at', 'follow_up_due'],
    RenewalCases: ['case_id', 'supplier_id', 'requirement_id', 'doc_id', 'case_type', 'status', 'opened_at', 'resolved_at', 'resolution'],
    AuditLog: ['timestamp', 'actor', 'module', 'action', 'record_type', 'record_id', 'supplier_id', 'outcome', 'reason', 'details'],
    RunSummary: ['run_id', 'started_at', 'finished_at', 'trigger', 'suppliers_checked', 'documents_checked', 'extractions_run',
      'assessments_made', 'notifications_prepared', 'errors', 'notes'],
    GroundTruth: ['doc_id', 'file_name', 'supplier_id', 'supplier_name', 'document_type', 'document_class', 'holder_name',
      'document_no', 'issuing_body', 'client_name', 'issue_date', 'start_date', 'due_date', 'renewal_notice_days',
      'auto_renewal', 'scope', 'expected_status', 'expected_issues', 'reference_date', 'scenario', 'notes']
  },

  // Supplier registration (Member 1). Separate from compliance status (Member 3).
  REGISTRATION_STATUS: {
    DRAFT: 'DRAFT',
    PENDING_DOCUMENTS: 'PENDING_DOCUMENTS',
    PENDING_VERIFICATION: 'PENDING_VERIFICATION',
    ACTIVE_MONITORING: 'ACTIVE_MONITORING'
  },

  // Whether AlphaTrack still looks after a supplier (Member 1). Blank means ACTIVE.
  // A DEACTIVATED supplier keeps every record and document but is no longer monitored,
  // extracted or reminded: Members 2-4 skip it (use M1_isMonitored / M1_getMonitoredSuppliers).
  ACCOUNT_STATUS: { ACTIVE: 'ACTIVE', DEACTIVATED: 'DEACTIVATED' },

  // A document version is ACTIVE until a newer version for the same requirement replaces it.
  LIFECYCLE: { ACTIVE: 'ACTIVE', SUPERSEDED: 'SUPERSEDED' },

  DOC_CLASS: { CONTRACT: 'CONTRACT', LICENCE: 'LICENCE', CERTIFICATE: 'CERTIFICATE' },

  CRITICALITY: ['LOW', 'MEDIUM', 'HIGH'],

  // processing_status values in Extractions that mean "done": a person has signed the AI's reading off.
  // EXTRACTED only means "the AI has read it, waiting for approval" (team decision, 11 Nov 2026).
  // APPROVED = an officer approved the fields as read; CORRECTED = an officer fixed and saved them.
  EXTRACTION_OK: ['APPROVED', 'CORRECTED'],

  UPLOAD: {
    MAX_BYTES: 10 * 1024 * 1024,
    TYPES: { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' }
  }
};
