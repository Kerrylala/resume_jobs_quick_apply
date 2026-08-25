import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { isMainModule, projectRootFromMetaUrl } from './lib/project_paths.mjs';

const root = projectRootFromMetaUrl(import.meta.url);
const dashboardUrl = String(process.env.RESUME_JOBS_DASHBOARD_URL || 'http://127.0.0.1:8767/');
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1024, height: 768 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 }
];

function browserExecutable() {
  const candidates = [
    process.env.RESUME_JOBS_BROWSER_EXECUTABLE,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

export async function testDashboardResponsive() {
  const executablePath = browserExecutable();
  if (!executablePath) throw new Error('Chrome or Edge is required for responsive Dashboard QA.');
  const browser = await chromium.launch({ executablePath, headless: true });
  const consoleErrors = [];
  const results = [];
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      page.on('console', message => {
        if (message.type() === 'error') consoleErrors.push({ viewport: viewport.name, message: message.text().slice(0, 240) });
      });
      await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await page.waitForSelector('.container', { state: 'visible', timeout: 20_000 });
      await page.waitForFunction(() => !document.querySelector('#workflowCurrentLabel')?.textContent?.includes('Loading'), null, { timeout: 20_000 });
      await page.locator('#jobMatchesTabBtn').click();
      await page.waitForSelector('#jobsTableBody [data-job-id]', { state: 'visible', timeout: 20_000 });
      await page.keyboard.press('Tab');
      const result = await page.evaluate(() => {
        const rootElement = document.documentElement;
        const visible = element => Boolean(element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
        const namedButtons = [...document.querySelectorAll('button')].filter(visible).every(button => String(button.textContent || button.getAttribute('aria-label') || '').trim().length > 0);
        const unlabeledInputs = [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(visible).filter(control => {
          if (control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')) return false;
          if (control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`)) return false;
          return !control.closest('label');
        }).length;
        const unlabeledInputsIncludingHiddenViews = [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter(control => {
          if (control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')) return false;
          if ([...(control.labels || [])].some(label => String(label.textContent || '').trim())) return false;
          if (control.id && document.querySelector(`label[for="${CSS.escape(control.id)}"]`)) return false;
          return true;
        }).length;
        const focusedControl = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
        const focusStyle = focusedControl ? getComputedStyle(focusedControl) : null;
        const focusVisible = Boolean(focusStyle && (focusStyle.outlineStyle !== 'none' || focusStyle.boxShadow !== 'none'));
        const jobRows = [...document.querySelectorAll('#jobsTableBody [data-job-id]')];
        return {
          horizontal_overflow_px: Math.max(0, rootElement.scrollWidth - rootElement.clientWidth),
          minimum_body_font_px: Number.parseFloat(getComputedStyle(document.body).fontSize),
          named_buttons: namedButtons,
          unlabeled_visible_fields: unlabeledInputs,
          unlabeled_all_product_fields: unlabeledInputsIncludingHiddenViews,
          focus_indicator_present: focusVisible,
          product_modal_present: Boolean(document.querySelector('#productConfirmationModal[role="dialog"][aria-modal="true"]')),
          current_results_control_present: Boolean(document.querySelector('[data-job-inventory="current"]')),
          source_labels_are_user_facing: document.body.textContent.includes('Public application forms') && !document.querySelector('#sourceCatalogContainer')?.textContent?.includes('ATS'),
          advanced_json_closed: [...document.querySelectorAll('.career-json-advanced')].every(details => !details.open),
          job_detail_sections_closed: jobRows.every(row => [...row.querySelectorAll('details')].every(details => !details.open)),
          visible_job_rows: jobRows.filter(visible).length,
          navigation_present: Boolean(document.querySelector('nav[aria-label="Product navigation"]'))
        };
      });
      results.push({ viewport: viewport.name, ...result });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const failures = results.flatMap(result => [
    result.horizontal_overflow_px > 1 ? `${result.viewport}: horizontal overflow ${result.horizontal_overflow_px}px` : '',
    result.minimum_body_font_px < 14 ? `${result.viewport}: body font below 14px` : '',
    !result.named_buttons ? `${result.viewport}: visible button without accessible name` : '',
    result.unlabeled_visible_fields > 0 ? `${result.viewport}: ${result.unlabeled_visible_fields} unlabeled visible field(s)` : '',
    result.unlabeled_all_product_fields > 0 ? `${result.viewport}: ${result.unlabeled_all_product_fields} unlabeled product field(s), including inactive views` : '',
    !result.focus_indicator_present ? `${result.viewport}: focus indicator not visible` : '',
    !result.product_modal_present ? `${result.viewport}: product modal accessibility contract missing` : '',
    !result.current_results_control_present ? `${result.viewport}: current-results inventory missing` : '',
    !result.source_labels_are_user_facing ? `${result.viewport}: technical source label visible` : '',
    !result.advanced_json_closed ? `${result.viewport}: advanced JSON expanded by default` : '',
    !result.job_detail_sections_closed ? `${result.viewport}: job details expanded by default` : '',
    result.visible_job_rows < 1 ? `${result.viewport}: compact job list did not render` : '',
    !result.navigation_present ? `${result.viewport}: primary navigation missing` : ''
  ].filter(Boolean));
  if (consoleErrors.length) failures.push(`${consoleErrors.length} browser console error(s)`);
  const report = {
    status: failures.length ? 'failed' : 'passed',
    dashboard_url_is_loopback: /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(dashboardUrl),
    viewports: results,
    console_error_count: consoleErrors.length,
    failures
  };
  if (failures.length) throw Object.assign(new Error(failures.join('; ')), { report });
  return report;
}

if (isMainModule(import.meta.url)) {
  testDashboardResponsive().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(JSON.stringify(error.report || { status: 'failed', error: error.message }, null, 2));
    process.exitCode = 1;
  });
}
