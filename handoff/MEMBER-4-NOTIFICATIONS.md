# Member 4 Brief: Automated Notifications & Renewal Management

**Module:** Automated Notifications & Renewal Management  
**Owner:** Member 4  
**Status:** Built, tested offline (`node dev/run-m4-tests.js`: 25 of 25 steps; `test_M4_rules`: 20 checks) and tested in the real app with Gmail on 12 Nov 2026 (see section 6).  
**Input from:** Member 3 (`M3_getAssessments()`)  
**Handoff to:** Member 5 (daily monitoring job)

---

## 1. What Member 4 does

Member 4 turns Member 3's risk results into renewal cases and emails, and follows each case until it closes.

For every document Member 3 rates `EXPIRING_SOON`, `ENDING_SOON`, `EXPIRED`, `ENDED`, `MISSING` or `NEEDS_REVIEW`, there is one open **renewal case** (`RenewalCases` tab) and one email chain (`Notifications` tab):

| Step | Email | To | When | Approval |
|---|---|---|---|---|
| 1 | `FIRST_REMINDER`, or `URGENT_ESCALATION` if already expired/ended, or `SUBMISSION_REQUEST` if missing | Supplier | The case opens | Officer must approve |
| 2 | `FOLLOW_UP` | Supplier | 7 days after the last supplier email was **sent** with no replacement, or once the due date is 14 days away or less (only after the first email was sent) | Officer must approve |
| 3 | `INTERNAL_ESCALATION` | Responsible person at Alpha Electronics | At once if the document has expired or ended, or the risk is `CRITICAL`; otherwise 7 days after the follow-up was sent with still no replacement. The case becomes `ESCALATED`. | Sent automatically (internal) |
| – | `REVIEW_ALERT` | Responsible person | `NEEDS_REVIEW` documents; no supplier email | Sent automatically (internal) |

**Who is the responsible person:** the supplier's *internal officer* if that field holds an email address, otherwise the `COMPLIANCE_MANAGER_EMAIL` script property, otherwise the account the app runs as.

**Closing a case.** When Member 3 next rates the document `VALID` or `ACTIVE` (for example after a renewed PDF is uploaded and read), the case closes as `RESOLVED`. An officer can also close it by hand. Either way, emails still waiting for approval on that case are cancelled so they can't be sent by mistake. If the same document becomes a problem again later, a new case opens.

**Duplicate prevention.** Each case gets each kind of email at most once, so the job can run any number of times a day. A rejected email counts too: it is not drafted again the next morning.

**Delivery status.** An email is marked `SENT` only after Gmail accepts it. If Gmail fails or the address is invalid, it is marked `FAILED`. The 7-day clock (`follow_up_due`) starts when a supplier email is actually sent, not when it is drafted.

Every escalation, closure, approval, rejection and cancellation is written to `AuditLog`.

---

## 2. Shared data contract

No new tabs or columns.

### A. Notifications tab (`SEG.HEADERS.Notifications`)
`notification_id, case_id, supplier_id, doc_id, stage, notification_type, recipient, subject, approval_status, delivery_status, created_at, approved_by, approved_at, sent_at, follow_up_due`

- `stage`: `FIRST_REMINDER`, `FOLLOW_UP`, `URGENT_ESCALATION`, `SUBMISSION_REQUEST`, `REVIEW_ALERT`, `INTERNAL_ESCALATION`
- `notification_type`: `EMAIL_EXTERNAL` (supplier) or `EMAIL_INTERNAL`
- `approval_status`: `PENDING_APPROVAL`, `APPROVED`, `REJECTED` (also used for cancelled drafts), `AUTO_APPROVED`
- `delivery_status`: `DRAFT`, `QUEUED`, `SENT`, `FAILED`, `CANCELLED`
- For escalations, the reason is in the `subject`.

### B. RenewalCases tab (`SEG.HEADERS.RenewalCases`)
`case_id, supplier_id, requirement_id, doc_id, case_type, status, opened_at, resolved_at, resolution`

- `status`: `OPEN`, `ESCALATED`, `RESOLVED`

---

## 3. Integration with Member 5

Member 5's daily job calls:
```javascript
const summary = M4_prepareNotifications();
// { actionableItems, casesOpened, casesUpdated, casesResolved, notificationsPrepared,
//   pendingApproval, followUpsPrepared, escalations, internalSent, internalFailed }
```
The first five fields are the same as before, so Member 5's code needs no change.

---

## 4. Setup in Apps Script

1. Make sure the project has `M3_Risk`, `M4_Notifications`, `M5_Integration`, `M3_Page`, `M3_Client`, `M4_Page`, `M4_Client`.
2. Optional: add the script property `COMPLIANCE_MANAGER_EMAIL`.
3. Before approving any email, change the test suppliers' contact emails to an inbox you own. Approving really sends.
4. Run `test_M4_rules`, then `M4_prepareNotifications`, and allow Gmail access when asked.

## 5. What changed from the first version, and why

The first version (commit 807e53d) had every screen and function, but a review against the proposal found these problems:

| Problem in the first version | What happened | Fix |
|---|---|---|
| Follow-ups were not real follow-ups | A `follow_up_due` date was saved but never read, so a supplier who ignored the first reminder was never chased. A "follow-up" only went out when the due date got close. | A follow-up is drafted when the last supplier email was **sent** 7+ days ago and no replacement has arrived. The 7-day clock starts when the email is sent, not when it is drafted. |
| Escalation went to the supplier only | An expired document produced an urgent email to the supplier; nobody inside Alpha Electronics was told. | New `INTERNAL_ESCALATION` email to the responsible person: at once for expired/ended/CRITICAL, or 7 days after an unanswered follow-up. The case becomes `ESCALATED`. |
| Wrong delivery status | Emails were marked `SENT` even when Gmail was not available; internal alerts stayed `QUEUED` forever even after sending. | `SENT` only after Gmail accepts the email, otherwise `FAILED`. Internal emails are sent after their rows are saved, so their status is updated. |
| Internal alerts addressed to a name | `internal_officer` holds a name ("Farid Hassan (Procurement)"), not an email, so review alerts could never be delivered. | Recipient rule: officer's email if there is one, else `COMPLIANCE_MANAGER_EMAIL`, else the account the app runs as. |
| Wrong supplier names | Email subjects said "(Supplier)" and the cases list said "Unknown Supplier" (field name mismatch). | Reads `supplier_name` correctly. |
| Rejected emails came back | A rejected draft was drafted again on the next run. | A rejected email counts as handled for that case. |
| Drafts could be sent after a case closed | When a case was resolved, its pending drafts stayed approvable. | Closing a case (automatically or by hand) cancels its pending drafts; cancelled emails cannot be approved. |
| Thin testing | The brief said 12 checks passed; `test_M4_rules` had 6, and none covered duplicates, follow-ups, escalation or approval. | `test_M4_rules` now has 20 checks, plus 25 offline end-to-end steps in `dev/run-m4-tests.js` with a fake Gmail. |

## 6. Real Google test results (12 Nov 2026)

Tested by Member 4 in the team's shared app, through the Test deployment (`/dev`) link.

| Test | How | Result |
|---|---|---|
| Approval → Gmail | Test emails addressed to Member 4's own inbox were added to the Notifications tab as `PENDING_APPROVAL`, then approved on the Notifications & Renewals page | ✅ Emails received in Gmail; rows changed to `SENT` |
| Renewal closes the case | Uploaded `BrightClean_Insurance_Certificate_2026-2027_RENEWAL.pdf` as a renewed version for BrightClean (SUP009), read it on AI Document Analysis, then pressed **Prepare Reminders** | ✅ The case closed automatically as `RESOLVED` with the note "Document renewed and verified compliant on …" |
| Pending drafts cancelled | A first reminder for that case was left pending before the renewal | ✅ Cancelled automatically (`REJECTED` / `CANCELLED`, by `SYSTEM`) |
| Anything else unexpected | – | None found |

### Setup lessons (read before testing)

- **Tick "Select all" on Google's permission screen.** Google lets you grant permissions one by one. If Gmail or Drive is left unticked, approving fails with "The script does not have permission…" and uploads fail with "The Drive folder … can't be opened", even with Editor access. Fix: myaccount.google.com/connections → the AlphaTrack project → **Delete all connections**, run any function from the editor again, and choose **Select all**.
- **Use the Test deployment link (`/dev`) to test as yourself.** A `/exec` link runs as whoever deployed it, with their permissions.
- **Before approving anything, check the recipient.** Approving really sends. Some supplier contact emails in the shared Sheet are real people's addresses.
- **To test approval safely**, paste rows into the Notifications tab with your own email as `recipient`, `case_id` = `TEST`, IDs starting with `TEST`, `approval_status` = `PENDING_APPROVAL` and `delivery_status` = `DRAFT`. The automatic job ignores `TEST` cases. Delete the rows afterwards.
- **"Resolve Case" by hand is not a renewal.** If the document is still expiring, the next run opens a new case for it. Only an uploaded and verified replacement closes a case for good.

### For Member 5

- **Uploads are not processed automatically yet.** `SEG_requestExtraction()` schedules `M5_processExtractionQueue`, but that function does not exist. Until it does, after an upload someone must press **Read waiting documents** (AI Document Analysis) and then **Prepare Reminders** (Notifications & Renewals), or wait for the daily job if its trigger is installed.
- **The folder error hides the real cause.** `SEG_openFolder()` in `01_Database.gs` replaces every Drive error with "can't be opened… ask its owner to share it". During testing the real cause was a missing Drive permission. Adding `err.message` to that message would save other members the same confusion.

## 7. Still to do

- Measure Notification Accuracy on the test dataset (proposal section 7.2: percentage of reminders correctly triggered) and record the real numbers.
- Optional: make the **Resolve Case** box start empty and require a reason, so a case closed by hand can't look like a verified renewal (its default text is currently "Renewed certificate submitted and verified").
