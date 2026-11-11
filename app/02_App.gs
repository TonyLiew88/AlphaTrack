/**
 * 02_App.gs · Web app shell · Owner: Member 5 (integration)
 *
 * Serves the single dashboard. Each member's page lives in its own HTML files
 * and is pulled in with include().
 */

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Silent Expiry Guardian · Alpha Electronics')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Used inside the HTML templates: <?!= include('Styles'); ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/** Basic facts the page needs on load. Called by AppClient. */
function SEG_getAppInfo() {
  const ss = SEG_spreadsheet();
  const missingTabs = Object.keys(SEG.HEADERS).filter((name) => !ss.getSheetByName(name));
  return {
    appName: SEG.APP_NAME,
    company: SEG.COMPANY,
    user: SEG_currentUser(),
    today: SEG_today(),
    spreadsheetUrl: ss.getUrl(),
    setupNeeded: missingTabs.length > 0,
    missingTabs: missingTabs
  };
}
