"""Builds the fictional Silent Expiry Guardian test dataset (project spec, section 14).

    python dataset/build_dataset.py

Writes:
  dataset/pdfs/*.pdf           20 simulated documents for 8 fictional suppliers
  dataset/GroundTruth.csv      what each document really says, and the expected status
  dataset/README.md            the guide (generated, so it always matches the data)
  app/M1_DemoDatasetData.gs    the same data for the Apps Script importer (M1_DemoDataset.gs)

Everything is fictional. Every page is stamped "SIMULATED DOCUMENT - FOR HACKATHON
TESTING ONLY". There are no real government seals, signatures or agency names.
Change the data below and run the script again; never edit the outputs by hand.
Needs Microsoft Edge (or Chrome) and Pillow.
"""
import csv
import json
import os
import subprocess
import sys
import tempfile
from datetime import date, timedelta
from html import escape
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PDF_DIR = ROOT / "dataset" / "pdfs"
REFERENCE_DATE = date(2026, 11, 11)          # the spec's monitoring date
STABLE_UNTIL = date(2026, 11, 19)            # every expected status holds from 11 to 19 Nov 2026
CLIENT = "Alpha Electronics Sdn. Bhd."
CLIENT_ADDRESS = "Lot 8, Jalan Simulasi 1, Kawasan Perindustrian Contoh, 81400 Senai, Johor"
STAMP = "SIMULATED DOCUMENT \u2014 FOR HACKATHON TESTING ONLY"

# Must match M1_DEFAULTS.docTypes in app/M1_Suppliers.gs: name, class, has expiry, reminder days.
DOC_TYPES = {
    "CLEANING_SERVICE_AGREEMENT": ("Cleaning Service Agreement", "CONTRACT", True, 60),
    "SECURITY_SERVICE_AGREEMENT": ("Security Service Agreement", "CONTRACT", True, 60),
    "ELECTRICAL_MAINTENANCE_AGREEMENT": ("Electrical Maintenance Agreement", "CONTRACT", True, 60),
    "SUPPLY_AGREEMENT": ("Supply Agreement", "CONTRACT", True, 60),
    "TRANSPORTATION_SERVICE_AGREEMENT": ("Transportation Service Agreement", "CONTRACT", True, 60),
    "SECURITY_AGENCY_LICENCE": ("Security Agency Licence", "LICENCE", True, 30),
    "CONTRACTOR_REGISTRATION": ("Contractor Registration", "LICENCE", True, 30),
    "OPERATING_PERMIT": ("Operating Permit", "LICENCE", True, 30),
    "BUSINESS_REGISTRATION_RECORD": ("Business Registration Record", "LICENCE", False, 30),
    "INSURANCE_CERTIFICATE": ("Insurance Certificate", "CERTIFICATE", True, 30),
    "ISO_9001_CERTIFICATE": ("ISO 9001 Certificate", "CERTIFICATE", True, 60),
    "ELECTRICAL_COMPETENCY_EVIDENCE": ("Electrical Competency Evidence", "CERTIFICATE", True, 30),
    "PRODUCT_CONFORMITY_DOCUMENTATION": ("Product Conformity Documentation", "CERTIFICATE", True, 30),
}

# ------------------------------------------------------------------ Suppliers
SUPPLIERS = [
    dict(key="brightclean", liveDemo=True, submit=True,
         address="No. 12, Jalan Simulasi 3, Taman Contoh, 81100 Johor Bahru, Johor",
         info=dict(supplierName="BrightClean Sdn. Bhd.", registrationNo="SIM-REG-101", categoryId="CLEANING",
                   goodsServices="Factory and office cleaning", contactPerson="Aisyah Rahman",
                   contactEmail="yourteam+brightclean@gmail.com", internalOfficer="Farid Hassan (Procurement)",
                   criticality="MEDIUM", procurementRef="PR-2025-014"),
         overrides=[]),
    dict(key="kilat", liveDemo=False, submit=True,
         address="No. 5, Jalan Contoh 7/2, Seksyen 7, 40000 Shah Alam, Selangor",
         info=dict(supplierName="Kilat Shine Services Sdn. Bhd.", registrationNo="SIM-REG-102", categoryId="CLEANING",
                   goodsServices="Warehouse and staff canteen cleaning", contactPerson="Tan Mei Ling",
                   contactEmail="yourteam+kilatshine@gmail.com", internalOfficer="Farid Hassan (Procurement)",
                   criticality="LOW", procurementRef="PR-2025-031"),
         overrides=[dict(docTypeId="BUSINESS_REGISTRATION_RECORD", reviewDate="2027-06-30")]),
    dict(key="perisai", liveDemo=False, submit=True,
         address="Level 3, Wisma Simulasi, Jalan Contoh 1, 80000 Johor Bahru, Johor",
         info=dict(supplierName="Perisai Guard Security Sdn. Bhd.", registrationNo="SIM-REG-103", categoryId="SECURITY",
                   goodsServices="24-hour site guarding at the Senai plant", contactPerson="Ravi Kumar",
                   contactEmail="yourteam+perisaiguard@gmail.com", internalOfficer="Lim Siew Hoon (Facilities)",
                   criticality="HIGH", procurementRef="PR-2025-009"),
         overrides=[]),
    dict(key="voltline", liveDemo=False, submit=True,
         address="No. 3, Jalan Industri Contoh 4, 81400 Senai, Johor",
         info=dict(supplierName="Voltline Electrical Engineering Sdn. Bhd.", registrationNo="SIM-REG-104", categoryId="ELECTRICAL",
                   goodsServices="Electrical maintenance of production lines", contactPerson="Muhammad Hafiz",
                   contactEmail="yourteam+voltline@gmail.com", internalOfficer="Lim Siew Hoon (Facilities)",
                   criticality="HIGH", procurementRef="PR-2025-022"),
         overrides=[]),
    dict(key="mutiara", liveDemo=False, submit=True,
         address="Plot 21, Lorong Perusahaan Contoh 2, 11900 Bayan Lepas, Pulau Pinang",
         info=dict(supplierName="Mutiara Components Sdn. Bhd.", registrationNo="SIM-REG-105", categoryId="ELECTRONIC_COMPONENTS",
                   goodsServices="Passive components (resistors and capacitors)", contactPerson="Chong Wei Jie",
                   contactEmail="yourteam+mutiara@gmail.com", internalOfficer="Nurul Huda (Purchasing)",
                   criticality="HIGH", procurementRef="PR-2025-040"),
         overrides=[dict(docTypeId="PRODUCT_CONFORMITY_DOCUMENTATION", mandatory=True)]),
    dict(key="swifthaul", liveDemo=False, submit=True,
         address="No. 9, Jalan Logistik Contoh 2, 81700 Pasir Gudang, Johor",
         info=dict(supplierName="Swift Haul Logistics Sdn. Bhd.", registrationNo="SIM-REG-106", categoryId="LOGISTICS",
                   goodsServices="Container haulage between the port and the Senai plant", contactPerson="Gopal Krishnan",
                   contactEmail="yourteam+swifthaul@gmail.com", internalOfficer="Nurul Huda (Purchasing)",
                   criticality="MEDIUM", procurementRef="PR-2024-118"),
         overrides=[]),
    dict(key="cahaya", liveDemo=False, submit=True,
         address="No. 40, Jalan Cahaya Contoh, 81300 Skudai, Johor",
         info=dict(supplierName="Cahaya Facility Services Sdn. Bhd.", registrationNo="SIM-REG-107", categoryId="CLEANING",
                   goodsServices="Cleaning of cleanroom gowning areas and corridors", contactPerson="Siti Nadia",
                   contactEmail="yourteam+cahaya@gmail.com", internalOfficer="Farid Hassan (Procurement)",
                   criticality="MEDIUM", procurementRef="PR-2026-003"),
         overrides=[dict(docTypeId="BUSINESS_REGISTRATION_RECORD", mandatory=False)]),
    dict(key="kencana", liveDemo=False, submit=False,
         address="No. 2, Jalan Teknologi Contoh, 47810 Petaling Jaya, Selangor",
         info=dict(supplierName="Kencana Microparts Sdn. Bhd.", registrationNo="SIM-REG-108", categoryId="ELECTRONIC_COMPONENTS",
                   goodsServices="Connectors and cable assemblies", contactPerson="Ong Kah Seng",
                   contactEmail="yourteam+kencana@gmail.com", internalOfficer="Nurul Huda (Purchasing)",
                   criticality="MEDIUM", procurementRef=""),
         overrides=[]),
]

PAYUNG = "Payung Insurance Berhad (simulated insurer)"
TEGUH = "Teguh Assurance Berhad (simulated insurer)"

# ------------------------------------------------------------------ Documents
# kind: contract | licence | insurance | certificate.  fmt: long | short | slash (how dates are printed)
DOCS = [
    dict(id="D01", supplier="brightclean", type="CLEANING_SERVICE_AGREEMENT", kind="contract",
         file="BrightClean_Cleaning_Service_Agreement_2026.pdf", number="AE-CSA-2026-014",
         start="2026-01-01", end="2026-12-31", notice=60, auto=False, fmt="long",
         services="Daily cleaning of the production floor, offices and washrooms", value="RM 186,000 per year",
         scenario="Contract ending within 60 days", issues=[]),
    dict(id="D02", supplier="brightclean", type="INSURANCE_CERTIFICATE", kind="insurance",
         file="BrightClean_Insurance_Certificate_2025-2026.pdf", number="PAY-PL-2025-55871", issuer=PAYUNG,
         scope="Public liability, limit RM 2,000,000 per occurrence", issue="2025-11-20", expiry="2026-11-20", fmt="slash",
         scenario="Insurance certificate expiring soon", issues=[]),
    dict(id="D03", supplier="brightclean", type="INSURANCE_CERTIFICATE", kind="insurance", uploadLater=True,
         file="BrightClean_Insurance_Certificate_2026-2027_RENEWAL.pdf", number="PAY-PL-2026-61204", issuer=PAYUNG,
         scope="Public liability, limit RM 2,000,000 per occurrence", issue="2026-11-10", expiry="2027-11-20", fmt="slash",
         scenario="Updated replacement certificate (upload it during the demo)", issues=[]),
    dict(id="D04", supplier="kilat", type="CLEANING_SERVICE_AGREEMENT", kind="contract",
         file="KilatShine_Cleaning_Service_Agreement.pdf", number="AE-CSA-2026-002",
         start="2026-02-01", end="2027-01-31", notice=30, auto=True, fmt="short",
         services="Weekly deep cleaning of the warehouse and staff canteen", value="RM 64,800 per year",
         scenario="Contract with an automatic renewal clause", issues=[]),
    dict(id="D05", supplier="kilat", type="INSURANCE_CERTIFICATE", kind="insurance",
         file="KilatShine_Insurance_Certificate.pdf", number="PAY-PL-2026-50116", issuer=PAYUNG,
         scope="Public liability, limit RM 1,000,000 per occurrence", issue="2026-03-01", expiry="2027-02-28", fmt="long",
         scenario="Valid insurance certificate", issues=[]),
    dict(id="D06", supplier="kilat", type="BUSINESS_REGISTRATION_RECORD", kind="certificate",
         file="KilatShine_Business_Registration_Record.pdf", number="BRR-SIM-102", issuer="Simulated Business Registry",
         title="BUSINESS REGISTRATION RECORD", number_label="Record No.", holder_label="Company name",
         issue_label="Date of registration", scope="Private limited company. Nature of business: cleaning services",
         issue="2018-05-14", expiry=None, no_expiry_text="This record has no expiry date.", fmt="long",
         scenario="Document with no expiry date (a review date is set instead)", issues=[]),
    dict(id="D07", supplier="perisai", type="SECURITY_SERVICE_AGREEMENT", kind="contract",
         file="PerisaiGuard_Security_Service_Agreement.pdf", number="AE-SSA-2026-001",
         start="2026-01-01", end="2027-12-31", notice=90, auto=False, fmt="long",
         services="24-hour guarding: 6 guards per shift, 3 shifts a day", value="RM 540,000 per year",
         scenario="Valid supplier contract", issues=[]),
    dict(id="D08", supplier="perisai", type="SECURITY_AGENCY_LICENCE", kind="licence",
         file="PerisaiGuard_Security_Agency_Licence.pdf", number="SAL-SIM-2025-0418", issuer="Simulated Security Licensing Office",
         title="SECURITY AGENCY LICENCE", scope="Guarding services, Johor", issue="2025-10-16", expiry="2026-10-15", fmt="slash",
         scenario="Expired licence", issues=[]),
    dict(id="D09", supplier="perisai", type="INSURANCE_CERTIFICATE", kind="insurance",
         file="PerisaiGuard_Insurance_Certificate.pdf", number="TAB-GL-2026-3307", issuer=TEGUH,
         scope="General liability and fidelity guarantee, limit RM 3,000,000", issue="2026-05-01", expiry="2027-04-30", fmt="short",
         scenario="Valid insurance certificate", issues=[]),
    dict(id="D10", supplier="voltline", type="ELECTRICAL_MAINTENANCE_AGREEMENT", kind="contract",
         file="Voltline_Electrical_Maintenance_Agreement.pdf", number="AE-EMA-2025-006",
         start="2025-04-01", end=None, notice=None, auto=None, fmt="long",
         services="Preventive and breakdown maintenance of production-line electrical systems", value="RM 18,500 per month",
         scenario="Contract with no fixed end date", issues=[]),
    dict(id="D11", supplier="voltline", type="CONTRACTOR_REGISTRATION", kind="licence",
         file="Voltline_Contractor_Registration.pdf", number="CRB-SIM-2026-7781", issuer="Simulated Contractor Registration Board",
         title="CONTRACTOR REGISTRATION CERTIFICATE", holder="Voltline Engineering Services Sdn. Bhd.",
         scope="Electrical installation works, grade B (simulated grading)", issue="2026-03-01", expiry="2027-02-28", fmt="long",
         scenario="Incorrect company name", issues=["NAME_MISMATCH"],
         note="The certificate says Voltline Engineering Services Sdn. Bhd.; the register says Voltline Electrical Engineering Sdn. Bhd. The registration number matches."),
    dict(id="D12", supplier="voltline", type="ELECTRICAL_COMPETENCY_EVIDENCE", kind="certificate",
         file="Voltline_Electrical_Competency_Certificate.pdf", number="ECB-SIM-55210", issuer="Simulated Electrical Competency Board",
         title="CERTIFICATE OF ELECTRICAL COMPETENCY", scope="Low-voltage wiring and maintenance, nominated technician: Mohd Azlan (fictional)",
         issue="2026-02-01", expiry=None, fmt="slash",
         scenario="Missing expiry information", issues=["MISSING_EXPIRY"],
         note="No expiry date is printed anywhere. The AI should leave it blank, not guess."),
    dict(id="D13", supplier="voltline", type="INSURANCE_CERTIFICATE", kind="insurance",
         file="Voltline_Insurance_Certificate.pdf", number="PAY-CAR-2026-40022", issuer=PAYUNG,
         scope="Contractor's all risks and third-party liability, limit RM 5,000,000", issue="2026-04-01", expiry="2027-03-31", fmt="long",
         scenario="Valid insurance certificate", issues=[]),
    dict(id="D14", supplier="mutiara", type="SUPPLY_AGREEMENT", kind="contract",
         file="Mutiara_Supply_Agreement.pdf", number="AE-SUP-2025-011",
         start="2025-07-01", end="2027-06-30", notice=90, auto=False, fmt="short",
         services="Supply of passive components against purchase orders", value="Framework agreement; prices per schedule",
         scenario="Valid supplier contract", issues=[]),
    dict(id="D15", supplier="mutiara", type="ISO_9001_CERTIFICATE", kind="certificate",
         file="Mutiara_ISO_9001_Certificate.pdf", number="QMS-SIM-24-0912", issuer="Simulated Certification Services Sdn. Bhd.",
         title="CERTIFICATE OF REGISTRATION: ISO 9001", scope="Quality management system for the manufacture of passive electronic components",
         issue="2024-09-01", expiry="2027-08-31", fmt="long",
         scenario="Valid certification", issues=[]),
    dict(id="D16", supplier="swifthaul", type="TRANSPORTATION_SERVICE_AGREEMENT", kind="contract",
         file="SwiftHaul_Transportation_Service_Agreement.pdf", number="AE-TSA-2025-004",
         start="2025-10-01", end="2026-09-30", notice=60, auto=False, fmt="slash",
         services="Container haulage between the port and the Senai plant", value="Per trip; rates per schedule",
         scenario="Already-ended contract", issues=[]),
    dict(id="D17", supplier="swifthaul", type="OPERATING_PERMIT", kind="licence",
         file="SwiftHaul_Operating_Permit.pdf", number="LTP-SIM-2026-1190", issuer="Simulated Land Transport Permit Office",
         title="GOODS VEHICLE OPERATOR PERMIT", scope="Haulage of containerised goods, 12 prime movers",
         issue="2026-01-15", expiry="2027-01-14", fmt="long",
         scenario="Valid licence", issues=[]),
    dict(id="D18", supplier="swifthaul", type="INSURANCE_CERTIFICATE", kind="insurance",
         file="SwiftHaul_Insurance_Certificate.pdf", number="TAB-GIT-2025-2214", issuer=TEGUH,
         scope="Goods in transit, limit RM 500,000 per trip", issue="2025-12-01", expiry="2027-11-30", fmt="long",
         conflict="This certificate is valid until 30 November 2026.",
         scenario="Conflicting dates", issues=["CONFLICTING_DATES"],
         note="The table says the cover ends 30 November 2027, but the declaration says 30 November 2026."),
    dict(id="D19", supplier="cahaya", type="INSURANCE_CERTIFICATE", kind="insurance", scan=True,
         file="Cahaya_Insurance_Certificate_scan.pdf", number="PAY-PL-2026-58830", issuer=PAYUNG,
         scope="Public liability, limit RM 1,000,000 per occurrence", issue="2026-06-01", expiry="2027-05-31", fmt="slash",
         scenario="Unreadable PDF", issues=["UNREADABLE"],
         note="Image-only scan with every value blurred on purpose. The values here are what is under the blur; the AI should report UNREADABLE, not guess."),
    dict(id="D20", supplier="cahaya", type="CLEANING_SERVICE_AGREEMENT", kind="contract",
         file="Cahaya_Cleaning_Service_Agreement.pdf", number="AE-CSA-2026-021",
         start="2026-03-01", end="2028-02-29", notice=60, auto=False, fmt="long",
         services="Cleaning of cleanroom gowning areas and corridors", value="RM 96,000 per year",
         scenario="Valid supplier contract", issues=[]),
]

# Mandatory documents that deliberately have no file.
MISSING = [
    dict(supplier="brightclean", type="BUSINESS_REGISTRATION_RECORD", scenario="Missing mandatory document"),
    dict(supplier="mutiara", type="PRODUCT_CONFORMITY_DOCUMENTATION",
         scenario="Missing mandatory document (made mandatory for this supplier)"),
]

SUPPLIER_BY_KEY = {s["key"]: s for s in SUPPLIERS}


# ------------------------------------------------------------------ Rules
def d(iso):
    return date.fromisoformat(iso)


def fmt(day, style):
    if style == "slash":
        return day.strftime("%d/%m/%Y")
    if style == "short":
        return f"{day.day} {day.strftime('%b')} {day.year}"
    return f"{day.day} {day.strftime('%B')} {day.year}"


def expected_status(doc, on):
    """Deterministic rules from spec 8.3. An issue means a person must review it."""
    _, cls, has_expiry, threshold = DOC_TYPES[doc["type"]]
    if doc["issues"]:
        return "NEEDS_REVIEW"
    if cls == "CONTRACT":
        if not doc.get("end"):
            return "NO_FIXED_END_DATE"
        days = (d(doc["end"]) - on).days
        return "ENDED" if days < 0 else ("ENDING_SOON" if days <= threshold else "ACTIVE")
    if not doc.get("expiry"):
        return "VALID" if not has_expiry else "NEEDS_REVIEW"
    days = (d(doc["expiry"]) - on).days
    return "EXPIRED" if days < 0 else ("EXPIRING_SOON" if days <= threshold else "VALID")


# ------------------------------------------------------------------ HTML
CSS = """
@page { size: A4; margin: 0; }
html, body { margin: 0; padding: 0; }
body { width: 210mm; height: 297mm; font-family: Arial, Helvetica, sans-serif; color: #1c1c1c; background: #ffffff; }
.page { position: relative; box-sizing: border-box; width: 210mm; height: 297mm; padding: 22mm 20mm; overflow: hidden; }
.sim { position: absolute; left: 0; right: 0; background: #B42318; color: #ffffff; text-align: center; font-weight: 700; font-size: 12px; letter-spacing: 1.5px; padding: 6px 0; }
.sim.top { top: 0; } .sim.bottom { bottom: 0; }
.wm { position: absolute; top: 52%; left: 50%; transform: translate(-50%, -50%) rotate(-32deg); font-weight: 700; font-size: 84px; color: rgba(180, 35, 24, 0.07); letter-spacing: 10px; white-space: nowrap; }
.issuer { font-size: 16px; font-weight: 700; letter-spacing: 0.4px; }
.issuer-note { font-size: 11px; color: #666666; margin-top: 2px; }
.rule { height: 3px; margin: 10px 0 0; }
.title { font-size: 22px; font-weight: 700; letter-spacing: 1.4px; margin: 20px 0 4px; }
.subtitle { font-size: 12.5px; color: #555555; margin-bottom: 14px; }
table.kv { width: 100%; border-collapse: collapse; font-size: 13.5px; margin-top: 8px; }
table.kv th { width: 36%; text-align: left; font-weight: 400; color: #555555; padding: 8px 10px 8px 0; border-bottom: 1px solid #dddddd; vertical-align: top; }
table.kv td { font-weight: 700; padding: 8px 0; border-bottom: 1px solid #dddddd; }
h3 { font-size: 14px; margin: 18px 0 6px; }
p, li { font-size: 12.5px; line-height: 1.55; }
ol { padding-left: 18px; margin: 6px 0; }
.signs { display: flex; gap: 28px; margin-top: 30px; font-size: 12px; color: #444444; }
.signs div { flex: 1; border-top: 1px solid #999999; padding-top: 6px; }
.note { margin-top: 18px; font-size: 11.5px; color: #555555; border: 1px dashed #bbbbbb; padding: 8px 10px; }
.unreadable td { filter: blur(5px); }
"""

ACCENTS = {"contract": "#1F3A68", "licence": "#0E6A73", "insurance": "#5B2A86", "certificate": "#7A4B00"}


def page(body, accent, scan=False):
    return (f"<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Simulated document</title>"
            f"<style>{CSS}.issuer, .title {{ color: {accent}; }} .rule {{ background: {accent}; }}</style></head>"
            f"<body><div class=\"page{' unreadable' if scan else ''}\"><div class=\"sim top\">{STAMP}</div>"
            f"<div class=\"wm\">SIMULATED</div>{body}<div class=\"sim bottom\">{STAMP}</div></div></body></html>")


def kv(rows):
    return "<table class=\"kv\">" + "".join(f"<tr><th>{escape(k)}</th><td>{escape(v)}</td></tr>" for k, v in rows) + "</table>"


def holder_of(doc):
    return doc.get("holder") or SUPPLIER_BY_KEY[doc["supplier"]]["info"]["supplierName"]


def render_contract(doc):
    sup = SUPPLIER_BY_KEY[doc["supplier"]]
    holder = holder_of(doc)
    start = fmt(d(doc["start"]), doc["fmt"])
    end = fmt(d(doc["end"]), doc["fmt"]) if doc["end"] else None
    title = DOC_TYPES[doc["type"]][0].upper()
    if end:
        term = f"This Agreement starts on {start} and ends on {end}."
    else:
        term = f"This Agreement starts on {start} and continues until it is terminated under clause 3. It has no fixed end date."
    if not end:
        renewal = "Not applicable, because this Agreement has no fixed end date."
    elif doc["auto"]:
        renewal = (f"This Agreement renews automatically for further periods of 12 months each, unless either party gives "
                   f"the other at least {doc['notice']} days' written notice before the end date.")
    else:
        renewal = f"This Agreement does not renew automatically. Any renewal must be agreed in writing at least {doc['notice']} days before the end date."
    rows = [
        ("Agreement No.", doc["number"]),
        ("Services", doc["services"]),
        ("Commencement date", start),
        ("End date", end or "No fixed end date"),
        ("Renewal notice period", f"{doc['notice']} days" if doc["notice"] else "Not applicable"),
        ("Automatic renewal", "Not applicable" if not end else ("Yes (see clause 2)" if doc["auto"] else "No")),
        ("Contract value", doc["value"]),
    ]
    body = (f"<div class=\"issuer\">{escape(CLIENT)}</div><div class=\"issuer-note\">Fictional company. Supplier contract file copy.</div>"
            f"<div class=\"rule\"></div><div class=\"title\">{escape(title)}</div>"
            f"<div class=\"subtitle\">This Agreement is made between the Client and the Supplier named below.</div>"
            + kv([("Client", f"{CLIENT}, {CLIENT_ADDRESS}"),
                  ("Supplier", f"{holder}, Registration No. {sup['info']['registrationNo']}, {sup['address']}")])
            + "<h3>Schedule</h3>" + kv(rows)
            + "<h3>Terms</h3><ol>"
            f"<li><b>Term.</b> {escape(term)}</li>"
            f"<li><b>Renewal.</b> {escape(renewal)}</li>"
            "<li><b>Termination.</b> Either party may end this Agreement by giving the other 90 days' written notice.</li>"
            "</ol><div class=\"signs\">"
            f"<div>Signed for {escape(CLIENT)}<br>Name: (simulated, not signed)</div>"
            f"<div>Signed for {escape(holder)}<br>Name: (simulated, not signed)</div></div>")
    return page(body, ACCENTS["contract"])


def render_permit(doc):
    """Licences, insurance certificates and other certificates."""
    sup = SUPPLIER_BY_KEY[doc["supplier"]]
    holder = holder_of(doc)
    kind = doc["kind"]
    issue = fmt(d(doc["issue"]), doc["fmt"])
    expiry = fmt(d(doc["expiry"]), doc["fmt"]) if doc.get("expiry") else None
    if kind == "insurance":
        title = "CERTIFICATE OF INSURANCE"
        rows = [("Certificate No.", doc["number"]), ("Insured", holder), ("Company registration No.", sup["info"]["registrationNo"]),
                ("Cover", doc["scope"]), ("Period of insurance", f"From {issue} to {expiry}")]
    else:
        title = doc["title"]
        rows = [(doc.get("number_label", "Licence No." if kind == "licence" else "Certificate No."), doc["number"]),
                (doc.get("holder_label", "Licence holder" if kind == "licence" else "Certificate holder"), holder),
                ("Company registration No.", sup["info"]["registrationNo"]),
                ("Scope" if kind != "licence" else "Category / scope", doc["scope"]),
                (doc.get("issue_label", "Date of issue"), issue)]
        if expiry:
            rows.append(("Expiry date" if kind == "licence" else "Valid until", expiry))
    statements = []
    if doc.get("no_expiry_text"):
        statements.append(doc["no_expiry_text"])
    if doc.get("conflict"):
        statements.append(doc["conflict"])
    statements.append("Issued under the conditions on file with the issuing body. Authorised officer: (simulated, not signed). "
                      "This document carries no official seal.")
    body = (f"<div class=\"issuer\">{escape(doc['issuer'])}</div><div class=\"issuer-note\">Fictional issuing body, made up for testing.</div>"
            f"<div class=\"rule\"></div><div class=\"title\">{escape(title)}</div>"
            f"<div class=\"subtitle\">Copy held in the supplier records of {escape(CLIENT)}</div>"
            + kv(rows) + "".join(f"<p class=\"note\">{escape(s)}</p>" for s in statements))
    return page(body, ACCENTS[kind], scan=doc.get("scan", False))


# ------------------------------------------------------------------ PDFs
BROWSERS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]


def browser():
    for path in BROWSERS:
        if os.path.exists(path):
            return path
    sys.exit("Microsoft Edge or Google Chrome is needed to print the PDFs.")


def headless(exe, profile, args, url):
    subprocess.run([exe, "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
                    f"--user-data-dir={profile}", *args, url],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)


def make_pdf(exe, profile, html_path, pdf_path, scan):
    if not scan:
        headless(exe, profile, ["--no-pdf-header-footer", f"--print-to-pdf={pdf_path}"], html_path.as_uri())
        return
    png = pdf_path.with_suffix(".tmp.png")
    headless(exe, profile, ["--force-device-scale-factor=2", "--window-size=794,1123", f"--screenshot={png}"], html_path.as_uri())
    img = Image.open(png).convert("RGB")
    img = img.point(lambda v: int(v * 0.9 + 14))
    img = img.rotate(1.1, resample=Image.BICUBIC, expand=False, fillcolor=(238, 236, 228))
    img = Image.blend(img, Image.effect_noise(img.size, 28).convert("RGB"), 0.09)
    img = img.filter(ImageFilter.GaussianBlur(0.9))
    img.save(pdf_path, "PDF", resolution=192.0)
    png.unlink(missing_ok=True)


# ------------------------------------------------------------------ Outputs
def truth_rows():
    rows = []
    for doc in DOCS:
        sup = SUPPLIER_BY_KEY[doc["supplier"]]
        name, cls, _, _ = DOC_TYPES[doc["type"]]
        contract = cls == "CONTRACT"
        due = doc.get("end") if contract else doc.get("expiry")
        if "CONFLICTING_DATES" in doc["issues"]:
            due = ""
        rows.append({
            "doc_id": "", "file_name": doc["file"], "supplier_id": "", "supplier_name": sup["info"]["supplierName"],
            "document_type": doc["type"], "document_class": cls, "holder_name": holder_of(doc), "document_no": doc["number"],
            "issuing_body": "" if contract else doc["issuer"], "client_name": CLIENT if contract else "",
            "issue_date": "" if contract else doc["issue"], "start_date": doc.get("start", "") if contract else "",
            "due_date": due or "", "renewal_notice_days": doc.get("notice") or "" if contract else "",
            "auto_renewal": ("YES" if doc.get("auto") else ("NO" if doc.get("end") else "")) if contract else "",
            "scope": doc.get("services") if contract else doc["scope"],
            "expected_status": expected_status(doc, REFERENCE_DATE), "expected_issues": ", ".join(doc["issues"]),
            "reference_date": REFERENCE_DATE.isoformat(), "scenario": doc["scenario"], "notes": doc.get("note", ""),
        })
    for m in MISSING:
        sup = SUPPLIER_BY_KEY[m["supplier"]]
        name, cls, _, _ = DOC_TYPES[m["type"]]
        rows.append({
            "doc_id": "", "file_name": "(no file)", "supplier_id": "", "supplier_name": sup["info"]["supplierName"],
            "document_type": m["type"], "document_class": cls, "holder_name": "", "document_no": "", "issuing_body": "",
            "client_name": "", "issue_date": "", "start_date": "", "due_date": "", "renewal_notice_days": "", "auto_renewal": "",
            "scope": "", "expected_status": "MISSING", "expected_issues": "", "reference_date": REFERENCE_DATE.isoformat(),
            "scenario": m["scenario"], "notes": f"{name} is mandatory for this supplier and no file is provided.",
        })
    return rows


def check_stable():
    day = REFERENCE_DATE
    while day <= STABLE_UNTIL:
        for doc in DOCS:
            if expected_status(doc, day) != expected_status(doc, REFERENCE_DATE):
                sys.exit(f"{doc['id']} changes status on {day}; adjust its dates.")
        day += timedelta(days=1)


def write_gs(rows):
    data = {
        "referenceDate": REFERENCE_DATE.isoformat(),
        "suppliers": [{
            "key": s["key"], "liveDemo": s["liveDemo"], "submit": s["submit"], "info": s["info"],
            "requirementOverrides": s["overrides"],
            "documents": [{"fileName": doc["file"], "docTypeId": doc["type"], "label": "",
                           "uploadLater": bool(doc.get("uploadLater")), "scenario": doc["scenario"]}
                          for doc in DOCS if doc["supplier"] == s["key"]],
        } for s in SUPPLIERS],
        "groundTruth": rows,
    }
    header = ("/**\n * M1_DemoDatasetData.gs · Member 1 · GENERATED by dataset/build_dataset.py. Don't edit by hand:\n"
              " * change the script and run it again. Fictional suppliers and the answer key (GroundTruth) for the\n"
              " * 20 simulated PDFs in dataset/pdfs. Used by M1_DemoDataset.gs.\n */\n")
    (ROOT / "app" / "M1_DemoDatasetData.gs").write_text(header + "const M1_DATASET = " + json.dumps(data, indent=2, ensure_ascii=False) + ";\n", encoding="utf-8")


def write_csv(rows):
    with open(ROOT / "dataset" / "GroundTruth.csv", "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def write_readme(rows):
    by_file = {r["file_name"]: r for r in rows}
    lines = [
        "# Fictional test dataset (spec section 14)",
        "",
        "Generated by `build_dataset.py`. To change anything, edit that script and run it again:",
        "",
        "```bash",
        "python dataset/build_dataset.py",
        "```",
        "",
        f"Everything here is fictional. Every page is stamped **{STAMP}**. There are no real government seals, signatures or agency names: "
        "every issuer is labelled as simulated or fictional.",
        "",
        f"Expected statuses are worked out for **{REFERENCE_DATE.isoformat()}**, the spec's monitoring date, and stay the same for any run date up to "
        f"**{STABLE_UNTIL.isoformat()}**. Contracts use a 60-day threshold. Licences and certificates use 30 days, except ISO 9001, which uses 60.",
        "",
        "## Suppliers",
        "",
        "| Supplier | Category | Criticality | Registration no. | How it's loaded |",
        "|---|---|---|---|---|",
    ]
    for s in SUPPLIERS:
        how = ("Register it live in the demo" if s["liveDemo"] else ("Imported and submitted" if s["submit"] else "Imported as a DRAFT"))
        lines.append(f"| {s['info']['supplierName']} | {s['info']['categoryId']} | {s['info']['criticality']} | {s['info']['registrationNo']} | {how} |")
    lines += ["", "## Documents", "",
              "| # | File | Supplier | Document | Expected status | Expected issues | Spec scenario |",
              "|---|---|---|---|---|---|---|"]
    for doc in DOCS:
        r = by_file[doc["file"]]
        lines.append(f"| {doc['id']} | `{doc['file']}` | {r['supplier_name']} | {DOC_TYPES[doc['type']][0]} | {r['expected_status']} | "
                     f"{r['expected_issues'] or 'none'} | {doc['scenario']} |")
    for m in MISSING:
        lines.append(f"| - | (no file) | {SUPPLIER_BY_KEY[m['supplier']]['info']['supplierName']} | {DOC_TYPES[m['type']][0]} | MISSING | none | {m['scenario']} |")
    lines += [
        "",
        "Supplier checklists that differ from the category defaults:",
        "",
        "- **Kilat Shine:** the Business Registration Record has a review date of 2027-06-30 (it never expires).",
        "- **Mutiara Components:** Product Conformity Documentation is made **mandatory** and is deliberately missing.",
        "- **Cahaya Facility Services:** the Business Registration Record is made **optional**, so its absence is not a problem.",
        "",
        "## Load it into the app",
        "",
        "1. Upload the `dataset/pdfs` folder to Google Drive. Open it and copy its ID: the part of the address after `/folders/`.",
        "2. In Apps Script, add the files `M1_DemoDatasetData` and `M1_DemoDataset` (both in `app/`). Under **Project Settings → Script properties**, "
        "add `DATASET_FOLDER_ID` with that ID.",
        "3. Run `M1_importDemoDataset`. It registers the 7 suppliers that aren't part of the live demo through the real Member 1 functions, uploads "
        "their documents, and fills the GroundTruth tab. Running it again skips anything already imported.",
        "",
        "## Live demo: BrightClean (spec section 13)",
        "",
        "Register BrightClean on stage instead of importing it:",
        "",
        "1. **Add existing supplier** with these details, and choose **Cleaning Services**:",
    ] + [f"   - {label}: {SUPPLIER_BY_KEY['brightclean']['info'][key] or '(leave blank)'}" for label, key in [
        ("Company name", "supplierName"), ("Registration number", "registrationNo"), ("Goods or services", "goodsServices"),
        ("Contact person", "contactPerson"), ("Contact email", "contactEmail"), ("Internal responsible officer", "internalOfficer"),
        ("Criticality", "criticality"), ("Procurement reference", "procurementRef")]] + [
        "2. **Upload** `BrightClean_Cleaning_Service_Agreement_2026.pdf` and `BrightClean_Insurance_Certificate_2025-2026.pdf`. Leave the "
        "Business Registration Record empty: that is the *missing mandatory document*.",
        "3. **Register.** The status becomes *Pending documents*.",
        "4. **Show the renewal.** Open the supplier, then use **Upload renewed version** on the Insurance Certificate with "
        "`BrightClean_Insurance_Certificate_2026-2027_RENEWAL.pdf`. Version 1 is kept in the history as replaced.",
        "",
        "To import BrightClean too (for example, for testing), run `M1_importDemoDatasetWithBrightClean` instead. It still leaves the renewal "
        "PDF for you to upload by hand.",
        "",
        "## The answer key",
        "",
        "`GroundTruth.csv` and the GroundTruth tab hold, for every document:",
        "",
        "- what it really says: holder, number, dates, renewal terms;",
        "- the expected status and issue codes.",
        "",
        "Member 2 compares Gemini's answers with it to measure accuracy, and Member 3 checks its statuses against it. The live app logic must never read it.",
        "",
        "For the unreadable scan and the conflicting-dates certificate, the values are what is printed under the blur or in the table, "
        "and the notes say what the AI should report instead.",
        "",
    ]
    (ROOT / "dataset" / "README.md").write_text("\n".join(lines), encoding="utf-8")


def main():
    check_stable()
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    exe = browser()
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        profile = tmp / "profile"
        for doc in DOCS:
            html = render_contract(doc) if doc["kind"] == "contract" else render_permit(doc)
            html_path = tmp / (doc["id"] + ".html")
            html_path.write_text(html, encoding="utf-8")
            make_pdf(exe, profile, html_path, PDF_DIR / doc["file"], doc.get("scan", False))
            print(f"made {doc['file']}")
    rows = truth_rows()
    write_csv(rows)
    write_gs(rows)
    write_readme(rows)
    print(f"{len(DOCS)} PDFs, {len(rows)} GroundTruth rows, {len(SUPPLIERS)} suppliers. Reference date {REFERENCE_DATE}.")


if __name__ == "__main__":
    main()
