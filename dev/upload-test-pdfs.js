/**
 * upload-test-pdfs.js · Development only.
 * Copies the project's test-pdfs folder (every sub-folder, PDF and note) into the
 * root of your Google Drive, using the sign-in you made with `clasp login`.
 *
 *   node dev/upload-test-pdfs.js
 *
 * It refuses to run if My Drive already has a "test-pdfs" folder, so it never makes
 * a second copy. Afterwards run M1_importDemoDataset in Apps Script: it finds the folder
 * by name. On a network that inspects secure connections, set NODE_OPTIONS=--use-system-ca.
 * Your sign-in tokens are only sent to Google and are never printed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'test-pdfs');
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MIME = { '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown' };

async function accessToken() {
  const file = path.join(os.homedir(), '.clasprc.json');
  if (!fs.existsSync(file)) throw new Error('No clasp sign-in found. Run "clasp login" first.');
  const t = (JSON.parse(fs.readFileSync(file, 'utf8')).tokens || {}).default;
  if (!t || !t.refresh_token || !t.client_id) throw new Error('The clasp sign-in file has no saved login. Run "clasp login" again.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: t.client_id, client_secret: t.client_secret || '', refresh_token: t.refresh_token, grant_type: 'refresh_token' })
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) throw new Error('Google refused the clasp sign-in (' + (body.error || res.status) + '). Run "clasp login" again.');
  return body.access_token;
}

async function drive(token, url, options) {
  const res = await fetch(url, Object.assign({}, options, { headers: Object.assign({ Authorization: 'Bearer ' + token }, (options || {}).headers) }));
  const text = await res.text();
  if (!res.ok) throw new Error('Google Drive said ' + res.status + ': ' + text.slice(0, 300));
  return text ? JSON.parse(text) : {};
}

async function createFolder(token, name, parentId) {
  const meta = { name: name, mimeType: FOLDER_MIME };
  if (parentId) meta.parents = [parentId];
  return drive(token, 'https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta)
  });
}

async function uploadFile(token, filePath, parentId) {
  const boundary = 'alphatrack' + Date.now();
  const meta = JSON.stringify({ name: path.basename(filePath), parents: [parentId] });
  const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const body = Buffer.concat([
    Buffer.from('--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + meta + '\r\n--' + boundary + '\r\nContent-Type: ' + mime + '\r\n\r\n'),
    fs.readFileSync(filePath),
    Buffer.from('\r\n--' + boundary + '--')
  ]);
  return drive(token, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body
  });
}

async function copyTree(token, dir, parentId, counts) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const folder = await createFolder(token, entry.name, parentId);
      counts.folders++;
      await copyTree(token, full, folder.id, counts);
    } else if (MIME[path.extname(entry.name).toLowerCase()]) {
      await uploadFile(token, full, parentId);
      counts.files++;
      if (entry.name.toLowerCase().endsWith('.pdf')) counts.pdfs++;
      process.stdout.write('.');
    }
  }
}

(async () => {
  const token = await accessToken();
  const q = encodeURIComponent("name = 'test-pdfs' and mimeType = '" + FOLDER_MIME + "' and trashed = false");
  const existing = await drive(token, 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,webViewLink)');
  if (existing.files && existing.files.length) {
    console.log('Your Drive already has a "test-pdfs" folder, so nothing was uploaded: ' + existing.files[0].webViewLink);
    return;
  }
  const top = await createFolder(token, 'test-pdfs', null);
  const counts = { folders: 0, files: 0, pdfs: 0 };
  process.stdout.write('Uploading');
  await copyTree(token, ROOT, top.id, counts);
  console.log('\nDone: ' + counts.pdfs + ' PDFs (' + counts.files + ' files in ' + counts.folders + ' folders) are in My Drive > test-pdfs.');
  console.log('Open it: ' + top.webViewLink);
})().catch((err) => {
  console.error('\nUpload stopped: ' + err.message);
  process.exitCode = 1;
});
