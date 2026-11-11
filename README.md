# Silent Expiry Guardian

AI-powered supplier contract and compliance monitoring for **Alpha Electronics Sdn. Bhd.** (a fictional Malaysian electronics manufacturer). Built for the APU Cloud Innovation Hackathon, Intelligent Automation & Digital Transformation track.

The system registers suppliers that Procurement has already approved, stores their contracts, licences and certificates, and is designed to:
- read the documents with Gemini;
- warn before anything expires;
- prepare renewal emails for a person to approve.

It is one Google Apps Script web app with Google Sheets as the database, Google Drive for the documents and Gmail for notifications.

## Status

| Module | Owner | State |
|---|---|---|
| Supplier Registration & Document Management | Member 1 | **Built and tested offline** |
| AI Document Extraction & Verification | Member 2 | Not started |
| Expiry & Risk Analysis | Member 3 | Not started |
| Notifications & Renewals | Member 4 | Not started |
| Overview, integration and scheduling | Member 5 | Shared database and page shell done; Overview page not started |

## What's in this repository

| Folder | What it holds |
|---|---|
| [`app/`](app/) | The Apps Script web app: every `.gs` and `.html` file to paste into Apps Script. Setup steps are in [app/README.md](app/README.md). |
| [`dataset/`](dataset/) | The fictional test dataset: 8 suppliers, 20 simulated PDFs covering the 14 test situations, and the GroundTruth answer key. See [dataset/README.md](dataset/README.md). |
| [`dev/`](dev/) | Development-only tools: offline tests and a local preview. They are not part of the app. |

## Try it without a Google account

```bash
node dev/run-tests.js
```

```bash
node dev/build-preview.js
```

- `run-tests.js` runs every Member 1 test against in-memory stand-ins for Sheets and Drive.
- `build-preview.js` builds `dev/preview.html`. Open it in Chrome or Edge to click through the real pages with the test dataset loaded. Nothing is sent to Google.

## How Google Drive is organised

```
Silent Expiry Guardian - Supplier Documents/
  SUP001 - BrightClean Sdn. Bhd./
    1. Contracts & Agreements/
    2. Licences & Permits/
    3. Certificates & Insurance/
      Old versions/        <- replaced files move here; nothing is deleted
```

## Still to write for the submission
- Problem statement
- Solution and research
- Impact and outcome, with measured results
- Teamwork and timeline
- Architecture diagram
