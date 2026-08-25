// Company careers discovery: real postings from real providers, and an honest
// named reason whenever nothing can be discovered. The failure the tests exist
// to prevent is fabrication — an empty or unreadable board must never come
// back looking like "no jobs at this company" or, worse, like jobs.
import assert from 'node:assert/strict';
import test from 'node:test';

import { detectCareersSource, discoverCompanyJobs } from '../scripts/lib/company_careers.mjs';

function jsonResponse(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => value, text: async () => JSON.stringify(value) };
}

function htmlResponse(html, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => { throw new Error('not json'); }, text: async () => html };
}

test('provider detection reads greenhouse and lever URLs, everything else is generic', () => {
  assert.deepEqual(detectCareersSource('https://boards.greenhouse.io/synthetic'), { provider: 'greenhouse', token: 'synthetic' });
  assert.deepEqual(detectCareersSource('https://job-boards.greenhouse.io/synthetic/jobs/123'), { provider: 'greenhouse', token: 'synthetic' });
  assert.deepEqual(
    detectCareersSource('https://boards.greenhouse.io/embed/job_board?for=synthetic'),
    { provider: 'greenhouse', token: 'synthetic' },
    'embedded boards carry the token in ?for='
  );
  assert.deepEqual(detectCareersSource('https://jobs.lever.co/synthetic'), { provider: 'lever', token: 'synthetic' });
  assert.equal(detectCareersSource('https://example.com/careers').provider, 'generic');
  assert.equal(detectCareersSource('not a url').provider, 'generic');
});

test('a greenhouse board resolves through the official API', async () => {
  const seen = [];
  const result = await discoverCompanyJobs('https://boards.greenhouse.io/synthetic', {
    fetchImpl: async url => {
      seen.push(url);
      return jsonResponse({
        name: 'Synthetic Corp',
        jobs: [
          { title: 'Data Scientist', absolute_url: 'https://job-boards.greenhouse.io/synthetic/jobs/1', location: { name: 'Remote' } },
          { title: 'Engineer', absolute_url: 'https://job-boards.greenhouse.io/synthetic/jobs/2', location: { name: 'Shanghai' } }
        ]
      });
    }
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.provider, 'greenhouse');
  assert.equal(result.jobs.length, 2);
  assert.equal(result.jobs[0].title, 'Data Scientist');
  assert.equal(result.jobs[0].company, 'Synthetic Corp');
  assert.equal(result.jobs[0].source, 'company_careers_greenhouse');
  assert.match(seen[0], /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/synthetic\/jobs\?content=true$/);
});

test('a lever board resolves through the official postings API', async () => {
  const result = await discoverCompanyJobs('https://jobs.lever.co/synthetic', {
    fetchImpl: async () => jsonResponse([
      { text: 'Backend Engineer', hostedUrl: 'https://jobs.lever.co/synthetic/abc', categories: { location: 'Remote' } }
    ])
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.provider, 'lever');
  assert.equal(result.jobs[0].title, 'Backend Engineer');
  assert.equal(result.jobs[0].source, 'company_careers_lever');
});

test('a 404 board is board_not_found, never an empty success', async () => {
  const result = await discoverCompanyJobs('https://boards.greenhouse.io/doesnotexist', {
    fetchImpl: async () => jsonResponse({}, 404)
  });
  assert.equal(result.status, 'board_not_found');
  assert.deepEqual(result.jobs, []);
});

test('an unreachable provider is provider_unreachable with zero jobs', async () => {
  const result = await discoverCompanyJobs('https://jobs.lever.co/synthetic', {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
  });
  assert.equal(result.status, 'provider_unreachable');
  assert.deepEqual(result.jobs, []);
  assert.equal(result.safety.jobs_fabricated, false);
});

test('a board with genuinely no postings says no_postings_found', async () => {
  const result = await discoverCompanyJobs('https://jobs.lever.co/synthetic', {
    fetchImpl: async () => jsonResponse([])
  });
  assert.equal(result.status, 'no_postings_found');
  assert.deepEqual(result.jobs, []);
});

test('a generic static careers page yields conservative discoveries', async () => {
  const html = `<html><body>
    <a href="https://example.com/careers/data-scientist-1234">Data Scientist</a>
    <a href="https://example.com/careers/backend-engineer-5678">Backend Engineer</a>
    <a href="https://example.com/about">About us</a>
  </body></html>`;
  const result = await discoverCompanyJobs('https://example.com/careers', {
    fetchImpl: async () => htmlResponse(html),
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  assert.equal(result.provider, 'generic');
  // The conservative extractor may or may not accept these links; what is
  // NON-negotiable is that it never invents entries beyond the anchors.
  assert.ok(result.jobs.length <= 2);
  for (const job of result.jobs) {
    assert.match(job.url, /^https:\/\/example\.com\/careers\//);
  }
});

test('a JS-rendered page is reported as such, not as "no jobs"', async () => {
  // Modeled on the real jobs.lever.co board HTML: large, framework-mounted,
  // zero job links without JavaScript.
  const html = `<html><body><div id="root"></div>${'<div class="chunk">padding</div>'.repeat(9000)}</body></html>`;
  const result = await discoverCompanyJobs('https://example.com/careers', {
    fetchImpl: async () => htmlResponse(html),
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  assert.equal(result.status, 'js_rendered_page');
  assert.deepEqual(result.jobs, []);
});

test('a generic URL pointing into a private network is rejected by the SSRF guard', async () => {
  await assert.rejects(
    discoverCompanyJobs('https://internal.example.com/careers', {
      fetchImpl: async () => htmlResponse('<html></html>'),
      lookup: async () => [{ address: '10.0.0.5', family: 4 }]
    }),
    error => error.code === 'PRIVATE_NETWORK_FORBIDDEN'
  );
});

test('provider API hosts are fixed — the pasted URL cannot redirect the request', async () => {
  const seen = [];
  await discoverCompanyJobs('https://boards.greenhouse.io/synthetic?redirect=https://evil.example', {
    fetchImpl: async url => { seen.push(url); return jsonResponse({ jobs: [] }); }
  });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].startsWith('https://boards-api.greenhouse.io/'), 'only the official API host is contacted');
});

test('an ashby board resolves through the official posting API', async () => {
  const seen = [];
  const result = await discoverCompanyJobs('https://jobs.ashbyhq.com/synthetic', {
    fetchImpl: async url => {
      seen.push(url);
      return jsonResponse({
        jobs: [{ title: 'Platform Engineer', jobUrl: 'https://jobs.ashbyhq.com/synthetic/abc', location: 'Remote' }]
      });
    }
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.provider, 'ashby');
  assert.equal(result.jobs[0].title, 'Platform Engineer');
  assert.equal(result.jobs[0].source, 'company_careers_ashby');
  assert.ok(seen[0].startsWith('https://api.ashbyhq.com/posting-api/job-board/'));
});

test('a smartrecruiters board resolves through the official postings API', async () => {
  const result = await discoverCompanyJobs('https://careers.smartrecruiters.com/SyntheticCorp', {
    fetchImpl: async () => jsonResponse({
      content: [{ id: '744000012', name: 'QA Engineer', location: { city: 'Berlin', country: 'de' }, company: { name: 'Synthetic Corp' } }]
    })
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.provider, 'smartrecruiters');
  assert.equal(result.jobs[0].title, 'QA Engineer');
  assert.match(result.jobs[0].url, /^https:\/\/jobs\.smartrecruiters\.com\/SyntheticCorp\/744000012$/);
});

test('a workable board resolves through the official widget API', async () => {
  const result = await discoverCompanyJobs('https://apply.workable.com/synthetic', {
    fetchImpl: async () => jsonResponse({
      name: 'Synthetic Inc',
      jobs: [{ title: 'Support Engineer', shortcode: 'AB12CD', city: 'Athens', country: 'Greece' }]
    })
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.provider, 'workable');
  assert.equal(result.jobs[0].company, 'Synthetic Inc');
  assert.match(result.jobs[0].url, /apply\.workable\.com\/synthetic\/j\/AB12CD/);
});

test('the new providers fail as honestly as the old ones', async () => {
  for (const url of ['https://jobs.ashbyhq.com/ghost', 'https://careers.smartrecruiters.com/Ghost', 'https://apply.workable.com/ghost']) {
    const missing = await discoverCompanyJobs(url, { fetchImpl: async () => jsonResponse({}, 404) });
    assert.equal(missing.status, 'board_not_found', url);
    assert.deepEqual(missing.jobs, []);
  }
});
