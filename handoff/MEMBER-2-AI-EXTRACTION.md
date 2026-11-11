# Member 2 brief: AI Document Extraction & Verification

**From:** Member 5 (team lead) · **Spec:** section 7 · **Prototype due:** 13 Nov 2026, 12:00 noon MYT

You build the part where Gemini reads each uploaded PDF and pulls out the important fields. Everything before that already works:
- registering suppliers;
- uploading their PDFs to Google Drive;
- recording each file in the Sheet;
- queuing it for you.

Nobody uploads a PDF twice. You get the Drive file ID and read the file yourself.

## 1. Get access (the team lead does this once)

1. The team lead shares two things with you as **Editor**:
   - the Google Sheet **AlphaTrack - Database**;
   - the Drive folder **AlphaTrack - Supplier Documents**.
2. Open the Sheet, then **Extensions → Apps Script**. This is the shared project, and every member's files live in it.
3. Only edit **your own files** (below). If you need a change in `00_Config.gs` or `01_Database.gs`, ask Member 5. When two people save the same file, the last save wins.
4. To try the app as yourself, use **Deploy → Test deployments** and open the **Web app** URL. It runs your latest saved code under your own account.

## 2. Your files

Create these in the Apps Script project. Use the `M2_` prefix for every function, so nothing clashes with other members' code.

| File | What goes in it |
|---|---|
| `M2_Extraction.gs` | Gemini call, prompts per document class, validation, writing results |
| `M2_Page.html` | The **AI Document Analysis** page (spec 7.2, feature 5) |
| `M2_Client.html` | The page's browser code |

To show your page instead of the placeholder:
1. Add `<?!= include('M2_Page'); ?>` inside `<section id="page-ai">` in `Index.html`.
2. Add `<?!= include('M2_Client'); ?>` **after** `OverviewClient` at the bottom.
3. Call `App.registerPage('ai', { show() { ... } })` in your client. It replaces the placeholder.

Ask Member 5 before you edit `Index.html`, because it is a shared file.

Name your main function **`M2_extractDocument(docId)`**. The Overview page checks for that name: when it exists, the AI module shows as **Connected**.

### Updating the live app safely

`clasp push` **replaces the whole Apps Script project** with the files on your computer, so it can wipe out files you don't have yet:
1. Always `git pull` first, so you have everyone's latest files.
2. Then run `clasp push`.
3. Then `git push` your commit.

Tell Member 5 when you've pushed. If you only edit in the browser editor, don't use `clasp push` at all.

## 3. Your input: the work queue

```js
const queue = M1_getDocumentsAwaitingExtraction();
// [{ docId: 'DOC004', supplierId: 'SUP002', requirementId: 'REQ0007',
//    documentType: 'SECURITY_SERVICE_AGREEMENT', documentClass: 'CONTRACT',   // CONTRACT | LICENCE | CERTIFICATE
//    fileId: '1AbC…', fileName: 'DOC004_SECURITY_SERVICE_AGREEMENT_v1.pdf', mimeType: 'application/pdf',
//    version: 1, lifecycleStatus: 'ACTIVE', uploadedAt: '2026-11-11T15:31:00+08:00', fileUrl: 'https://drive.google.com/…' }]
```

What the queue contains:
- only the **current** version of each document (a replaced version is not included);
- only documents with no successful extraction for that exact `fileId` yet;
- **no** documents of deactivated suppliers.

Supplier details for the name check:

```js
const supplier = M1_getSupplier(item.supplierId);   // supplierName, registrationNo, categoryId, contactEmail, …
```

Read the file:

```js
const blob = DriveApp.getFileById(item.fileId).getBlob();
const base64 = Utilities.base64Encode(blob.getBytes());
```

The PDF goes to Gemini as an inline part: `{ inlineData: { mimeType: 'application/pdf', data: base64 } }`. Add the instruction text as a second part. Ask for JSON (`generationConfig.responseMimeType: 'application/json'`).

Use a Gemini model that your API key can access; check the current model list at https://ai.google.dev before you choose.

## 4. The API key

- Put it in **Project Settings → Script properties** as `GEMINI_API_KEY`.
- Read it with `PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')`.
- **Never** put it in code, in a chat or on GitHub.
- Send it in the `x-goog-api-key` header of `UrlFetchApp.fetch`, not in the URL.

## 5. Your output: the `Extractions` tab (you are its only writer)

Columns, defined in `00_Config.gs`:

`doc_id, supplier_id, document_class, file_id, processing_status, extracted_json, issues, extracted_at, model, corrected_by, corrected_at`

How to write it:
- Write one row per extraction with `appendRows(SEG.TABS.EXTRACTIONS, [{ … }])`.
- Change a row with `updateRow(...)`.
- Use `SEG_now()` for timestamps.
- Use `SEG_audit({ module: 'M2', action: 'EXTRACTION_DONE', … })` for the audit trail. Log corrections there too (spec: "Corrections should be logged").

Rules that keep the other modules working:

1. **`file_id` must be the exact Drive file ID you read.** Member 1 counts a document as read only when that tab has a row with the same `doc_id` and `file_id`, and `processing_status` is `EXTRACTED` or `CORRECTED`.
2. `processing_status` values:
   - `EXTRACTED`: Gemini read it.
   - `CORRECTED`: an officer fixed the fields.
   - Anything else, such as `NEEDS_REVIEW` or `FAILED`, means "not done".
3. `extracted_json` holds a JSON string with the fields for that class only (spec 7.2, feature 2). Don't force contracts into certificate fields. Dates use `YYYY-MM-DD`.
4. `issues` lists codes separated by commas: `NAME_MISMATCH, MISSING_EXPIRY, MISSING_CONTRACT_END_DATE, UNREADABLE, CONFLICTING_DATES, INVALID_DATE, EXTRACTION_FAILED`. A contract with no end date may be open-ended, so record it as missing, not as a defect.
5. **After a successful row, call `M1_refreshRegistrationStatus(item.supplierId)`.** When every mandatory document has been read, that moves the supplier from *Pending verification* to *Active monitoring*.
6. **Cache** (spec 7.2, feature 6): before calling Gemini, check whether an `EXTRACTED`/`CORRECTED` row already exists for this `doc_id` + `file_id`. If it does, skip the call. You may add columns, such as `file_version`, at the **end** of your tab.
7. Need a supplier's status yourself? `M1_isMonitored(supplierId)` is false for drafts and deactivated suppliers.

## 6. How it gets triggered

After every upload, `SEG_requestExtraction()` runs.
- When Member 5's `M5_processExtractionQueue()` exists, it is scheduled to run a minute later and calls your `M2_extractDocument` for each queued item.
- Until then, run `M2_extractDocument('DOC004')` from the editor, or loop over the queue in a test function.
- Apps Script stops any single run after **6 minutes**. Process a few documents per run.

## 7. Test data and the answer key

- After the dataset import, the database has 7 suppliers and 17 PDFs to read. The PDFs are in the project's `test-pdfs` folder; see `test-pdfs/README.md`.
- The **GroundTruth** tab (also `dataset/GroundTruth.csv`) lists what each PDF really says and which issues you should find. Use it to **measure your accuracy**. Your live code must never read it.
- Cases you must handle, and where to find them:

| Case | PDF | Expected issue |
|---|---|---|
| Wrong company name | `Voltline_Contractor_Registration.pdf` | `NAME_MISMATCH` |
| No expiry printed | `Voltline_Electrical_Competency_Certificate.pdf` | `MISSING_EXPIRY` |
| Two different expiry dates | `SwiftHaul_Insurance_Certificate.pdf` | `CONFLICTING_DATES` |
| Blurry, unreadable scan | `Cahaya_Insurance_Certificate_scan.pdf` | `UNREADABLE` |
| Contract with no fixed end date | `Voltline_Electrical_Maintenance_Agreement.pdf` | none: open-ended is allowed, not a defect |
| Contract that renews automatically | `KilatShine_Cleaning_Service_Agreement.pdf` | none: record `auto_renewal: YES` |

`dataset/README.md` has the full list, with the expected status and issues for every file.

## 8. Done means

- Running `M2_extractDocument` on all 17 imported documents writes 17 `Extractions` rows.
- The issues match GroundTruth: report your score, for example "15 of 17 correct".
- Suppliers whose mandatory documents are all read move to *Active monitoring* by themselves.
- The AI Document Analysis page shows, for each document:
  - the PDF link;
  - the extracted fields;
  - the issues and the status;
  - an officer **Correct** action that saves `CORRECTED` and logs who changed what.
- API errors, such as a quota or a bad JSON reply, end as a `FAILED` row with the reason. Nothing crashes, and nothing is lost.
