/**
 * M1_Suppliers.gs · Member 1: Supplier Registration & Document Management
 *
 * Owns tabs:  Suppliers, SupplierCategories, DocumentTypes, CategoryRequirements,
 *             SupplierRequirements, Documents
 * Reads:      Extractions (Member 2), only to show AI status and to know when a
 *             supplier can move to ACTIVE_MONITORING.
 *
 * Called by the web page (google.script.run):
 *   M1_getBootstrap()                          master data for the forms
 *   M1_listSuppliers()                         rows for the supplier table
 *   M1_getSupplierDetail(supplierId)           one supplier with requirements and document history
 *   M1_saveSupplierDraft(payload)              create or update a DRAFT (steps 1–3 of the wizard)
 *   M1_registerSupplier(supplierId)            submit the registration (step 5)
 *   M1_updateSupplierInfo(supplierId, info)    edit details later
 *   M1_saveSupplierRequirements(supplierId, list)  edit the document checklist later
 *   M1_uploadDocument(upload)                  save a file to Drive, record it, queue AI extraction
 *
 * Called by other modules (the hand-off):
 *   M1_getSupplier(supplierId)                 -> Supplier
 *   M1_getSupplierRequirements(supplierId)     -> Requirement[]   (Member 3: missing documents)
 *   M1_getDocuments(supplierId?)               -> Document[]      (every version)
 *   M1_getDocumentsAwaitingExtraction()        -> Document[]      (Member 2's work queue)
 *   M1_refreshRegistrationStatus(supplierId)   -> status          (call after an extraction finishes)
 *
 * Tests:
 *   test_M1_rules()      no Google services needed
 *   test_M1_endToEnd()   uses the Sheet and Drive; creates a supplier named "TEST …"
 *   M1_removeTestSuppliers()  removes those TEST suppliers again
 */

/* ------------------------------------------------------------ Drive layout */

/**
 * Inside each supplier's Drive folder ("SUP001 - BrightClean Sdn. Bhd."), documents are
 * filed by class. When a renewed version is uploaded, the replaced file moves into that
 * class's "Old versions" folder, so the current documents are always at the top level.
 */
const M1_DRIVE_FOLDERS = {
  CONTRACT: '1. Contracts & Agreements',
  LICENCE: '2. Licences & Permits',
  CERTIFICATE: '3. Certificates & Insurance',
  OLD_VERSIONS: 'Old versions',
  DEACTIVATED: 'Deactivated suppliers'      // in the main folder; holds the folders of deactivated suppliers
};

/* ------------------------------------------------------------ Master data */

/**
 * Starting categories, document types and category defaults. They are copied into
 * the Sheet once by SEG_setupDatabase(); after that, the Sheet is the source of
 * truth and can be edited there without touching code.
 * These are Alpha Electronics' internal requirements, not a statement of Malaysian law.
 */
const M1_DEFAULTS = {
  categories: [
    ['CLEANING', 'Cleaning Services', 'Factory and office cleaning'],
    ['SECURITY', 'Security Services', 'Guarding and site security'],
    ['ELECTRICAL', 'Electrical Maintenance', 'Electrical installation and maintenance contractors'],
    ['ELECTRONIC_COMPONENTS', 'Electronic Components', 'Suppliers of electronic components and materials'],
    ['LOGISTICS', 'Logistics & Transportation', 'Freight, delivery and transport providers']
  ],
  // id, name, class, has an expiry or end date, default reminder days, description
  docTypes: [
    ['CLEANING_SERVICE_AGREEMENT', 'Cleaning Service Agreement', 'CONTRACT', true, 60, ''],
    ['SECURITY_SERVICE_AGREEMENT', 'Security Service Agreement', 'CONTRACT', true, 60, ''],
    ['ELECTRICAL_MAINTENANCE_AGREEMENT', 'Electrical Maintenance Agreement', 'CONTRACT', true, 60, ''],
    ['SUPPLY_AGREEMENT', 'Supply Agreement', 'CONTRACT', true, 60, ''],
    ['TRANSPORTATION_SERVICE_AGREEMENT', 'Transportation Service Agreement', 'CONTRACT', true, 60, ''],
    ['NON_DISCLOSURE_AGREEMENT', 'Non-Disclosure Agreement', 'CONTRACT', false, 60, 'Often has no fixed end date; set a review date'],
    ['SECURITY_AGENCY_LICENCE', 'Security Agency Licence', 'LICENCE', true, 30, ''],
    ['CONTRACTOR_REGISTRATION', 'Contractor Registration', 'LICENCE', true, 30, ''],
    ['OPERATING_PERMIT', 'Operating Permit', 'LICENCE', true, 30, ''],
    ['BUSINESS_REGISTRATION_RECORD', 'Business Registration Record', 'LICENCE', false, 30, 'Usually no expiry; set a review date'],
    ['INSURANCE_CERTIFICATE', 'Insurance Certificate', 'CERTIFICATE', true, 30, ''],
    ['ISO_9001_CERTIFICATE', 'ISO 9001 Certificate', 'CERTIFICATE', true, 60, ''],
    ['ELECTRICAL_COMPETENCY_EVIDENCE', 'Electrical Competency Evidence', 'CERTIFICATE', true, 30, ''],
    ['PRODUCT_CONFORMITY_DOCUMENTATION', 'Product Conformity Documentation', 'CERTIFICATE', true, 30, ''],
    ['TECHNICAL_COMPETENCY_CERTIFICATE', 'Technical Competency Certificate', 'CERTIFICATE', true, 30, ''],
    ['SAFETY_CERTIFICATION', 'Safety-related Certification', 'CERTIFICATE', true, 30, '']
  ],
  // category, document type, mandatory
  categoryRequirements: [
    ['CLEANING', 'CLEANING_SERVICE_AGREEMENT', true],
    ['CLEANING', 'INSURANCE_CERTIFICATE', true],
    ['CLEANING', 'BUSINESS_REGISTRATION_RECORD', true],
    ['SECURITY', 'SECURITY_SERVICE_AGREEMENT', true],
    ['SECURITY', 'SECURITY_AGENCY_LICENCE', true],
    ['SECURITY', 'INSURANCE_CERTIFICATE', true],
    ['ELECTRICAL', 'ELECTRICAL_MAINTENANCE_AGREEMENT', true],
    ['ELECTRICAL', 'CONTRACTOR_REGISTRATION', true],
    ['ELECTRICAL', 'ELECTRICAL_COMPETENCY_EVIDENCE', true],
    ['ELECTRICAL', 'INSURANCE_CERTIFICATE', true],
    ['ELECTRONIC_COMPONENTS', 'SUPPLY_AGREEMENT', true],
    ['ELECTRONIC_COMPONENTS', 'ISO_9001_CERTIFICATE', false],
    ['ELECTRONIC_COMPONENTS', 'PRODUCT_CONFORMITY_DOCUMENTATION', false],
    ['LOGISTICS', 'TRANSPORTATION_SERVICE_AGREEMENT', true],
    ['LOGISTICS', 'OPERATING_PERMIT', true],
    ['LOGISTICS', 'INSURANCE_CERTIFICATE', true]
  ]
};

/** Copies M1_DEFAULTS into any master-data tab that is still empty. Called by SEG_setupDatabase(). */
function M1_seedMasterData() {
  const seeded = [];
  if (!readTable(SEG.TABS.CATEGORIES).length) {
    appendRows(SEG.TABS.CATEGORIES, M1_DEFAULTS.categories.map((c) => ({
      category_id: c[0], category_name: c[1], description: c[2], active: true
    })));
    seeded.push(SEG.TABS.CATEGORIES);
  }
  if (!readTable(SEG.TABS.DOC_TYPES).length) {
    appendRows(SEG.TABS.DOC_TYPES, M1_DEFAULTS.docTypes.map((t) => ({
      doc_type_id: t[0], doc_type_name: t[1], document_class: t[2], has_expiry: t[3],
      default_reminder_days: t[4], description: t[5], active: true
    })));
    seeded.push(SEG.TABS.DOC_TYPES);
  }
  if (!readTable(SEG.TABS.CATEGORY_REQS).length) {
    appendRows(SEG.TABS.CATEGORY_REQS, M1_DEFAULTS.categoryRequirements.map((r) => ({
      category_id: r[0], doc_type_id: r[1], mandatory: r[2], reminder_days: '', notes: ''
    })));
    seeded.push(SEG.TABS.CATEGORY_REQS);
  }
  return seeded;
}

/** Reads the three master-data tabs into plain objects. */
function M1_loadMasterData() {
  return M1_masterFromRows(
    readTable(SEG.TABS.CATEGORIES),
    readTable(SEG.TABS.DOC_TYPES),
    readTable(SEG.TABS.CATEGORY_REQS)
  );
}

/** The same shape built straight from M1_DEFAULTS (used by tests that need no Sheet). */
function M1_defaultMaster() {
  return M1_masterFromRows(
    M1_DEFAULTS.categories.map((c) => ({ category_id: c[0], category_name: c[1], description: c[2], active: 'TRUE' })),
    M1_DEFAULTS.docTypes.map((t) => ({
      doc_type_id: t[0], doc_type_name: t[1], document_class: t[2], has_expiry: String(t[3]).toUpperCase(),
      default_reminder_days: String(t[4]), description: t[5], active: 'TRUE'
    })),
    M1_DEFAULTS.categoryRequirements.map((r) => ({ category_id: r[0], doc_type_id: r[1], mandatory: String(r[2]).toUpperCase(), reminder_days: '' }))
  );
}

function M1_masterFromRows(categoryRows, typeRows, categoryReqRows) {
  const categories = categoryRows
    .filter((r) => r.category_id && SEG_bool(r.active, true))
    .map((r) => ({ categoryId: String(r.category_id), name: String(r.category_name || r.category_id), description: String(r.description || '') }));
  const docTypes = typeRows
    .filter((r) => r.doc_type_id && SEG_bool(r.active, true))
    .map((r) => {
      const docClass = String(r.document_class || SEG.DOC_CLASS.CERTIFICATE).toUpperCase();
      const days = Number(r.default_reminder_days);
      return {
        docTypeId: String(r.doc_type_id),
        name: String(r.doc_type_name || r.doc_type_id),
        documentClass: docClass,
        hasExpiry: SEG_bool(r.has_expiry, true),
        defaultReminderDays: Number.isInteger(days) && days > 0 ? days : (docClass === SEG.DOC_CLASS.CONTRACT ? 60 : 30),
        description: String(r.description || '')
      };
    });
  const categoryRequirements = categoryReqRows
    .filter((r) => r.category_id && r.doc_type_id)
    .map((r) => ({
      categoryId: String(r.category_id),
      docTypeId: String(r.doc_type_id),
      mandatory: SEG_bool(r.mandatory, true),
      reminderDays: r.reminder_days === '' || r.reminder_days === undefined ? null : Number(r.reminder_days)
    }));
  return { categories: categories, docTypes: docTypes, categoryRequirements: categoryRequirements };
}

/** The suggested checklist for a category, ready to customise. */
function M1_suggestedChecklist(categoryId, master) {
  const types = M1_indexBy(master.docTypes, 'docTypeId');
  return master.categoryRequirements
    .filter((r) => r.categoryId === categoryId && types[r.docTypeId])
    .map((r) => ({
      requirementId: '',
      docTypeId: r.docTypeId,
      label: '',
      mandatory: r.mandatory,
      reminderDays: r.reminderDays || types[r.docTypeId].defaultReminderDays,
      reviewDate: '',
      source: 'CATEGORY_DEFAULT'
    }));
}

/* ------------------------------------------------------------ Validation */

/**
 * Cleans and checks supplier details. mode 'draft' needs only the name;
 * mode 'submit' needs every field the registration requires.
 * Returns { info, errors: { field: message }, ok }.
 */
function M1_validateInfo(input, mode, master, suppliers, selfId) {
  const src = input || {};
  const text = (v, max) => String(v === undefined || v === null ? '' : v).trim().slice(0, max);
  const info = {
    supplierName: text(src.supplierName, 120),
    registrationNo: text(src.registrationNo, 40),
    categoryId: text(src.categoryId, 40),
    goodsServices: text(src.goodsServices, 300),
    contactPerson: text(src.contactPerson, 120),
    contactEmail: text(src.contactEmail, 120).toLowerCase(),
    internalOfficer: text(src.internalOfficer, 120),
    criticality: text(src.criticality, 10).toUpperCase(),
    procurementRef: text(src.procurementRef, 60)
  };
  const full = mode === 'submit';
  const errors = {};
  if (info.supplierName.length < 2) errors.supplierName = 'Enter the supplier company name.';
  if (full && !info.registrationNo) errors.registrationNo = 'Enter the company registration number.';
  if (full && !info.categoryId) errors.categoryId = 'Choose a supplier category.';
  if (info.categoryId && !master.categories.some((c) => c.categoryId === info.categoryId)) errors.categoryId = 'Choose a supplier category from the list.';
  if (full && !info.contactEmail) errors.contactEmail = 'Enter the supplier contact email.';
  if (info.contactEmail && !SEG_isEmail(info.contactEmail)) errors.contactEmail = 'This email address doesn’t look right.';
  if (full && !info.internalOfficer) errors.internalOfficer = 'Enter the internal responsible officer.';
  if ((full || info.criticality) && SEG.CRITICALITY.indexOf(info.criticality) === -1) errors.criticality = 'Choose Low, Medium or High.';
  if (info.registrationNo) {
    const mine = SEG_cleanText(info.registrationNo);
    const clash = (suppliers || []).find((s) => String(s.supplier_id) !== String(selfId || '') && SEG_cleanText(s.registration_no) === mine);
    if (clash) {
      errors.registrationNo = 'Already registered as ' + clash.supplier_id + ' (' + clash.supplier_name + ')' +
        (M1_isDeactivated(clash) ? ', which is deactivated. Reactivate it instead of registering it again.' : '.');
    }
  }
  return { info: info, errors: errors, ok: Object.keys(errors).length === 0 };
}

function M1_assertValid(result) {
  if (!result.ok) {
    throw new Error('Please fix: ' + Object.keys(result.errors).map((k) => result.errors[k]).join(' '));
  }
  return result.info;
}

/** Checks and tidies a document checklist sent by the page. */
function M1_normaliseRequirements(list, master) {
  if (!Array.isArray(list)) throw new Error('The document checklist is missing.');
  const types = M1_indexBy(master.docTypes, 'docTypeId');
  return list.map((r) => {
    const type = types[String(r.docTypeId || '')];
    if (!type) throw new Error('Unknown document type: ' + r.docTypeId + '.');
    const raw = r.reminderDays;
    const days = raw === '' || raw === null || raw === undefined ? type.defaultReminderDays : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 730) {
      throw new Error(type.name + ': the reminder must be a whole number of days from 1 to 730.');
    }
    const reviewDate = String(r.reviewDate || '').trim();
    if (reviewDate && !/^\d{4}-\d{2}-\d{2}$/.test(reviewDate)) {
      throw new Error(type.name + ': the review date must look like 2027-01-31.');
    }
    return {
      requirementId: String(r.requirementId || ''),
      docTypeId: type.docTypeId,
      label: String(r.label || '').trim().slice(0, 80),
      mandatory: r.mandatory === true || r.mandatory === 'TRUE',
      reminderDays: days,
      reviewDate: type.hasExpiry ? '' : reviewDate,
      source: r.source === 'CATEGORY_DEFAULT' ? 'CATEGORY_DEFAULT' : 'ADDED'
    };
  });
}

/** True if the first bytes really are a PDF, PNG or JPEG (works with signed or unsigned bytes). */
function M1_contentMatchesType(bytes, mime) {
  const b = (i) => (bytes[i] === undefined ? -1 : bytes[i] & 0xff);
  if (mime === 'application/pdf') return b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46;
  if (mime === 'image/png') return b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47;
  if (mime === 'image/jpeg') return b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff;
  return false;
}

/* ------------------------------------------------- Registration progress */

/**
 * Works out a supplier's registration status. This is registration progress,
 * not compliance: expiry and risk come from Member 3.
 *   DRAFT                 not submitted yet
 *   PENDING_DOCUMENTS     submitted, a mandatory document has no current file
 *   PENDING_VERIFICATION  every mandatory document uploaded, not all read by AI yet
 *   ACTIVE_MONITORING     every mandatory document uploaded and read by AI
 * requirements: [{ requirementId, mandatory, name }] (active only)
 */
function M1_assessRegistration(submitted, requirements, documents, extractions) {
  const activeDoc = (reqId) => documents.find((d) => String(d.requirement_id) === String(reqId) && d.lifecycle_status === SEG.LIFECYCLE.ACTIVE) || null;
  const readByAi = (doc) => extractions.some((x) =>
    String(x.doc_id) === String(doc.doc_id) &&
    (!x.file_id || String(x.file_id) === String(doc.file_id)) &&
    SEG.EXTRACTION_OK.indexOf(String(x.processing_status)) >= 0);

  const mandatory = requirements.filter((r) => r.mandatory);
  const missing = mandatory.filter((r) => !activeDoc(r.requirementId)).map((r) => r.name);
  const unverified = mandatory.filter((r) => {
    const doc = activeDoc(r.requirementId);
    return doc && !readByAi(doc);
  }).map((r) => r.name);

  const S = SEG.REGISTRATION_STATUS;
  let status;
  let explanation;
  if (!submitted) {
    status = S.DRAFT;
    explanation = 'Registration not submitted yet.' + (missing.length ? ' Still to upload: ' + missing.join(', ') + '.' : '');
  } else if (missing.length) {
    status = S.PENDING_DOCUMENTS;
    explanation = 'Waiting for mandatory documents: ' + missing.join(', ') + '.';
  } else if (unverified.length) {
    status = S.PENDING_VERIFICATION;
    explanation = 'All mandatory documents uploaded. Waiting for AI extraction of: ' + unverified.join(', ') + '.';
  } else {
    status = S.ACTIVE_MONITORING;
    explanation = 'All mandatory documents uploaded and read by AI. Expiry monitoring is active.';
  }
  return {
    status: status,
    explanation: explanation,
    mandatoryTotal: mandatory.length,
    mandatoryUploaded: mandatory.length - missing.length,
    missing: missing,
    unverified: unverified
  };
}

/** Recalculates and saves a supplier's registration status. Returns the status. */
function M1_refreshRegistrationStatus(supplierId) {
  const supplier = M1_findSupplierRow(supplierId);
  const assessment = M1_assessSupplier(supplier);
  if (assessment.status !== supplier.registration_status) {
    updateRow(SEG.TABS.SUPPLIERS, supplier._row, { registration_status: assessment.status });
    SEG_audit({
      module: 'M1', action: 'REGISTRATION_STATUS_CHANGED', recordType: 'SUPPLIER', recordId: supplierId, supplierId: supplierId,
      outcome: assessment.status, reason: (supplier.registration_status || 'none') + ' -> ' + assessment.status + '. ' + assessment.explanation
    });
  }
  return assessment.status;
}

function M1_assessSupplier(supplier) {
  const types = M1_indexBy(M1_loadMasterData().docTypes, 'docTypeId');
  const reqs = M1_requirementViews(
    readTable(SEG.TABS.SUPPLIER_REQS).filter((r) => r.supplier_id === supplier.supplier_id && SEG_bool(r.active, true)), types);
  const docs = readTable(SEG.TABS.DOCUMENTS).filter((d) => d.supplier_id === supplier.supplier_id);
  return M1_assessRegistration(!!supplier.submitted_at, reqs, docs, M1_readExtractions());
}

/* --------------------------------------------------------- Page: reading */

function M1_getBootstrap() {
  const master = M1_loadMasterData();
  return {
    categories: master.categories,
    docTypes: master.docTypes,
    categoryRequirements: master.categoryRequirements,
    criticality: SEG.CRITICALITY,
    registrationStatuses: Object.keys(SEG.REGISTRATION_STATUS),
    upload: { maxBytes: SEG.UPLOAD.MAX_BYTES, types: Object.keys(SEG.UPLOAD.TYPES) },
    masterDataMissing: !master.categories.length || !master.docTypes.length
  };
}

/** The suggested checklist for one category, read from the Sheet. */
function M1_getCategoryChecklist(categoryId) {
  return M1_suggestedChecklist(categoryId, M1_loadMasterData());
}

function M1_listSuppliers() {
  const master = M1_loadMasterData();
  const categories = M1_indexBy(master.categories, 'categoryId');
  const types = M1_indexBy(master.docTypes, 'docTypeId');
  const reqs = readTable(SEG.TABS.SUPPLIER_REQS).filter((r) => SEG_bool(r.active, true));
  const docs = readTable(SEG.TABS.DOCUMENTS);
  const extractions = M1_readExtractions();
  return readTable(SEG.TABS.SUPPLIERS)
    .filter((s) => s.supplier_id)
    .map((s) => {
      const mine = M1_requirementViews(reqs.filter((r) => r.supplier_id === s.supplier_id), types);
      const myDocs = docs.filter((d) => d.supplier_id === s.supplier_id);
      const reg = M1_assessRegistration(!!s.submitted_at, mine, myDocs, extractions);
      return {
        supplierId: s.supplier_id,
        supplierName: s.supplier_name,
        registrationNo: s.registration_no,
        categoryId: s.category_id,
        categoryName: categories[s.category_id] ? categories[s.category_id].name : (s.category_id || 'Not chosen'),
        criticality: s.criticality,
        registrationStatus: s.registration_status || reg.status,
        mandatoryTotal: reg.mandatoryTotal,
        mandatoryUploaded: reg.mandatoryUploaded,
        missing: reg.missing,
        activeDocuments: myDocs.filter((d) => d.lifecycle_status === SEG.LIFECYCLE.ACTIVE).length,
        internalOfficer: s.internal_officer,
        accountStatus: M1_isDeactivated(s) ? SEG.ACCOUNT_STATUS.DEACTIVATED : SEG.ACCOUNT_STATUS.ACTIVE,
        deactivated: M1_isDeactivated(s),
        deactivatedAt: s.deactivated_at || '',
        updatedAt: s.updated_at
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function M1_getSupplierDetail(supplierId) {
  const master = M1_loadMasterData();
  const categories = M1_indexBy(master.categories, 'categoryId');
  const types = M1_indexBy(master.docTypes, 'docTypeId');
  const supplier = M1_findSupplierRow(supplierId);
  const reqRows = readTable(SEG.TABS.SUPPLIER_REQS).filter((r) => r.supplier_id === supplierId && SEG_bool(r.active, true));
  const reqs = M1_requirementViews(reqRows, types);
  const docs = readTable(SEG.TABS.DOCUMENTS).filter((d) => d.supplier_id === supplierId);
  const extractions = M1_readExtractions();

  const requirements = reqs.map((r) => {
    const history = docs
      .filter((d) => d.requirement_id === r.requirementId)
      .sort((a, b) => Number(b.version) - Number(a.version))
      .map((d) => M1_docView(d, extractions));
    return Object.assign({}, r, {
      current: history.find((h) => h.lifecycleStatus === SEG.LIFECYCLE.ACTIVE) || null,
      history: history
    });
  });
  const activeReqIds = {};
  reqs.forEach((r) => { activeReqIds[r.requirementId] = true; });
  const otherDocuments = docs
    .filter((d) => !activeReqIds[d.requirement_id])
    .map((d) => Object.assign(M1_docView(d, extractions), { docTypeName: types[d.doc_type_id] ? types[d.doc_type_id].name : d.doc_type_id }));

  const reg = M1_assessRegistration(!!supplier.submitted_at, reqs, docs, extractions);
  const activity = readTable(SEG.TABS.AUDIT)
    .filter((a) => a.supplier_id === supplierId)
    .slice(-30)
    .reverse()
    .map((a) => ({ timestamp: a.timestamp, actor: a.actor, action: a.action, recordId: a.record_id, outcome: a.outcome, reason: a.reason }));

  return {
    supplier: Object.assign(M1_rowToInfo(supplier), {
      supplierId: supplier.supplier_id,
      categoryName: categories[supplier.category_id] ? categories[supplier.category_id].name : '',
      procurementStatus: supplier.procurement_status,
      registrationStatus: supplier.registration_status || reg.status,
      submittedAt: supplier.submitted_at,
      createdAt: supplier.created_at,
      updatedAt: supplier.updated_at,
      driveFolderUrl: supplier.drive_folder_id ? 'https://drive.google.com/drive/folders/' + supplier.drive_folder_id : '',
      accountStatus: M1_isDeactivated(supplier) ? SEG.ACCOUNT_STATUS.DEACTIVATED : SEG.ACCOUNT_STATUS.ACTIVE,
      deactivated: M1_isDeactivated(supplier),
      deactivatedAt: supplier.deactivated_at || '',
      deactivatedBy: supplier.deactivated_by || '',
      deactivationReason: supplier.deactivation_reason || ''
    }),
    registration: reg,
    requirements: requirements,
    otherDocuments: otherDocuments,
    activity: activity
  };
}

/* --------------------------------------------------------- Page: writing */

/**
 * Wizard steps 1–3, and "Save draft" at any time.
 * payload = { supplierId?, info: {...}, requirements?: [...] }
 * Creates the supplier (status DRAFT) and its Drive folder on first save.
 */
function M1_saveSupplierDraft(payload) {
  const master = M1_loadMasterData();
  const user = SEG_currentUser();
  const saved = SEG_withLock(() => {
    const suppliers = readTable(SEG.TABS.SUPPLIERS);
    const wantedId = payload && payload.supplierId ? String(payload.supplierId) : '';
    const row = wantedId ? suppliers.find((s) => s.supplier_id === wantedId) : null;
    if (wantedId && !row) throw new Error('Supplier ' + wantedId + ' was not found.');
    if (row) M1_assertNotDeactivated(row);
    const submitted = !!(row && row.submitted_at);
    const info = M1_assertValid(M1_validateInfo(payload && payload.info, submitted ? 'submit' : 'draft', master, suppliers, wantedId));
    const requirements = payload && Array.isArray(payload.requirements) ? M1_normaliseRequirements(payload.requirements, master) : null;
    if (submitted && requirements && !requirements.some((r) => r.mandatory)) {
      throw new Error('A registered supplier needs at least one mandatory document.');
    }
    const now = SEG_now();
    let supplierId = wantedId;
    if (row) {
      updateRow(SEG.TABS.SUPPLIERS, row._row, Object.assign(M1_infoToRow(info), { updated_at: now }));
    } else {
      supplierId = SEG_newId('SUP', suppliers.map((s) => s.supplier_id), 3);
      appendRows(SEG.TABS.SUPPLIERS, [Object.assign(M1_infoToRow(info), {
        supplier_id: supplierId,
        procurement_status: 'APPROVED',
        registration_status: SEG.REGISTRATION_STATUS.DRAFT,
        created_at: now,
        updated_at: now,
        created_by: user
      })]);
    }
    if (requirements) M1_writeRequirements(supplierId, requirements);
    M1_ensureSupplierFolder(supplierId);
    return { supplierId: supplierId, isNew: !row, submitted: submitted, requirementsSaved: !!requirements };
  });

  SEG_audit({
    module: 'M1', action: saved.isNew ? 'SUPPLIER_DRAFT_CREATED' : 'SUPPLIER_DRAFT_SAVED', recordType: 'SUPPLIER',
    recordId: saved.supplierId, supplierId: saved.supplierId, outcome: 'OK',
    reason: saved.requirementsSaved ? 'Details and document checklist saved.' : 'Details saved.'
  });
  if (saved.submitted) M1_refreshRegistrationStatus(saved.supplierId);
  return M1_getSupplierDetail(saved.supplierId);
}

/** Wizard step 5: submit the registration. Missing documents are allowed; the status says so. */
function M1_registerSupplier(supplierId) {
  const master = M1_loadMasterData();
  SEG_withLock(() => {
    const supplier = M1_findSupplierRow(supplierId);
    M1_assertNotDeactivated(supplier);
    M1_assertValid(M1_validateInfo(M1_rowToInfo(supplier), 'submit', master, readTable(SEG.TABS.SUPPLIERS), supplierId));
    const hasMandatory = readTable(SEG.TABS.SUPPLIER_REQS)
      .some((r) => r.supplier_id === supplierId && SEG_bool(r.active, true) && SEG_bool(r.mandatory, false));
    if (!hasMandatory) throw new Error('Add at least one mandatory document to the checklist before registering.');
    const now = SEG_now();
    updateRow(SEG.TABS.SUPPLIERS, supplier._row, { submitted_at: supplier.submitted_at || now, updated_at: now });
  });
  const status = M1_refreshRegistrationStatus(supplierId);
  SEG_audit({
    module: 'M1', action: 'SUPPLIER_REGISTERED', recordType: 'SUPPLIER', recordId: supplierId, supplierId: supplierId,
    outcome: status, reason: 'Registration submitted. Status: ' + status + '.'
  });
  return M1_getSupplierDetail(supplierId);
}

/** Edit a supplier's details after registration. */
function M1_updateSupplierInfo(supplierId, input) {
  const master = M1_loadMasterData();
  const changed = SEG_withLock(() => {
    const suppliers = readTable(SEG.TABS.SUPPLIERS);
    const row = suppliers.find((s) => s.supplier_id === supplierId);
    if (!row) throw new Error('Supplier ' + supplierId + ' was not found.');
    M1_assertNotDeactivated(row);
    const info = M1_assertValid(M1_validateInfo(input, row.submitted_at ? 'submit' : 'draft', master, suppliers, supplierId));
    const before = M1_rowToInfo(row);
    const fields = Object.keys(info).filter((k) => String(before[k] || '') !== String(info[k] || ''));
    if (fields.length) updateRow(SEG.TABS.SUPPLIERS, row._row, Object.assign(M1_infoToRow(info), { updated_at: SEG_now() }));
    return fields;
  });
  if (changed.length) {
    SEG_audit({
      module: 'M1', action: 'SUPPLIER_UPDATED', recordType: 'SUPPLIER', recordId: supplierId, supplierId: supplierId,
      outcome: 'OK', reason: 'Changed: ' + changed.join(', ') + '.'
    });
  }
  return M1_getSupplierDetail(supplierId);
}

/** Edit a supplier's document checklist after registration. */
function M1_saveSupplierRequirements(supplierId, list) {
  const master = M1_loadMasterData();
  const requirements = M1_normaliseRequirements(list, master);
  const summary = SEG_withLock(() => {
    const supplier = M1_findSupplierRow(supplierId);
    M1_assertNotDeactivated(supplier);
    if (supplier.submitted_at && !requirements.some((r) => r.mandatory)) {
      throw new Error('A registered supplier needs at least one mandatory document.');
    }
    const result = M1_writeRequirements(supplierId, requirements);
    updateRow(SEG.TABS.SUPPLIERS, supplier._row, { updated_at: SEG_now() });
    result.submitted = !!supplier.submitted_at;
    return result;
  });
  SEG_audit({
    module: 'M1', action: 'REQUIREMENTS_UPDATED', recordType: 'SUPPLIER', recordId: supplierId, supplierId: supplierId, outcome: 'OK',
    reason: summary.added + ' added, ' + summary.updated + ' kept or changed, ' + summary.removed + ' removed.'
  });
  if (summary.submitted) M1_refreshRegistrationStatus(supplierId);
  return M1_getSupplierDetail(supplierId);
}

/**
 * Saves one uploaded file to the supplier's Drive folder, records it in Documents
 * and queues it for AI extraction. A newer file for the same requirement becomes
 * the ACTIVE version; the older one is kept as SUPERSEDED (never deleted).
 * upload = { supplierId, requirementId, fileName, mimeType, base64 }
 */
function M1_uploadDocument(upload) {
  const u = upload || {};
  if (!u.supplierId || !u.requirementId) throw new Error('Choose the supplier and the document first.');
  const user = SEG_currentUser();

  let result;
  try {
    const mime = String(u.mimeType || '').toLowerCase();
    const ext = SEG.UPLOAD.TYPES[mime];
    if (!ext) throw new Error('Only PDF, PNG or JPG files can be uploaded. PDF is preferred.');
    let bytes;
    try {
      bytes = Utilities.base64Decode(String(u.base64 || ''));
    } catch (err) {
      throw new Error('The file could not be read. Please choose it again.');
    }
    if (!bytes.length) throw new Error('The file is empty.');
    if (bytes.length > SEG.UPLOAD.MAX_BYTES) throw new Error('The file is larger than 10 MB. Please upload a smaller copy.');
    if (!M1_contentMatchesType(bytes, mime)) throw new Error('This file is not a real ' + ext.toUpperCase() + '. Its contents don’t match its type.');
    const hash = M1_hash(bytes);

    result = SEG_withLock(() => {
      const supplier = M1_findSupplierRow(u.supplierId);
      M1_assertNotDeactivated(supplier);
      const req = readTable(SEG.TABS.SUPPLIER_REQS).find((r) =>
        r.requirement_id === u.requirementId && r.supplier_id === u.supplierId && SEG_bool(r.active, true));
      if (!req) throw new Error('That document is no longer on this supplier’s checklist. Refresh the page and try again.');
      const type = M1_indexBy(M1_loadMasterData().docTypes, 'docTypeId')[req.doc_type_id];
      if (!type) throw new Error('Document type ' + req.doc_type_id + ' is not in the DocumentTypes tab.');

      const docs = readTable(SEG.TABS.DOCUMENTS);
      const duplicate = docs.find((d) => d.file_hash === hash);
      if (duplicate) {
        throw new Error('This exact file was already uploaded as ' + duplicate.doc_id + ' (' + (duplicate.original_file_name || duplicate.file_name) +
          ', supplier ' + duplicate.supplier_id + '). You don’t need to upload it again.');
      }
      const forReq = docs.filter((d) => d.requirement_id === req.requirement_id);
      const active = forReq.filter((d) => d.lifecycle_status === SEG.LIFECYCLE.ACTIVE);
      const version = forReq.reduce((max, d) => Math.max(max, Number(d.version) || 0), 0) + 1;
      const docId = SEG_newId('DOC', docs.map((d) => d.doc_id), 3);

      const folder = M1_ensureSupplierFolder(supplier.supplier_id, supplier);
      const driveName = docId + '_' + type.docTypeId + '_v' + version + '.' + ext;
      const file = M1_documentFolder(folder, type.documentClass, false).createFile(Utilities.newBlob(bytes, mime, driveName));
      file.setDescription(SEG.APP_NAME + ' | ' + supplier.supplier_id + ' ' + supplier.supplier_name + ' | ' + type.name +
        ' | version ' + version + ' | original file: ' + String(u.fileName || ''));
      const now = SEG_now();
      appendRows(SEG.TABS.DOCUMENTS, [{
        doc_id: docId,
        supplier_id: supplier.supplier_id,
        requirement_id: req.requirement_id,
        doc_type_id: type.docTypeId,
        document_class: type.documentClass,
        version: version,
        lifecycle_status: SEG.LIFECYCLE.ACTIVE,
        replaces_doc_id: active.length ? active[active.length - 1].doc_id : '',
        replaced_by_doc_id: '',
        file_id: file.getId(),
        file_name: driveName,
        original_file_name: String(u.fileName || '').slice(0, 200),
        mime_type: mime,
        file_size: bytes.length,
        file_hash: hash,
        file_url: file.getUrl(),
        uploaded_at: now,
        uploaded_by: user,
        extraction_requested_at: now
      }]);
      active.forEach((old) => {
        updateRow(SEG.TABS.DOCUMENTS, old._row, { lifecycle_status: SEG.LIFECYCLE.SUPERSEDED, replaced_by_doc_id: docId });
        try {
          DriveApp.getFileById(old.file_id).moveTo(M1_documentFolder(folder, old.document_class || type.documentClass, true));
        } catch (err) {
          console.warn('Could not move ' + old.doc_id + ' into "' + M1_DRIVE_FOLDERS.OLD_VERSIONS + '": ' + err.message);
        }
      });
      updateRow(SEG.TABS.SUPPLIERS, supplier._row, { updated_at: now });
      return {
        docId: docId, version: version, replaced: active.map((d) => d.doc_id), supplierId: supplier.supplier_id,
        submitted: !!supplier.submitted_at, typeName: type.name, fileUrl: file.getUrl()
      };
    });
  } catch (err) {
    SEG_audit({
      module: 'M1', action: 'UPLOAD_REJECTED', recordType: 'REQUIREMENT', recordId: u.requirementId, supplierId: u.supplierId,
      outcome: 'REJECTED', reason: err.message, details: { fileName: u.fileName || '' }
    });
    throw err;
  }

  const extraction = SEG_requestExtraction(result.docId);
  SEG_audit({
    module: 'M1', action: result.replaced.length ? 'DOCUMENT_REPLACED' : 'DOCUMENT_UPLOADED', recordType: 'DOCUMENT',
    recordId: result.docId, supplierId: result.supplierId, outcome: 'OK',
    reason: result.typeName + ' version ' + result.version + (result.replaced.length ? ' replaces ' + result.replaced.join(', ') : '') +
      '. AI extraction ' + extraction.toLowerCase() + '.',
    details: { fileName: u.fileName || '', extraction: extraction }
  });
  if (result.submitted) M1_refreshRegistrationStatus(result.supplierId);
  return { docId: result.docId, version: result.version, replaced: result.replaced, fileUrl: result.fileUrl, extraction: extraction };
}

/* ---------------------------------------------- Deactivate and reactivate */

/**
 * Stops AlphaTrack looking after a supplier, for example when the contract has ended.
 * Nothing is deleted: the supplier, its checklist, every document version and the audit
 * trail stay. Its Drive folder moves into "Deactivated suppliers" so the main folder only
 * shows suppliers that are monitored. Members 2-4 skip deactivated suppliers.
 */
function M1_deactivateSupplier(supplierId, reason) {
  const why = String(reason === undefined || reason === null ? '' : reason).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (why.length < 5) throw new Error('Please give a reason of at least 5 characters, for example "Contract ended on 31 Oct 2026".');
  const user = SEG_currentUser();
  const done = SEG_withLock(() => {
    const row = M1_findSupplierRow(supplierId);
    if (M1_isDeactivated(row)) throw new Error(row.supplier_name + ' (' + row.supplier_id + ') is already deactivated.');
    const now = SEG_now();
    updateRow(SEG.TABS.SUPPLIERS, row._row, {
      account_status: SEG.ACCOUNT_STATUS.DEACTIVATED, deactivated_at: now, deactivated_by: user, deactivation_reason: why, updated_at: now
    });
    return { name: row.supplier_name, folder: M1_fileSupplierFolder(row, true) };
  });
  SEG_audit({
    module: 'M1', action: 'SUPPLIER_DEACTIVATED', recordType: 'SUPPLIER', recordId: supplierId, supplierId: supplierId,
    outcome: SEG.ACCOUNT_STATUS.DEACTIVATED, reason: why, details: { driveFolder: done.folder }
  });
  return M1_getSupplierDetail(supplierId);
}

/** Puts a deactivated supplier back under monitoring. */
function M1_reactivateSupplier(supplierId) {
  const done = SEG_withLock(() => {
    const row = M1_findSupplierRow(supplierId);
    if (!M1_isDeactivated(row)) throw new Error(row.supplier_name + ' (' + row.supplier_id + ') is not deactivated.');
    const was = 'It was deactivated on ' + (row.deactivated_at || 'an unknown date') + ' by ' + (row.deactivated_by || 'unknown') +
      ': ' + (row.deactivation_reason || 'no reason given') + '.';
    updateRow(SEG.TABS.SUPPLIERS, row._row, {
      account_status: SEG.ACCOUNT_STATUS.ACTIVE, deactivated_at: '', deactivated_by: '', deactivation_reason: '', updated_at: SEG_now()
    });
    return { was: was, submitted: !!row.submitted_at, folder: M1_fileSupplierFolder(row, false) };
  });
  SEG_audit({
    module: 'M1', action: 'SUPPLIER_REACTIVATED', recordType: 'SUPPLIER', recordId: supplierId, supplierId: supplierId,
    outcome: SEG.ACCOUNT_STATUS.ACTIVE, reason: 'Monitoring resumed. ' + done.was, details: { driveFolder: done.folder }
  });
  if (done.submitted) M1_refreshRegistrationStatus(supplierId);
  return M1_getSupplierDetail(supplierId);
}

function M1_isDeactivated(row) {
  return String((row && row.account_status) || '').toUpperCase() === SEG.ACCOUNT_STATUS.DEACTIVATED;
}

function M1_assertNotDeactivated(row) {
  if (M1_isDeactivated(row)) {
    throw new Error(row.supplier_name + ' (' + row.supplier_id + ') is deactivated, so it can’t be changed. Reactivate it first.');
  }
}

/**
 * Moves a supplier's Drive folder between the main folder and "Deactivated suppliers".
 * Only moves it from where the app put it, so a folder someone filed elsewhere is left alone.
 * Never throws: the status change matters more than the folder, and the result is logged.
 */
function M1_fileSupplierFolder(row, deactivated) {
  if (!row.drive_folder_id) return 'No Drive folder yet.';
  try {
    const folder = DriveApp.getFolderById(row.drive_folder_id);
    const root = SEG_rootFolder();
    const archive = M1_childFolder(root, M1_DRIVE_FOLDERS.DEACTIVATED);
    const from = deactivated ? root : archive;
    const to = deactivated ? archive : root;
    const parents = folder.getParents();
    let isInFrom = false;
    while (parents.hasNext()) {
      if (parents.next().getId() === from.getId()) isInFrom = true;
    }
    if (!isInFrom) return 'Left where it is: it is not in "' + (deactivated ? SEG.ROOT_FOLDER_NAME : M1_DRIVE_FOLDERS.DEACTIVATED) + '".';
    folder.moveTo(to);
    return deactivated ? 'Moved into "' + M1_DRIVE_FOLDERS.DEACTIVATED + '".' : 'Moved back into "' + SEG.ROOT_FOLDER_NAME + '".';
  } catch (err) {
    console.warn('Could not move the Drive folder of ' + row.supplier_id + ': ' + err.message);
    return 'Not moved: ' + err.message;
  }
}

/* ------------------------------------------------- Hand-off to other modules */

/**
 * True when Members 2-4 should look after this supplier: registration submitted and not deactivated.
 * Pass a supplier ID or a row from the Suppliers tab.
 */
function M1_isMonitored(supplierOrId) {
  const row = typeof supplierOrId === 'object' && supplierOrId ? supplierOrId : M1_findSupplierRow(supplierOrId);
  return !!row.submitted_at && !M1_isDeactivated(row);
}

/** Every supplier Members 3 and 4 should check, in the shared contract's shape. */
function M1_getMonitoredSuppliers() {
  return readTable(SEG.TABS.SUPPLIERS)
    .filter((s) => s.supplier_id && M1_isMonitored(s))
    .map((s) => M1_getSupplier(s.supplier_id, s));
}

/** Supplier, in the shared contract's shape. */
function M1_getSupplier(supplierId, knownRow) {
  const s = knownRow || M1_findSupplierRow(supplierId);
  return {
    supplierId: s.supplier_id,
    supplierName: s.supplier_name,
    categoryId: s.category_id,
    registrationNo: s.registration_no,
    goodsServices: s.goods_services,
    contactPerson: s.contact_person,
    contactEmail: s.contact_email,
    internalOfficer: s.internal_officer,
    criticality: s.criticality,
    procurementStatus: s.procurement_status,
    registrationStatus: s.registration_status,
    accountStatus: M1_isDeactivated(s) ? SEG.ACCOUNT_STATUS.DEACTIVATED : SEG.ACCOUNT_STATUS.ACTIVE,
    monitored: M1_isMonitored(s)
  };
}

/** Active requirements of one supplier. Member 3 uses this to detect MISSING documents. */
function M1_getSupplierRequirements(supplierId) {
  const types = M1_indexBy(M1_loadMasterData().docTypes, 'docTypeId');
  return M1_requirementViews(
    readTable(SEG.TABS.SUPPLIER_REQS).filter((r) => r.supplier_id === supplierId && SEG_bool(r.active, true)), types)
    .map((r) => Object.assign({ supplierId: supplierId }, r));
}

/** Every document version (optionally for one supplier), in the shared contract's shape. */
function M1_getDocuments(supplierId) {
  return readTable(SEG.TABS.DOCUMENTS)
    .filter((d) => !supplierId || d.supplier_id === supplierId)
    .map(M1_documentContract);
}

/**
 * Member 2's work queue: current (ACTIVE) documents whose extraction was requested
 * and that have no successful Extractions row for this exact file yet. Documents of
 * deactivated suppliers are left out; they come back if the supplier is reactivated.
 */
function M1_getDocumentsAwaitingExtraction() {
  const extractions = M1_readExtractions();
  const deactivated = {};
  readTable(SEG.TABS.SUPPLIERS).forEach((s) => { if (M1_isDeactivated(s)) deactivated[s.supplier_id] = true; });
  return readTable(SEG.TABS.DOCUMENTS)
    .filter((d) => d.lifecycle_status === SEG.LIFECYCLE.ACTIVE && d.extraction_requested_at && !deactivated[d.supplier_id])
    .filter((d) => !extractions.some((x) =>
      x.doc_id === d.doc_id && (!x.file_id || x.file_id === d.file_id) && SEG.EXTRACTION_OK.indexOf(x.processing_status) >= 0))
    .map(M1_documentContract);
}

function M1_documentContract(d) {
  return {
    docId: d.doc_id,
    supplierId: d.supplier_id,
    requirementId: d.requirement_id,
    documentType: d.doc_type_id,
    documentClass: d.document_class,
    fileId: d.file_id,
    fileName: d.file_name,
    mimeType: d.mime_type,
    version: Number(d.version) || 1,
    lifecycleStatus: d.lifecycle_status,
    replacesDocId: d.replaces_doc_id,
    replacedByDocId: d.replaced_by_doc_id,
    uploadedAt: d.uploaded_at,
    fileUrl: d.file_url
  };
}

/* -------------------------------------------------------------- Internals */

function M1_findSupplierRow(supplierId) {
  const row = readTable(SEG.TABS.SUPPLIERS).find((s) => s.supplier_id === String(supplierId || ''));
  if (!row) throw new Error('Supplier ' + supplierId + ' was not found.');
  return row;
}

function M1_infoToRow(info) {
  return {
    supplier_name: info.supplierName,
    registration_no: info.registrationNo,
    category_id: info.categoryId,
    goods_services: info.goodsServices,
    contact_person: info.contactPerson,
    contact_email: info.contactEmail,
    internal_officer: info.internalOfficer,
    criticality: info.criticality,
    procurement_ref: info.procurementRef
  };
}

function M1_rowToInfo(row) {
  return {
    supplierName: row.supplier_name || '',
    registrationNo: row.registration_no || '',
    categoryId: row.category_id || '',
    goodsServices: row.goods_services || '',
    contactPerson: row.contact_person || '',
    contactEmail: row.contact_email || '',
    internalOfficer: row.internal_officer || '',
    criticality: row.criticality || '',
    procurementRef: row.procurement_ref || ''
  };
}

function M1_requirementViews(rows, types) {
  return rows.map((r) => {
    const t = types[r.doc_type_id] || { name: r.doc_type_id, documentClass: '', hasExpiry: true, defaultReminderDays: 30 };
    const label = String(r.label || '');
    return {
      requirementId: r.requirement_id,
      docTypeId: r.doc_type_id,
      docTypeName: t.name,
      name: t.name + (label ? ' (' + label + ')' : ''),
      documentClass: t.documentClass,
      hasExpiry: t.hasExpiry,
      label: label,
      mandatory: SEG_bool(r.mandatory, false),
      reminderDays: Number(r.reminder_days) || t.defaultReminderDays,
      reviewDate: r.review_date || '',
      source: r.source || ''
    };
  });
}

/**
 * Upserts a supplier's checklist. Rows not in the list are switched off
 * (active = FALSE), never deleted, so document history stays linked.
 * Must be called inside SEG_withLock.
 */
function M1_writeRequirements(supplierId, requirements) {
  const rows = readTable(SEG.TABS.SUPPLIER_REQS);
  const mine = rows.filter((r) => r.supplier_id === supplierId && SEG_bool(r.active, true));
  const ids = rows.map((r) => r.requirement_id);
  const now = SEG_now();
  const keep = {};
  const newRows = [];
  let updated = 0;
  requirements.forEach((req) => {
    const existing = req.requirementId ? mine.find((r) => r.requirement_id === req.requirementId) : null;
    const values = {
      doc_type_id: req.docTypeId,
      label: req.label,
      mandatory: req.mandatory,
      reminder_days: req.reminderDays,
      review_date: req.reviewDate,
      updated_at: now
    };
    if (existing) {
      updateRow(SEG.TABS.SUPPLIER_REQS, existing._row, values);
      keep[existing.requirement_id] = true;
      updated++;
    } else {
      const id = SEG_newId('REQ', ids, 4);
      ids.push(id);
      keep[id] = true;
      newRows.push(Object.assign({ requirement_id: id, supplier_id: supplierId, source: req.source, active: true }, values));
    }
  });
  appendRows(SEG.TABS.SUPPLIER_REQS, newRows);
  const removed = mine.filter((r) => !keep[r.requirement_id]);
  removed.forEach((r) => updateRow(SEG.TABS.SUPPLIER_REQS, r._row, { active: false, updated_at: now }));
  return { added: newRows.length, updated: updated, removed: removed.length };
}

/**
 * Returns the supplier's Drive folder, creating "SUP001 - Name" in the root folder
 * (with its three document-class folders) if needed.
 */
function M1_ensureSupplierFolder(supplierId, knownRow) {
  const row = knownRow || M1_findSupplierRow(supplierId);
  if (row.drive_folder_id) {
    return SEG_openFolder(row.drive_folder_id, 'The Drive folder for ' + supplierId,
      'drive_folder_id for ' + supplierId + ' in the Suppliers tab', supplierId);
  }
  const name = (supplierId + ' - ' + String(row.supplier_name || '')).replace(/[\\/:*?"<>|]/g, ' ').trim();
  const folder = SEG_rootFolder().createFolder(name);
  [SEG.DOC_CLASS.CONTRACT, SEG.DOC_CLASS.LICENCE, SEG.DOC_CLASS.CERTIFICATE].forEach((cls) => {
    folder.createFolder(M1_DRIVE_FOLDERS[cls]);
  });
  updateRow(SEG.TABS.SUPPLIERS, row._row, { drive_folder_id: folder.getId() });
  row.drive_folder_id = folder.getId();
  return folder;
}

/**
 * The folder a document of this class is filed in, e.g. "3. Certificates & Insurance",
 * or its "Old versions" sub-folder. Missing folders are created.
 */
function M1_documentFolder(supplierFolder, documentClass, oldVersion) {
  const classFolder = M1_childFolder(supplierFolder, M1_DRIVE_FOLDERS[documentClass] || M1_DRIVE_FOLDERS.CERTIFICATE);
  return oldVersion ? M1_childFolder(classFolder, M1_DRIVE_FOLDERS.OLD_VERSIONS) : classFolder;
}

/** Finds a sub-folder by name, skipping (or, if it's the only one, restoring) any copy in the Drive bin. */
function M1_childFolder(parent, name) {
  const found = parent.getFoldersByName(name);
  let binned = null;
  while (found.hasNext()) {
    const folder = found.next();
    if (!folder.isTrashed()) return folder;
    binned = binned || folder;
  }
  if (binned) {
    binned.setTrashed(false);
    return binned;
  }
  return parent.createFolder(name);
}

/** Member 2's tab may not have rows yet; treat any problem as "nothing extracted". */
function M1_readExtractions() {
  try {
    return readTable(SEG.TABS.EXTRACTIONS);
  } catch (err) {
    return [];
  }
}

function M1_docView(d, extractions) {
  const mine = extractions.filter((x) => x.doc_id === d.doc_id && (!x.file_id || x.file_id === d.file_id));
  const latest = mine.length ? mine[mine.length - 1] : null;
  return {
    docId: d.doc_id,
    version: Number(d.version) || 1,
    lifecycleStatus: d.lifecycle_status,
    fileName: d.file_name,
    originalFileName: d.original_file_name,
    fileUrl: d.file_url,
    fileSize: Number(d.file_size) || 0,
    mimeType: d.mime_type,
    uploadedAt: d.uploaded_at,
    uploadedBy: d.uploaded_by,
    replacesDocId: d.replaces_doc_id,
    replacedByDocId: d.replaced_by_doc_id,
    extractionStatus: latest ? latest.processing_status : (d.extraction_requested_at ? 'QUEUED' : 'NOT_REQUESTED')
  };
}

function M1_hash(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map((b) => ((b & 0xff) + 0x100).toString(16).slice(1))
    .join('');
}

function M1_indexBy(list, key) {
  const out = {};
  list.forEach((item) => { out[item[key]] = item; });
  return out;
}

/* ------------------------------------------------------------------ Tests */

/** No Google services needed: checklist defaults, validation, file checks, registration status. */
function test_M1_rules() {
  const master = M1_defaultMaster();
  return SEG_test('test_M1_rules', (expect) => {
    const cleaning = M1_suggestedChecklist('CLEANING', master);
    expect('Cleaning suggests 3 documents', cleaning.length === 3, cleaning.map((r) => r.docTypeId).join(', '));
    expect('Cleaning includes the Business Registration Record', cleaning.some((r) => r.docTypeId === 'BUSINESS_REGISTRATION_RECORD'));
    expect('Contracts default to a 60-day reminder', cleaning.find((r) => r.docTypeId === 'CLEANING_SERVICE_AGREEMENT').reminderDays === 60);
    expect('Insurance defaults to a 30-day reminder', cleaning.find((r) => r.docTypeId === 'INSURANCE_CERTIFICATE').reminderDays === 30);
    const parts = M1_suggestedChecklist('ELECTRONIC_COMPONENTS', master);
    expect('ISO 9001 is optional for Electronic Components', parts.some((r) => r.docTypeId === 'ISO_9001_CERTIFICATE' && !r.mandatory));
    expect('Every category has a checklist', master.categories.every((c) => M1_suggestedChecklist(c.categoryId, master).length > 0));

    expect('A draft needs only the name', M1_validateInfo({ supplierName: 'BrightClean Sdn. Bhd.' }, 'draft', master, [], '').ok);
    const submit = M1_validateInfo({ supplierName: 'BrightClean Sdn. Bhd.' }, 'submit', master, [], '');
    expect('Submitting needs registration no., category, email, officer and criticality',
      !submit.ok && Object.keys(submit.errors).length === 5, Object.keys(submit.errors).join(', '));
    const bad = M1_validateInfo({ supplierName: 'X Co', contactEmail: 'not-an-email', criticality: 'urgent' }, 'draft', master, [], '');
    expect('A bad email is caught', !!bad.errors.contactEmail);
    expect('An unknown criticality is caught', !!bad.errors.criticality);
    const existing = [{ supplier_id: 'SUP001', supplier_name: 'BrightClean Sdn. Bhd.', registration_no: 'SIM-REG-001' }];
    const dup = M1_validateInfo({ supplierName: 'Other Co', registrationNo: 'sim reg 001' }, 'draft', master, existing, '');
    expect('A duplicate registration number is caught', !!dup.errors.registrationNo, dup.errors.registrationNo);
    expect('Editing a supplier does not clash with itself',
      M1_validateInfo({ supplierName: 'BrightClean', registrationNo: 'SIM-REG-001' }, 'draft', master, existing, 'SUP001').ok);
    expect('Criticality is upper-cased', M1_validateInfo({ supplierName: 'AB', criticality: 'high' }, 'draft', master, [], '').info.criticality === 'HIGH');

    const reqs = M1_normaliseRequirements([
      { docTypeId: 'INSURANCE_CERTIFICATE', mandatory: true, reminderDays: '' },
      { docTypeId: 'BUSINESS_REGISTRATION_RECORD', mandatory: true, reviewDate: '2027-01-31' },
      { docTypeId: 'INSURANCE_CERTIFICATE', mandatory: false, reminderDays: 45, reviewDate: '2027-01-31', label: 'Public liability' }
    ], master);
    expect('A blank reminder uses the document type default', reqs[0].reminderDays === 30);
    expect('A review date is kept for a document with no expiry', reqs[1].reviewDate === '2027-01-31');
    expect('A review date is ignored for a document that expires', reqs[2].reviewDate === '');
    expect('The same document type can appear twice with a label', reqs[2].label === 'Public liability');
    let threw = false;
    try { M1_normaliseRequirements([{ docTypeId: 'INSURANCE_CERTIFICATE', reminderDays: 0 }], master); } catch (e) { threw = true; }
    expect('A 0-day reminder is rejected', threw);
    threw = false;
    try { M1_normaliseRequirements([{ docTypeId: 'MADE_UP' }], master); } catch (e) { threw = true; }
    expect('An unknown document type is rejected', threw);

    expect('A real PDF is accepted', M1_contentMatchesType([37, 80, 68, 70, 45], 'application/pdf'));
    expect('A PNG renamed to .pdf is rejected', !M1_contentMatchesType([-119, 80, 78, 71], 'application/pdf'));
    expect('A real PNG is accepted', M1_contentMatchesType([-119, 80, 78, 71], 'image/png'));
    expect('A real JPEG is accepted', M1_contentMatchesType([-1, -40, -1, -32], 'image/jpeg'));

    const R = [
      { requirementId: 'REQ0001', mandatory: true, name: 'Agreement' },
      { requirementId: 'REQ0002', mandatory: true, name: 'Insurance' },
      { requirementId: 'REQ0003', mandatory: false, name: 'ISO' }
    ];
    const doc = (id, req, status) => ({ doc_id: id, requirement_id: req, lifecycle_status: status || 'ACTIVE', file_id: 'F' + id });
    const both = [doc('DOC001', 'REQ0001'), doc('DOC002', 'REQ0002')];
    expect('Not submitted -> DRAFT', M1_assessRegistration(false, R, both, []).status === 'DRAFT');
    expect('A mandatory document missing -> PENDING_DOCUMENTS', M1_assessRegistration(true, R, [doc('DOC001', 'REQ0001')], []).status === 'PENDING_DOCUMENTS');
    expect('A superseded version does not count',
      M1_assessRegistration(true, R, [doc('DOC001', 'REQ0001'), doc('DOC002', 'REQ0002', 'SUPERSEDED')], []).status === 'PENDING_DOCUMENTS');
    expect('Missing optional documents do not block -> PENDING_VERIFICATION', M1_assessRegistration(true, R, both, []).status === 'PENDING_VERIFICATION');
    const read = [{ doc_id: 'DOC001', file_id: 'FDOC001', processing_status: 'EXTRACTED' }, { doc_id: 'DOC002', file_id: 'FDOC002', processing_status: 'EXTRACTED' }];
    expect('Every mandatory document read by AI -> ACTIVE_MONITORING', M1_assessRegistration(true, R, both, read).status === 'ACTIVE_MONITORING');
    expect('A failed extraction keeps PENDING_VERIFICATION',
      M1_assessRegistration(true, R, both, [read[0], { doc_id: 'DOC002', file_id: 'FDOC002', processing_status: 'EXTRACTION_FAILED' }]).status === 'PENDING_VERIFICATION');
    expect('An extraction of an older file does not count',
      M1_assessRegistration(true, R, both, [read[0], { doc_id: 'DOC002', file_id: 'OLD', processing_status: 'EXTRACTED' }]).status === 'PENDING_VERIFICATION');
    expect('The next supplier ID follows the highest one', nextId('SUP', ['SUP001', 'SUP009'], 3) === 'SUP010');
  });
}

/**
 * Uses the real Sheet and Drive. Registers a TEST supplier, uploads, rejects a
 * duplicate, renews a document and checks the extraction queue. Run
 * M1_removeTestSuppliers() afterwards to clean up.
 */
function test_M1_endToEnd() {
  SEG_setupDatabase();
  const stamp = String(new Date().getTime());
  const pdf = (n) => Utilities.base64Encode(Utilities.newBlob(
    '%PDF-1.4\n% SIMULATED DOCUMENT - FOR HACKATHON TESTING ONLY ' + stamp + ' #' + n + '\n%%EOF', 'application/pdf').getBytes());
  return SEG_test('test_M1_endToEnd', (expect) => {
    const master = M1_loadMasterData();
    expect('Master data is in the Sheet', master.categories.length >= 5 && master.docTypes.length >= 10,
      master.categories.length + ' categories, ' + master.docTypes.length + ' document types');

    let detail = M1_saveSupplierDraft({
      info: {
        supplierName: 'TEST BrightClean Sdn. Bhd.', registrationNo: 'TEST-' + stamp, categoryId: 'CLEANING',
        goodsServices: 'Factory cleaning', contactPerson: 'Test Contact', contactEmail: 'team+brightclean@example.com',
        internalOfficer: 'Procurement Officer', criticality: 'MEDIUM', procurementRef: 'PR-TEST'
      },
      requirements: M1_getCategoryChecklist('CLEANING')
    });
    const id = detail.supplier.supplierId;
    expect('Draft saved with a supplier ID', /^SUP\d{3,}$/.test(id), id);
    expect('Status is DRAFT', detail.supplier.registrationStatus === 'DRAFT', detail.supplier.registrationStatus);
    expect('3 requirements saved', detail.requirements.length === 3, detail.requirements.length);
    expect('A Drive folder was created', !!detail.supplier.driveFolderUrl);

    const reqId = (type) => detail.requirements.find((r) => r.docTypeId === type).requirementId;
    const send = (type, n, name) => M1_uploadDocument({ supplierId: id, requirementId: reqId(type), fileName: name, mimeType: 'application/pdf', base64: pdf(n) });

    const first = send('CLEANING_SERVICE_AGREEMENT', 1, 'agreement.pdf');
    expect('The first upload is version 1', first.version === 1, first.version);
    let dupMessage = '';
    try { send('CLEANING_SERVICE_AGREEMENT', 1, 'agreement-again.pdf'); } catch (e) { dupMessage = e.message; }
    expect('Uploading the same file twice is refused', /already uploaded/.test(dupMessage), dupMessage);

    detail = M1_registerSupplier(id);
    expect('Registered with documents missing -> PENDING_DOCUMENTS', detail.supplier.registrationStatus === 'PENDING_DOCUMENTS', detail.supplier.registrationStatus);

    send('INSURANCE_CERTIFICATE', 2, 'insurance-2025.pdf');
    send('BUSINESS_REGISTRATION_RECORD', 3, 'business-registration.pdf');
    detail = M1_getSupplierDetail(id);
    expect('All mandatory documents uploaded -> PENDING_VERIFICATION', detail.supplier.registrationStatus === 'PENDING_VERIFICATION', detail.supplier.registrationStatus);

    const renewal = send('INSURANCE_CERTIFICATE', 4, 'insurance-2026.pdf');
    expect('A renewal becomes version 2', renewal.version === 2, renewal.version);
    expect('The renewal replaces the old version', renewal.replaced.length === 1, renewal.replaced.join(', '));
    detail = M1_getSupplierDetail(id);
    const insurance = detail.requirements.find((r) => r.docTypeId === 'INSURANCE_CERTIFICATE');
    expect('The old insurance stays in history as SUPERSEDED',
      insurance.history.length === 2 && insurance.history[1].lifecycleStatus === 'SUPERSEDED');
    expect('The current insurance is the new version', insurance.current && insurance.current.docId === renewal.docId);

    const parentOf = (fileId) => { const p = DriveApp.getFileById(fileId).getParents(); return p.hasNext() ? p.next().getName() : ''; };
    const filed = M1_getDocuments(id);
    const fileOf = (pred) => filed.find(pred).fileId;
    const agreementFolder = parentOf(fileOf((d) => d.documentType === 'CLEANING_SERVICE_AGREEMENT'));
    const recordFolder = parentOf(fileOf((d) => d.documentType === 'BUSINESS_REGISTRATION_RECORD'));
    const newFolder = parentOf(fileOf((d) => d.docId === renewal.docId));
    const oldFolder = parentOf(fileOf((d) => d.docId === renewal.replaced[0]));
    expect('The agreement is filed in "' + M1_DRIVE_FOLDERS.CONTRACT + '"', agreementFolder === M1_DRIVE_FOLDERS.CONTRACT, agreementFolder);
    expect('The registration record is filed in "' + M1_DRIVE_FOLDERS.LICENCE + '"', recordFolder === M1_DRIVE_FOLDERS.LICENCE, recordFolder);
    expect('The renewed insurance is filed in "' + M1_DRIVE_FOLDERS.CERTIFICATE + '"', newFolder === M1_DRIVE_FOLDERS.CERTIFICATE, newFolder);
    expect('The replaced insurance moved to "' + M1_DRIVE_FOLDERS.OLD_VERSIONS + '"', oldFolder === M1_DRIVE_FOLDERS.OLD_VERSIONS, oldFolder);

    const queue = M1_getDocumentsAwaitingExtraction().filter((d) => d.supplierId === id);
    expect('3 current documents wait for AI extraction (not the superseded one)', queue.length === 3, queue.map((d) => d.docId).join(', '));
    expect('Every queued document points at a Drive file', queue.every((d) => !!d.fileId));
    expect('Hand-off shape has a document class', queue.every((d) => !!d.documentClass));

    const actions = detail.activity.map((a) => a.action);
    expect('The audit log has the registration, upload, renewal and rejected duplicate',
      ['SUPPLIER_REGISTERED', 'DOCUMENT_UPLOADED', 'DOCUMENT_REPLACED', 'UPLOAD_REJECTED'].every((a) => actions.indexOf(a) >= 0), actions.join(', '));
    console.log('Left test supplier ' + id + ' in place so you can look at it. Run M1_removeTestSuppliers() to remove every TEST supplier.');
  });
}

/**
 * Removes suppliers created by tests (name starts with "TEST " and registration
 * number starts with "TEST-"), with their rows in every Member 1 tab and the
 * audit log. Their Drive folders go to the Drive bin, so they can be restored.
 * Run it by hand from the editor; nothing calls it automatically.
 */
/**
 * ONE CLICK in the Apps Script editor: runs both Member 1 test suites on the real Sheet and
 * Drive, then removes the TEST supplier again. The last log line says ALL PASSED, or the run
 * stops with the FAIL lines above it.
 */
function M1_runAllTests() {
  let failure = null;
  try {
    test_M1_rules();
    test_M1_endToEnd();
  } catch (err) {
    failure = err;
  } finally {
    M1_removeTestSuppliers();
  }
  if (failure) throw failure;
  console.log('ALL PASSED: Member 1 works on the real Google Sheet and Drive. The TEST supplier has been removed again.');
  return 'ALL PASSED';
}

function M1_removeTestSuppliers() {
  return M1_removeSuppliersForTesting((s) => /^TEST /.test(String(s.supplier_name)) && /^TEST-/.test(String(s.registration_no)), 'TEST');
}

/**
 * TESTING ONLY, run by hand from the editor: removes the matching suppliers' rows (supplier,
 * checklist, documents, audit) and moves their Drive folders to the bin. The live app never
 * deletes anything.
 */
function M1_removeSuppliersForTesting(matches, label, fresh) {
  const ids = readTable(SEG.TABS.SUPPLIERS).filter(matches);
  if (!ids.length) {
    console.log('No ' + label + ' suppliers found.');
    return 0;
  }
  const idSet = {};
  ids.forEach((s) => {
    idSet[s.supplier_id] = true;
    if (s.drive_folder_id) {
      try { DriveApp.getFolderById(s.drive_folder_id).setTrashed(true); } catch (err) { console.warn(err.message); }
    }
  });
  // Every tab with a supplier_id column, except the answer key (its rows are fixed test data).
  const removed = {};
  SEG_withLock(() => {
    Object.keys(SEG.HEADERS).filter((tab) => tab !== SEG.TABS.GROUND_TRUTH && SEG.HEADERS[tab].indexOf('supplier_id') >= 0).forEach((tab) => {
      removed[tab] = SEG_removeRows(tab, (r) => !!idSet[r.supplier_id]);
    });
    // Nothing refers to these IDs any more, so the numbers can be handed out again.
    const column = (tab, key) => readTable(tab).map((r) => r[key]);
    SEG_releaseIds('SUP', Object.keys(idSet), column(SEG.TABS.SUPPLIERS, 'supplier_id'), fresh);
    SEG_releaseIds('DOC', (removed[SEG.TABS.DOCUMENTS] || []).map((r) => r.doc_id), column(SEG.TABS.DOCUMENTS, 'doc_id'), fresh);
    SEG_releaseIds('REQ', (removed[SEG.TABS.SUPPLIER_REQS] || []).map((r) => r.requirement_id), column(SEG.TABS.SUPPLIER_REQS, 'requirement_id'), fresh);
  });
  console.log('Removed ' + label + ' suppliers: ' + Object.keys(idSet).join(', '));
  return ids.length;
}
