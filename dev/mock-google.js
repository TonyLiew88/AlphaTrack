/**
 * mock-google.js · Development only. NOT deployed to Apps Script.
 *
 * In-memory stand-ins for the Google Apps Script services the app uses
 * (SpreadsheetApp, DriveApp, Utilities, PropertiesService, LockService, Session,
 * ScriptApp), so the real .gs files can run in a browser preview or in Node tests.
 * Nothing here talks to Google. The hash is a stand-in, not real SHA-256.
 */
(function (g) {
  const OFFSET_MS = 8 * 3600 * 1000; // Malaysia is UTC+8 all year
  const pad = (n, w) => String(n).padStart(w || 2, '0');

  /* ------------------------------------------------------------ bytes */
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const toSigned = (b) => { const v = b & 0xff; return v > 127 ? v - 256 : v; };
  function utf8Bytes(str) {
    const bin = unescape(encodeURIComponent(String(str)));
    const out = [];
    for (let i = 0; i < bin.length; i++) out.push(toSigned(bin.charCodeAt(i)));
    return out;
  }
  function b64encode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i] & 0xff;
      const b = i + 1 < bytes.length ? bytes[i + 1] & 0xff : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] & 0xff : 0;
      const n = (a << 16) | (b << 8) | c;
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
    }
    return out;
  }
  function b64decode(str) {
    const clean = String(str).replace(/[^A-Za-z0-9+/]/g, '');
    const out = [];
    for (let i = 0; i < clean.length; i += 4) {
      const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) |
        ((B64.indexOf(clean[i + 2]) & 63) << 6) | (B64.indexOf(clean[i + 3]) & 63);
      out.push(toSigned(n >> 16));
      if (i + 2 < clean.length) out.push(toSigned(n >> 8));
      if (i + 3 < clean.length) out.push(toSigned(n));
    }
    return out;
  }
  function fakeDigest(bytes) {
    const out = [];
    for (let seed = 0; seed < 8; seed++) {
      let h = (0x811c9dc5 ^ (seed * 0x9e3779b1)) >>> 0;
      for (let i = 0; i < bytes.length; i++) { h ^= bytes[i] & 0xff; h = Math.imul(h, 0x01000193) >>> 0; }
      h ^= bytes.length; h = Math.imul(h, 0x01000193) >>> 0;
      out.push(toSigned(h >>> 24), toSigned(h >>> 16), toSigned(h >>> 8), toSigned(h));
    }
    return out;
  }

  /* -------------------------------------------------------- Utilities */
  function makeBlob(bytes, mime, name) {
    let n = name || 'blob';
    return {
      getBytes: () => bytes.slice(),
      getContentType: () => mime || 'application/octet-stream',
      getName: () => n,
      setName(v) { n = v; return this; }
    };
  }
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5' },
    formatDate(date, tz, pattern) {
      if (tz !== 'Asia/Kuala_Lumpur') throw new Error('mock only knows Asia/Kuala_Lumpur');
      const d = new Date(date.getTime() + OFFSET_MS);
      return pattern.replace("'T'", 'T')
        .replace('yyyy', d.getUTCFullYear()).replace('MM', pad(d.getUTCMonth() + 1)).replace('dd', pad(d.getUTCDate()))
        .replace('HH', pad(d.getUTCHours())).replace('mm', pad(d.getUTCMinutes())).replace('ss', pad(d.getUTCSeconds()))
        .replace('XXX', '+08:00');
    },
    base64Encode: (data) => b64encode(typeof data === 'string' ? utf8Bytes(data) : data),
    base64Decode: (s) => b64decode(s),
    newBlob: (data, mime, name) => makeBlob(typeof data === 'string' ? utf8Bytes(data) : data.slice(), mime, name),
    computeDigest: (alg, bytes) => fakeDigest(bytes),
    sleep: () => {}
  };

  /* ------------------------------------------------------------ Sheets */
  function Range(sheet, row, col, numRows, numCols) {
    this.getValues = () => {
      const out = [];
      for (let r = 0; r < numRows; r++) {
        const src = sheet.rows[row - 1 + r] || [];
        const line = [];
        for (let c = 0; c < numCols; c++) line.push(src[col - 1 + c] === undefined ? '' : src[col - 1 + c]);
        out.push(line);
      }
      return out;
    };
    this.setValues = (values) => {
      if (values.length !== numRows || values.some((v) => v.length !== numCols)) {
        throw new Error('The number of rows or columns in the data does not match the range (mock).');
      }
      values.forEach((line, r) => {
        while (sheet.rows.length < row + r) sheet.rows.push([]);
        const target = sheet.rows[row - 1 + r];
        line.forEach((v, c) => { target[col - 1 + c] = v; });
      });
      return this;
    };
    ['setNumberFormat', 'setFontWeight', 'setBackground', 'setFontColor'].forEach((m) => { this[m] = () => this; });
  }
  function Sheet(name) {
    this.rows = [];
    this.getName = () => name;
    this.getLastRow = () => {
      let last = 0;
      this.rows.forEach((r, i) => { if (r.some((c) => c !== '' && c !== null && c !== undefined)) last = i + 1; });
      return last;
    };
    this.getLastColumn = () => {
      let last = 0;
      this.rows.forEach((r) => r.forEach((c, i) => { if (c !== '' && c !== null && c !== undefined) last = Math.max(last, i + 1); }));
      return last;
    };
    this.getMaxRows = () => Math.max(1000, this.rows.length);
    this.getMaxColumns = () => 26;
    this.getRange = (row, col, numRows, numCols) => new Range(this, row, col, numRows || 1, numCols || 1);
    this.getDataRange = () => this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
    this.setFrozenRows = () => this;
    this.deleteRow = (row) => { this.rows.splice(row - 1, 1); return this; };
  }
  const sheets = {};
  let sheetOrder = ['Sheet1'];
  sheets.Sheet1 = new Sheet('Sheet1');
  const spreadsheet = {
    getId: () => 'LOCAL-SPREADSHEET',
    getUrl: () => '#local-spreadsheet',
    getSheetByName: (n) => sheets[n] || null,
    getSheets: () => sheetOrder.map((n) => sheets[n]),
    insertSheet: (n) => { sheets[n] = new Sheet(n); sheetOrder.push(n); return sheets[n]; },
    deleteSheet: (s) => { delete sheets[s.getName()]; sheetOrder = sheetOrder.filter((n) => n !== s.getName()); }
  };
  const SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
    openById: () => spreadsheet,
    flush: () => {}
  };

  /* ------------------------------------------------------------- Drive */
  let seq = 0;
  const newId = (p) => p + pad(++seq, 4) + '_mockdriveid_xxxxxxxx';
  const folders = {};
  const files = {};
  const canMakeUrls = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined';
  const iterate = (list) => { const l = list.slice(); return { hasNext: () => l.length > 0, next: () => l.shift() }; };
  function makeFolder(name, parentFolder) {
    const id = newId('FOLDER');
    let parentOf = parentFolder || null;
    const folder = {
      children: [], files: [],
      getId: () => id,
      getName: () => name,
      setName: (n) => { name = String(n); return folder; },
      getUrl: () => 'https://drive.google.com/drive/folders/' + id,
      getParents: () => iterate(parentOf ? [parentOf] : []),
      moveTo: (dest) => {
        if (parentOf) parentOf.children = parentOf.children.filter((c) => c !== folder);
        dest.children.push(folder);
        parentOf = dest;
        return folder;
      },
      createFolder: (n) => { const f = makeFolder(n, folder); folder.children.push(f); return f; },
      getFoldersByName: (n) => iterate(folder.children.filter((c) => c.getName() === n)),
      createFile: (blob) => {
        const fid = newId('FILE');
        const bytes = blob.getBytes();
        const created = new Date();
        let url = 'https://drive.google.com/file/d/' + fid + '/view';
        if (canMakeUrls) {
          const arr = new Uint8Array(bytes.map((b) => b & 0xff));
          url = URL.createObjectURL(new Blob([arr], { type: blob.getContentType() }));
        }
        let description = '';
        let parent = folder;
        const file = {
          getId: () => fid, getName: () => blob.getName(), getMimeType: () => blob.getContentType(), getSize: () => bytes.length,
          getUrl: () => url, getBlob: () => makeBlob(bytes, blob.getContentType(), blob.getName()),
          getLastUpdated: () => created, getDateCreated: () => created,
          setDescription: (d) => { description = d; return file; }, getDescription: () => description,
          getParents: () => iterate([parent]),
          moveTo: (dest) => {
            parent.files = parent.files.filter((f) => f !== file);
            dest.files.push(file);
            parent = dest;
            return file;
          },
          trashed: false,
          isTrashed: () => file.trashed,
          setTrashed: (v) => { file.trashed = !!v; return file; }
        };
        files[fid] = file;
        folder.files.push(file);
        return file;
      },
      getFolders: () => iterate(folder.children),
      getFiles: () => iterate(folder.files),
      trashed: false,
      isTrashed: () => folder.trashed,
      setTrashed: (v) => { folder.trashed = !!v; return folder; }
    };
    folders[id] = folder;
    return folder;
  }
  const DriveApp = {
    createFolder: (name) => makeFolder(name, null),
    getFoldersByName: (name) => iterate(Object.keys(folders).map((k) => folders[k]).filter((f) => f.getName() === name)),
    getFolderById: (id) => { if (!folders[id]) throw new Error('No folder with ID ' + id + ' (mock).'); return folders[id]; },
    getFileById: (id) => { if (!files[id]) throw new Error('No file with ID ' + id + ' (mock).'); return files[id]; }
  };

  /* ------------------------------------------------------------- Other */
  const props = {};
  const PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: (k) => { delete props[k]; },
      getProperties: () => Object.assign({}, props)
    })
  };
  const LockService = { getScriptLock: () => ({ waitLock: () => {}, tryLock: () => true, releaseLock: () => {}, hasLock: () => true }) };
  const user = { getEmail: () => 'procurement.officer@alpha-electronics.example' };
  const Session = { getActiveUser: () => user, getEffectiveUser: () => user, getScriptTimeZone: () => 'Asia/Kuala_Lumpur' };
  const triggers = [];
  const ScriptApp = {
    getProjectTriggers: () => triggers.slice(),
    newTrigger: (handler) => {
      const chain = { timeBased: () => chain, after: () => chain, everyDays: () => chain, atHour: () => chain,
        create: () => { const t = { getHandlerFunction: () => handler }; triggers.push(t); return t; } };
      return chain;
    }
  };

  Object.assign(g, { Utilities, SpreadsheetApp, DriveApp, PropertiesService, LockService, Session, ScriptApp });
  g.__mock = { sheets, folders, files, props, triggers };
})(typeof globalThis !== 'undefined' ? globalThis : this);
