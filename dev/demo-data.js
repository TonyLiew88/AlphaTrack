/**
 * demo-data.js · Development only. NOT deployed to Apps Script.
 * Registers three fictional suppliers through the real Member 1 functions so the
 * preview has something to show. Every PDF it makes is a tiny simulated document.
 */
function DEV_makePdf(lines) {
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = 'BT /F1 13 Tf 56 780 Td (' + esc(lines[0]) + ') Tj ' +
    lines.slice(1).map((l) => '0 -22 Td (' + esc(l) + ') Tj').join(' ') + ' ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((o, i) => { offsets.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n' +
    offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return Utilities.base64Encode(pdf);
}

function DEV_seedDemo() {
  if (readTable(SEG.TABS.SUPPLIERS).length) return 'already seeded';
  const doc = (title, company, extra) => DEV_makePdf([
    'SIMULATED DOCUMENT - FOR HACKATHON TESTING ONLY', '', title, 'Holder: ' + company].concat(extra || []));
  const upload = (detail, type, fileName, base64) => M1_uploadDocument({
    supplierId: detail.supplier.supplierId,
    requirementId: detail.requirements.find((r) => r.docTypeId === type).requirementId,
    fileName: fileName, mimeType: 'application/pdf', base64: base64
  });

  // 1. BrightClean: registered, insurance renewed, Business Registration Record still missing.
  let bright = M1_saveSupplierDraft({
    info: {
      supplierName: 'BrightClean Sdn. Bhd.', registrationNo: 'SIM-REG-001', categoryId: 'CLEANING',
      goodsServices: 'Factory and office cleaning', contactPerson: 'Aisyah Rahman (fictional)',
      contactEmail: 'yourteam+brightclean@gmail.com', internalOfficer: 'Procurement Officer',
      criticality: 'MEDIUM', procurementRef: 'PR-2025-014'
    },
    requirements: M1_getCategoryChecklist('CLEANING')
  });
  upload(bright, 'CLEANING_SERVICE_AGREEMENT', 'BrightClean_Cleaning_Service_Agreement_2026.pdf',
    doc('Cleaning Service Agreement', 'BrightClean Sdn. Bhd.', ['Contract start: 1 January 2026', 'Contract end: 31 December 2026']));
  upload(bright, 'INSURANCE_CERTIFICATE', 'BrightClean_Insurance_2024.pdf',
    doc('Insurance Certificate', 'BrightClean Sdn. Bhd.', ['Issue date: 20 November 2024', 'Expiry date: 20 November 2025']));
  M1_registerSupplier(bright.supplier.supplierId);
  upload(bright, 'INSURANCE_CERTIFICATE', 'BrightClean_Insurance_2025.pdf',
    doc('Insurance Certificate', 'BrightClean Sdn. Bhd.', ['Issue date: 20 November 2025', 'Expiry date: 20 November 2026']));

  // 2. SecureGuard: registered with every mandatory document, waiting for AI extraction.
  const secure = M1_saveSupplierDraft({
    info: {
      supplierName: 'SecureGuard Services Sdn. Bhd.', registrationNo: 'SIM-REG-002', categoryId: 'SECURITY',
      goodsServices: 'Site guarding, 24 hours', contactPerson: 'Kumar Selvam (fictional)',
      contactEmail: 'yourteam+secureguard@gmail.com', internalOfficer: 'Facilities Manager',
      criticality: 'HIGH', procurementRef: 'PR-2025-021'
    },
    requirements: M1_getCategoryChecklist('SECURITY')
  });
  upload(secure, 'SECURITY_SERVICE_AGREEMENT', 'SecureGuard_Agreement.pdf', doc('Security Service Agreement', 'SecureGuard Services Sdn. Bhd.'));
  upload(secure, 'SECURITY_AGENCY_LICENCE', 'SecureGuard_Licence.pdf', doc('Security Agency Licence', 'SecureGuard Services Sdn. Bhd.'));
  upload(secure, 'INSURANCE_CERTIFICATE', 'SecureGuard_Insurance.pdf', doc('Insurance Certificate', 'SecureGuard Services Sdn. Bhd.'));
  M1_registerSupplier(secure.supplier.supplierId);

  // 3. Voltline: a draft that stopped after the checklist step.
  M1_saveSupplierDraft({
    info: {
      supplierName: 'Voltline Electrical Engineering Sdn. Bhd.', registrationNo: 'SIM-REG-003', categoryId: 'ELECTRICAL',
      contactEmail: 'yourteam+voltline@gmail.com', internalOfficer: 'Plant Engineer', criticality: 'HIGH'
    },
    requirements: M1_getCategoryChecklist('ELECTRICAL')
  });
  return 'seeded';
}
