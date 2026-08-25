import assert from 'node:assert/strict';
import test from 'node:test';
import { ingestPublicJobUrl, JobUrlIngestionError, validatePublicJobUrl } from '../scripts/lib/job_url_ingestion.mjs';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('public job URL ingestion requires explicit confirmation and normalizes metadata', async () => {
  await assert.rejects(
    ingestPublicJobUrl('https://careers.example.com/jobs/42', { lookup: publicLookup }),
    error => error instanceof JobUrlIngestionError && error.code === 'PUBLIC_FETCH_CONFIRMATION_REQUIRED'
  );
  const result = await ingestPublicJobUrl('https://careers.example.com/jobs/42?utm_source=test', {
    confirmedPublicFetch: true,
    lookup: publicLookup,
    // A generic (non-ATS) page must carry a real description to pass the job
    // quality gate — thin link-preview metadata alone is not a job posting.
    fetchImpl: async () => new Response('<!doctype html><html><head><title>Senior Platform Engineer</title><meta name="description" content="Build secure developer platforms for thousands of engineers, owning CI, artifact storage and rollout tooling."></head></html>', {
      status: 200, headers: { 'content-type': 'text/html' }
    }),
    now: '2026-08-06T00:00:00.000Z'
  });
  assert.equal(result.job.title, 'Senior Platform Engineer');
  assert.equal(result.job.source, 'user_supplied_url');
  assert.equal(result.job.source_type, 'user_provided_url');
  assert.equal(result.job.provider, 'generic_company_careers');
  assert.equal(result.job.canonical_url, 'https://careers.example.com/jobs/42');
  assert.equal(result.safety.resume_uploaded, false);
});

test('Greenhouse Next metadata extracts job_post_location and infers country', async () => {
  const html = `<!doctype html><html><head>
    <meta property="og:title" content="Product Manager, China">
    <meta property="og:description" content="Beijing">
    </head><body><script>self.__next_f.push([1,"\\\"job_post_location\\\":\\\"Beijing\\\""])</script></body></html>`;
  const result = await ingestPublicJobUrl('https://job-boards.greenhouse.io/example/jobs/8534446002', {
    confirmedPublicFetch: true,
    lookup: publicLookup,
    fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(result.job.location, 'Beijing');
  assert.equal(result.job.country, 'China');
  assert.equal(result.job.source_type, 'user_provided_url');
});

test('URL safety rejects credentials, remote HTTP, private DNS, redirects, and oversized pages', async () => {
  await assert.rejects(validatePublicJobUrl('https://user:secret@example.com/jobs/1', { lookup: publicLookup }), /credentials/i);
  await assert.rejects(validatePublicJobUrl('http://example.com/jobs/1', { lookup: publicLookup }), /HTTPS/i);
  await assert.rejects(validatePublicJobUrl('https://internal.example/jobs/1', {
    lookup: async () => [{ address: '192.168.1.5', family: 4 }]
  }), error => error.code === 'PRIVATE_NETWORK_FORBIDDEN');
  await assert.rejects(ingestPublicJobUrl('https://example.com/jobs/1', {
    confirmedPublicFetch: true, lookup: publicLookup,
    fetchImpl: async () => new Response('', { status: 302 })
  }), error => error.code === 'JOB_PAGE_HTTP_ERROR');
  await assert.rejects(ingestPublicJobUrl('https://example.com/jobs/1', {
    confirmedPublicFetch: true, lookup: publicLookup, maxBytes: 5,
    fetchImpl: async () => new Response('too large', { status: 200, headers: { 'content-type': 'text/html' } })
  }), error => error.code === 'JOB_PAGE_TOO_LARGE');
});

test('URL safety blocks special-use IPv4, IPv6, mapped, and transition addresses', async () => {
  const blockedAddresses = [
    '100.64.0.1',
    '198.18.0.1',
    'fc00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:ac10:0001',
    '64:ff9b::a00:1',
    '2002:0a00:0001::1'
  ];
  for (const address of blockedAddresses) {
    await assert.rejects(validatePublicJobUrl('https://careers.example.com/jobs/1', {
      lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }]
    }), error => error.code === 'PRIVATE_NETWORK_FORBIDDEN');
  }

  const mappedPublic = await validatePublicJobUrl('https://careers.example.com/jobs/1', {
    lookup: async () => [{ address: '::ffff:93.184.216.34', family: 6 }]
  });
  assert.equal(mappedPublic.loopback, false);
});

test('localhost HTTP is supported for the synthetic demo without DNS lookup', async () => {
  let lookupCalled = false;
  const result = await ingestPublicJobUrl('http://127.0.0.1:8767/mock-ats/jobs/123', {
    confirmedPublicFetch: true,
    lookup: async () => { lookupCalled = true; return []; },
    fetchImpl: async () => new Response('<title>Local Demo Analyst</title><p>Synthetic job only</p>', {
      status: 200, headers: { 'content-type': 'text/html' }
    })
  });
  assert.equal(lookupCalled, false);
  assert.equal(result.loopback, true);
  assert.equal(result.job.title, 'Local Demo Analyst');
});

test('Lever job metadata keeps the company slug and remote location from JobPosting data', async () => {
  const html = `<!doctype html><html><head><title>Research Engineer</title>
    <script type="application/ld+json">{
      "@context":"https://schema.org","@type":"JobPosting","title":"Research Engineer",
      "hiringOrganization":{"@type":"Organization","name":"Epoch AI"},
      "jobLocationType":"TELECOMMUTE","applicantLocationRequirements":{"addressCountry":"US"},
      "description":"Build public-interest AI research infrastructure"
    }</script></head></html>`;
  const result = await ingestPublicJobUrl('https://jobs.lever.co/epoch-ai/d172645e-a11f-44a0-88d0-7a989e0a28f6', {
    confirmedPublicFetch: true, lookup: publicLookup,
    fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(result.job.provider, 'lever');
  assert.equal(result.job.company, 'Epoch AI');
  assert.equal(result.job.location, 'Remote — US');
  assert.equal(result.job.title, 'Research Engineer');
});

test('a Lever career board discovers multiple public job-detail links', async () => {
  const html = `<!doctype html><html><head><meta property="og:site_name" content="Example Labs"></head><body>
    <a href="/example-labs/11111111-1111-4111-8111-111111111111"><h5>Platform Engineer</h5></a>
    <a href="https://jobs.lever.co/example-labs/22222222-2222-4222-8222-222222222222">Research Scientist</a>
  </body></html>`;
  const result = await ingestPublicJobUrl('https://jobs.lever.co/example-labs', {
    confirmedPublicFetch: true, lookup: publicLookup,
    fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(result.jobs.length, 2);
  assert.equal(result.jobs[0].company, 'Example Labs');
  assert.equal(result.jobs[0].provider, 'lever');
  assert.equal(result.jobs[0].source, 'user_supplied_career_url');
});

test('Lever career discovery replaces duplicate Apply links with posting metadata', async () => {
  const href = '/epoch-ai/11111111-1111-4111-8111-111111111111';
  const html = `<!doctype html><html><head><title>Epoch AI</title></head><body>
    <a href="${href}">Apply</a>
    <a href="${href}"><h5 data-qa="posting-name">Data Scientist</h5><span class="sort-by-location posting-category location">Remote</span></a>
  </body></html>`;
  const result = await ingestPublicJobUrl('https://jobs.lever.co/epoch-ai', {
    confirmedPublicFetch: true, lookup: publicLookup,
    fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.job.title, 'Data Scientist');
  assert.equal(result.job.company, 'Epoch AI');
  assert.equal(result.job.location, 'Remote');
});

test('a generic company career page discovers same-host public role links', async () => {
  const html = `<!doctype html><html><head><meta property="og:site_name" content="Acme Robotics"></head><body>
    <a href="/careers/jobs/robotics-engineer">Robotics Engineer</a>
    <a href="/about">About us</a>
  </body></html>`;
  const result = await ingestPublicJobUrl('https://careers.example.com/careers', {
    confirmedPublicFetch: true, lookup: publicLookup,
    fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.job.title, 'Robotics Engineer');
  assert.equal(result.job.company, 'Acme Robotics');
});

test('an Apple careers search imports detail links and ignores location-picker navigation', async () => {
  const html = `<!doctype html><html><head><title>Search Jobs - Apple</title></head><body>
    <a href="/en-us/details/114438029/cn-store-leader?team=APPST">CN-Store Leader</a>
    <a href="/en-us/details/114438029/cn-store-leader/locationPicker">Choose another location</a>
    <a href="/en-us/careers/choose-country-region.html">Choose region</a>
  </body></html>`;
  const result = await ingestPublicJobUrl('https://jobs.apple.com/en-us/search?location=china-CHNC', {
    confirmedPublicFetch: true,
    lookup: async () => [{ address: '17.0.0.1' }],
    fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
  });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.job.title, 'CN-Store Leader');
  assert.equal(result.job.company, 'Apple');
  assert.equal(result.job.canonical_url, 'https://jobs.apple.com/en-us/details/114438029/cn-store-leader?team=APPST');
});

test('an Apple public China job detail uses embedded hydration data instead of board links', async () => {
  const jobData = {
    loaderData: {
      root: {},
      jobDetails: {
        jobsData: {
          jobNumber: '200000001-0001',
          postingTitle: 'AI Product Manager',
          jobSummary: 'Lead verified AI product strategy.',
          responsibilities: 'Work across product and engineering.',
          locations: [{ name: 'Shanghai', city: 'Shanghai', stateProvince: 'Shanghai', countryName: 'China' }],
          postingDate: 'August 1, 2026',
          employmentType: 'Standard'
        }
      }
    }
  };
  const encoded = JSON.stringify(JSON.stringify(jobData)).slice(1, -1);
  const html = `<html><head><title>AI Product Manager - Jobs at Apple</title></head><body>
    <a href="/careers/choose-country-region.html">Choose region</a>
    <script>window.__staticRouterHydrationData = JSON.parse("${encoded}");</script>
  </body></html>`;
  const result = await ingestPublicJobUrl('https://jobs.apple.com/en-us/details/200000001-0001/ai-product-manager', {
    confirmedPublicFetch: true,
    lookup: async () => [{ address: '17.0.0.1' }],
    fetchImpl: async () => ({
      ok: true,
      headers: { get: name => name === 'content-type' ? 'text/html' : '' },
      text: async () => html
    })
  });
  assert.equal(result.jobs.length, 1);
  assert.equal(result.job.title, 'AI Product Manager');
  assert.equal(result.job.company, 'Apple');
  assert.match(result.job.location, /Shanghai, Shanghai, China/);
  assert.equal(result.job.import_mode, 'public_metadata_only');
});
