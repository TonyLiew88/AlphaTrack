# Member 4 Brief: Automated Notifications & Renewal Management

**Module:** Automated Notifications & Renewal Management  
**Owner:** Member 4  
**Status:** Completed & Tested Offline (`12 of 12 checks passed`)  
**Handoff to:** Member 5 (Main Dashboard, System Integration & Automation)

---

## 1. What Member 4 Does

Member 4 connects risk assessments from Member 3 into automated, accountable actions:
1. **Renewal Cases Tracker (`RenewalCases` tab)**:
   - Opens cases for expiring certificates, ending contracts, overdue documents, missing files, and review items.
   - Automatically escalates overdue or critical cases (`status = 'ESCALATED'`).
   - Resolves cases when updated replacement documents are verified.
2. **Gmail Reminders & Escalations (`Notifications` tab)**:
   - Stages: `FIRST_REMINDER` (advance), `FOLLOW_UP` (due soon), `URGENT_ESCALATION` (overdue/expired), `SUBMISSION_REQUEST` (missing), and `REVIEW_ALERT` (internal).
   - Generates responsive HTML corporate email bodies for **Alpha Electronics Sdn. Bhd.**.
3. **Human-in-the-Loop Approval Workflow**:
   - Every external email to suppliers is generated as `PENDING_APPROVAL`.
   - Officers can preview the email body, approve, reject, or bulk approve drafts.
   - Dispatches via `GmailApp.sendEmail` upon approval.
4. **Duplicate Prevention**:
   - Prevents duplicate reminders if a stage is already active or in cooldown (7 days).
5. **Interactive Dashboard**:
   - Top KPI tiles, dual-view switcher (Notification Queue vs. Renewal Cases Tracker), and email preview modal.

---

## 2. Shared Data Contract

### A. Notifications Tab (`SEG.HEADERS.Notifications`):
`notification_id, case_id, supplier_id, doc_id, stage, notification_type, recipient, subject, approval_status, delivery_status, created_at, approved_by, approved_at, sent_at, follow_up_due`

### B. RenewalCases Tab (`SEG.HEADERS.RenewalCases`):
`case_id, supplier_id, requirement_id, doc_id, case_type, status, opened_at, resolved_at, resolution`

---

## 3. Integration with Member 5 (Integration & Scheduling)

In Member 5's daily monitoring job (`M5_dailyMonitoringJob()`):
```javascript
// Step 3 of daily monitoring:
const notifSummary = M4_prepareNotifications();
// Returns { actionableItems, casesOpened, casesUpdated, notificationsPrepared, pendingApproval }
```

