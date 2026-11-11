# Member 3 Brief: Expiry Detection & Risk Analysis

**Module:** Expiry Detection & Risk Analysis  
**Owner:** Member 3  
**Status:** Completed & Tested Offline (`13 of 13 checks passed`)  
**Handoff to:** Member 4 (Notifications & Renewals) & Member 5 (Integration & Scheduling)

---

## 1. What Member 3 Does

Member 3 automates compliance intelligence between AI extraction and automated notifications:
1. **Reads extracted fields** from Member 2's `Extractions` (via `M2_latestReading(docId, fileId)`).
2. **Calculates days remaining** (`dueDate - referenceDate`) with timezone-safe UTC calendar date math.
3. **Classifies compliance status**:
   - Contracts: `ACTIVE`, `ENDING_SOON`, `ENDED`, `NO_FIXED_END_DATE`
   - Licences & Certificates: `VALID`, `EXPIRING_SOON`, `EXPIRED`
   - Issues / Defective scans: `NEEDS_REVIEW`
   - Unfulfilled mandatory checklist items: `MISSING`
4. **Calculates multi-factor compliance risk** (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`) based on supplier criticality (`HIGH`, `MEDIUM`, `LOW`), mandatory status, urgency, and issue flags.
5. **Generates human-readable explanations** (`reason`) and prescriptive next steps (`recommended_action`).
6. **Computes supplier compliance risk scorecards** (0–100 score and tier: `CRITICAL`, `HIGH`, `MODERATE`, `LOW`).
7. **Writes to the shared database**: Writes all assessments to `Assessments` tab and records execution in `AuditLog`.
8. **Provides interactive UI**: Visual dashboard under the **Expiry & Risk** sidebar tab (`page-risk`), including KPI filters, countdown badges, supplier scorecards, compliance dossiers, and configurable reminder thresholds.

---

## 2. Files Created & Modified

| File | Purpose |
|---|---|
| [`app/M3_Risk.gs`](../app/M3_Risk.gs) | Backend assessment engine, date math, risk rules, threshold management, query APIs, and self-tests |
| [`app/M3_Page.html`](../app/M3_Page.html) | HTML structure and scoped CSS (`.m3-`) for the Expiry & Risk Analysis page |
| [`app/M3_Client.html`](../app/M3_Client.html) | Client-side controller registered as `App.registerPage('risk', ...)` |
| [`app/Index.html`](../app/Index.html) | Includes `M3_Page` in `section#page-risk` and `M3_Client` at the bottom |
| [`dev/run-m3-tests.js`](../dev/run-m3-tests.js) | Complete offline automated test runner against simulated Google services and `GroundTruth.csv` |

---

## 3. Data Contract: `Assessments` Tab

Member 3 is the primary writer of the `Assessments` tab (`SEG.TABS.ASSESSMENTS`).

### Tab Columns (`SEG.HEADERS.Assessments`):
`assessment_id, doc_id, requirement_id, supplier_id, assessment_type, due_date, days_remaining, status, risk_level, reason, recommended_action, assessed_at`

| Column | Type | Example | Description |
|---|---|---|---|
| `assessment_id` | String | `'ASM001'` | Unique identifier generated with `SEG_newId('ASM', ...)` |
| `doc_id` | String | `'DOC002'` | Document ID (empty if requirement is missing) |
| `requirement_id` | String | `'REQ0001'` | Supplier requirement ID |
| `supplier_id` | String | `'SUP001'` | Supplier ID |
| `assessment_type` | String | `'DOCUMENT'` or `'REQUIREMENT'` | Evaluated target type |
| `due_date` | String | `'2026-11-20'` | ISO date `YYYY-MM-DD` (or empty if none) |
| `days_remaining` | Number/String | `'9'`, `'-27'` | Calendar days remaining relative to reference date |
| `status` | String | `'EXPIRING_SOON'` | Compliance status code (see below) |
| `risk_level` | String | `'HIGH'` | Compliance risk level (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`) |
| `reason` | String | `'Certificate expires in 9 days on 2026-11-20.'` | Plain human-readable explanation |
| `recommended_action` | String | `'Issue renewal reminder to supplier.'` | Actionable recommendation for Member 4 |
| `assessed_at` | String | `'2026-11-11T21:55:00+08:00'` | Timestamp of assessment |

---

## 4. Status Codes & Risk Matrix

### Compliance Statuses (`M3.STATUS`)
- `VALID` / `ACTIVE`: Valid certificate/licence or active contract with days remaining exceeding the reminder threshold.
- `EXPIRING_SOON` / `ENDING_SOON`: Valid document expiring or contract ending within the advance reminder window (default: 30 days for certificates/licences, 60 days for contracts).
- `EXPIRED` / `ENDED`: Due date has already passed (`days_remaining < 0`).
- `NO_FIXED_END_DATE`: Valid contract with no expiry date (open-ended).
- `NEEDS_REVIEW`: Document flagged by Member 2 with an extraction issue (`NAME_MISMATCH`, `MISSING_EXPIRY`, `CONFLICTING_DATES`, `UNREADABLE`, etc.) and not yet corrected.
- `MISSING`: Mandatory requirement with no active document uploaded.

### Multi-Factor Risk Calculation (`M3_calculateRiskLevel`)
| Compliance Status | Days Left | Supplier Criticality | Mandatory? | Risk Level |
|---|---|---|---|---|
| `EXPIRED` / `ENDED` | &lt; 0 | `HIGH` | Yes | **CRITICAL** |
| `EXPIRED` / `ENDED` | &lt; 0 | `MEDIUM` | Yes | **HIGH** |
| `EXPIRED` / `ENDED` | &lt; 0 | `LOW` | Any | **MEDIUM** |
| `MISSING` | — | `HIGH` | Yes | **CRITICAL** |
| `MISSING` | — | `MEDIUM` | Yes | **HIGH** |
| `MISSING` | — | `LOW` | Yes | **MEDIUM** |
| `NEEDS_REVIEW` | Any | `HIGH` | Any | **HIGH** |
| `NEEDS_REVIEW` | Any | `MEDIUM` / `LOW` | Any | **MEDIUM** |
| `EXPIRING_SOON` / `ENDING_SOON` | &le; 14 days | `HIGH` | Any | **HIGH** |
| `EXPIRING_SOON` / `ENDING_SOON` | &le; 14 days | `MEDIUM` / `LOW` | Any | **MEDIUM** |
| `EXPIRING_SOON` / `ENDING_SOON` | &gt; 14 days | `HIGH` | Any | **HIGH** |
| `EXPIRING_SOON` / `ENDING_SOON` | &gt; 14 days | `MEDIUM` | Any | **MEDIUM** |
| `EXPIRING_SOON` / `ENDING_SOON` | &gt; 14 days | `LOW` | Any | **LOW** |
| `VALID` / `ACTIVE` / `NO_FIXED_END_DATE` | &gt; threshold | Any | Any | **LOW** |

---

## 5. Instructions for Teammates

### For Member 4 (Notifications & Renewals)
Member 4 builds the Gmail reminder and escalation workflows. You can query Member 3's output directly using:
```javascript
// 1. Get enriched assessments ready for reminders:
const allAssessments = M3_getAssessments();

// 2. Filter for items needing reminders or escalation:
const expiringSoon = allAssessments.filter(a => a.status === 'EXPIRING_SOON' || a.status === 'ENDING_SOON');
const overdueCases = allAssessments.filter(a => a.status === 'EXPIRED' || a.status === 'ENDED' || a.status === 'MISSING');
const criticalAlerts = allAssessments.filter(a => a.riskLevel === 'CRITICAL');

// Each assessment object provides:
// - a.supplierName, a.supplierId, a.contactPerson, a.contactEmail, a.internalOfficer
// - a.docTypeName, a.documentClass, a.dueDate, a.daysRemaining
// - a.status, a.riskLevel, a.reason, a.recommendedAction
```

### For Member 5 (Overview, Integration & Automation)
1. In `02_App.gs`, `modules.assessment = typeof M3_assessDocuments === 'function'` automatically evaluates to `true`, displaying **Connected** on the Overview dashboard.
2. In scheduled daily monitoring:
   ```javascript
   function M5_dailyMonitoringJob() {
     // 1. Process any pending AI extractions
     M2_processQueue(20);
     
     // 2. Run daily expiry & risk assessments
     M3_assessDocuments();
     
     // 3. Prepare notifications based on assessments
     M4_prepareNotifications();
   }
   ```

---

## 6. How to Run the Tests

Run offline in your local environment:
```bash
node dev/run-m3-tests.js
```
All 13 integration test steps run in ~3 seconds and verify 100% agreement with `GroundTruth.csv` across all 14 project scenarios.

