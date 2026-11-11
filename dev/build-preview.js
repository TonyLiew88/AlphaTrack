/**
 * build-preview.js · Development only.
 * Builds dev/preview.html: the real app pages and the real .gs server code, run in
 * the browser on top of mock-google.js, with three fictional demo suppliers.
 *   node dev/build-preview.js
 */
const fs = require('fs');
const path = require('path');

const appDir = path.resolve(__dirname, '..', 'app');
const read = (p) => fs.readFileSync(p, 'utf8');

function resolveIncludes(html) {
  return html.replace(/<\?!=\s*include\('([^']+)'\);?\s*\?>/g, (_, name) => resolveIncludes(read(path.join(appDir, name + '.html'))));
}

const serverCode = fs.readdirSync(appDir)
  .filter((f) => f.endsWith('.gs'))
  .sort()
  .map((f) => '/* ===== ' + f + ' ===== */\n' + read(path.join(appDir, f)))
  .join('\n');

const shim = `
(function () {
  // Stand-in for google.script.run: calls the server function in this page, after a short delay.
  function makeRunner(ok, fail) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (fn) { return makeRunner(fn, fail); };
        if (name === 'withFailureHandler') return function (fn) { return makeRunner(ok, fn); };
        if (name === 'withUserObject') return function () { return makeRunner(ok, fail); };
        return function () {
          var args = JSON.parse(JSON.stringify(Array.prototype.slice.call(arguments)));
          setTimeout(function () {
            try {
              var fn = window[name];
              if (typeof fn !== 'function') throw new Error('Server function ' + String(name) + ' not found.');
              var out = fn.apply(null, args);
              var result = out === undefined ? null : JSON.parse(JSON.stringify(out));
              if (ok) ok(result);
            } catch (err) {
              console.warn('[server] ' + err.message);
              if (fail) fail(err);
            }
          }, 200 + Math.random() * 300);
        };
      }
    });
  }
  window.google = { script: { run: makeRunner(null, null) } };

  // "Open Drive folder" points at Google Drive, which this preview has no access to.
  // Show the in-memory folder instead of opening a Google 404 page.
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[href*="/drive/folders/"]');
    if (!link) return;
    var folder = window.__mock && window.__mock.folders[link.getAttribute('href').split('/drive/folders/')[1]];
    if (!folder) return;
    e.preventDefault();
    var esc = App.esc;
    function tree(f) {
      var items = f.children.map(function (c) {
        return '<li><strong>' + esc(c.getName()) + '</strong>' + tree(c) + '</li>';
      }).concat(f.files.map(function (file) {
        return '<li><a href="' + esc(file.getUrl()) + '" target="_blank" rel="noopener">' + esc(file.getName()) + '</a></li>';
      }));
      return '<ul style="margin:4px 0 8px;padding-left:20px;display:flex;flex-direction:column;gap:4px">' +
        (items.length ? items.join('') : '<li class="muted">(empty)</li>') + '</ul>';
    }
    App.modal({
      title: folder.getName(),
      wide: true,
      body: '<p class="callout info">Local preview: this is what the supplier\\'s Google Drive folder will hold. ' +
        'In the real app, this button opens the folder in Google Drive.</p><div style="font-size:14px">' + tree(folder) + '</div>'
    });
  }, true);

  try {
    SEG_setupDatabase();
    // Load the fictional test dataset (test-pdfs, sub-folders included) exactly as M1_importDemoDataset does in Google.
    var folder = DriveApp.createFolder('test-pdfs');
    var subFolder = function (rel) {
      var f = folder;
      rel.split('/').filter(Boolean).forEach(function (part) {
        var it = f.getFoldersByName(part);
        f = it.hasNext() ? it.next() : f.createFolder(part);
      });
      return f;
    };
    (window.__DATASET_PDFS || []).forEach(function (p) {
      subFolder(p.dir || '').createFile(Utilities.newBlob(Utilities.base64Decode(p.b64), 'application/pdf', p.name));
    });
    M1_importDataset(M1_datasetFolderId(), {});
  } catch (err) {
    console.error('Preview setup failed', err);
  }
})();`;

const pdfRoot = path.resolve(__dirname, '..', 'test-pdfs');
const walkPdfs = (dir, rel) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const relPath = rel ? rel + '/' + e.name : e.name;
  if (e.isDirectory()) return walkPdfs(path.join(dir, e.name), relPath);
  return e.name.endsWith('.pdf') ? [{ name: e.name, dir: rel, b64: fs.readFileSync(path.join(dir, e.name)).toString('base64') }] : [];
});
const pdfs = fs.existsSync(pdfRoot) ? walkPdfs(pdfRoot, '') : [];

const devBar = '<div style="background:#FEF3C7;color:#78350F;font:13px/1.4 system-ui,sans-serif;padding:7px 16px;text-align:center;border-bottom:1px solid #F3D9A4">' +
  '<strong>Local preview.</strong> Fake in-memory Sheets and Drive, loaded with the fictional test dataset (7 suppliers). ' +
  'BrightClean is left for you to register: its PDFs are in test-pdfs/2. Video demo. Nothing is sent to Google, and everything resets when you reload.</div>';

const inject = devBar +
  '\n<script>\n' + read(path.join(__dirname, 'mock-google.js')) + '\n</script>' +
  '\n<script>window.__DATASET_PDFS = ' + JSON.stringify(pdfs) + ';</script>' +
  '\n<script>\n' + serverCode + '\n</script>' +
  '\n<script>' + shim + '\n</script>\n';

const html = resolveIncludes(read(path.join(appDir, 'Index.html'))).replace('<body>', () => '<body>\n' + inject);
fs.writeFileSync(path.join(__dirname, 'preview.html'), html);
console.log('Wrote dev/preview.html (' + Math.round(html.length / 1024) + ' KB)');
