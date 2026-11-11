# AlphaTrack

*Stay ahead of every supplier expiry.*

AlphaTrack (project name: Silent Expiry Guardian) is AI-powered supplier contract and compliance monitoring for **Alpha Electronics Sdn. Bhd.** (a fictional Malaysian electronics manufacturer). Built for the APU Cloud Innovation Hackathon, Intelligent Automation & Digital Transformation track.

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
| Overview, integration and scheduling | Member 5 | Shared database, page shell and Overview dashboard built; scheduling not started |

## What's in this repository

| Folder | What it holds |
|---|---|
| [`app/`](app/) | The Apps Script web app: every `.gs` and `.html` file to paste into Apps Script. Setup steps are in [app/README.md](app/README.md). |
| [`test-pdfs/`](test-pdfs/) | **Every fake PDF, in one place.** `1. Suppliers already in AlphaTrack` has one folder per company (loaded automatically). `2. Video demo - BrightClean` holds the PDFs you upload yourself in the demo video, plus step-by-step notes. See [test-pdfs/README.md](test-pdfs/README.md). |
| [`dataset/`](dataset/) | How the test data is made: the generator script and the GroundTruth answer key (what each PDF really says). See [dataset/README.md](dataset/README.md). |
| [`handoff/`](handoff/) | Briefs for teammates. [Member 2: AI extraction](handoff/MEMBER-2-AI-EXTRACTION.md). |
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

The app creates and fills this folder itself. Nobody needs to add files to it by hand.

```
AlphaTrack - Supplier Documents/
  SUP001 - Kilat Shine Services Sdn. Bhd./
    1. Contracts & Agreements/
    2. Licences & Permits/
    3. Certificates & Insurance/
      Old versions/          <- replaced files move here; nothing is deleted
  SUP002 - …/
  Deactivated suppliers/     <- folders of deactivated suppliers; they move back if reactivated
```

The `test-pdfs` folder you upload for the import is separate: it is only the source of the test files.

## Still to write for the submission
- Problem statement
- Solution and research
- Impact and outcome, with measured results
- Teamwork and timeline
- Architecture diagram
