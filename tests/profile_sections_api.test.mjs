// Contract for the online job-seeking profile as a single source of truth.
//
// "My materials" must be able to read and edit every section of the profile,
// and uploading a new resume must be undoable — the product replaces the parse
// source by appending a version, never by overwriting.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the online profile is fully readable, section-editable and undoable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-profile-'));
  const dataDir = path.join(root, 'data');
  const archiveDir = path.join(root, 'archive');
  for (const directory of [dataDir, archiveDir, path.join(root, 'reports'), path.join(root, 'applications'), path.join(root, 'resumes')]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  // Two versions of one profile lineage: v2 is active, v1 is what "undo" returns to.
  const base = {
    family_id: 'career_synthetic',
    name: 'Synthetic Profile',
    state: 'approved',
    user_approved: true,
    approved_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z'
  };
  fs.writeFileSync(path.join(dataDir, 'career_profiles.local.json'), `${JSON.stringify({
    schema_version: '1.0',
    active_profile_id: 'career_synthetic_v2',
    profiles: [
      {
        ...base,
        id: 'career_synthetic_v1',
        version: 1,
        identity: { full_name: 'Synthetic One', email: 'one@example.test', phone: '000', city: 'Shanghai', country: 'China' },
        education: [{ institution: 'Synthetic University', degree: 'BSc' }],
        skills: { programming: ['Python'] }
      },
      {
        ...base,
        id: 'career_synthetic_v2',
        version: 2,
        parent_version_id: 'career_synthetic_v1',
        identity: { full_name: 'Synthetic Two', email: 'two@example.test', phone: '111', city: 'Shanghai', country: 'China' },
        education: [{ institution: 'Synthetic University', degree: 'MSc' }],
        skills: { programming: ['Python'] }
      }
    ]
  }, null, 2)}\n`);

  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RESUME_JOBS_DATA_DIR: dataDir,
      RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'),
      RESUME_JOBS_APPLICATIONS_DIR: path.join(root, 'applications'),
      RESUME_JOBS_ARCHIVE_DIR: archiveDir,
      RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(root, 'resumes'),
      RESUME_JOBS_PROFILE_PATH: path.join(root, 'profile.json')
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dashboard did not start.')), 10000);
      dashboard.stdout.on('data', chunk => {
        if (String(chunk).includes('Dashboard server running')) { clearTimeout(timer); resolve(); }
      });
      dashboard.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited with ${code}.`)); });
    });

    const client = `
      const base = 'http://127.0.0.1:${port}';
      const request = async (url, options={}) => {
        const response = await fetch(base + url, {headers:{'content-type':'application/json'}, ...options});
        return {status: response.status, value: await response.json()};
      };
      const full = await request('/api/profile/full');

      // Undo from the clean seeded state: it must restore the previous version.
      const undone = await request('/api/profile/undo', { method:'POST', body: JSON.stringify({}) });
      const afterUndo = await request('/api/profile/full');

      // A list section is replaced wholesale so entries can be reordered/removed.
      const editedList = await request('/api/application-profile', {
        method:'PUT',
        body: JSON.stringify({ patch: { experience: [
          { company: 'Synthetic Corp', role: 'Engineer', achievements: ['Synthetic achievement'] }
        ] } })
      });

      // An object section merges field by field.
      const editedSkills = await request('/api/application-profile', {
        method:'PUT',
        body: JSON.stringify({ patch: { skills: { ai_tools: ['Synthetic Tool'] } } })
      });

      const empty = await request('/api/application-profile', {
        method:'PUT', body: JSON.stringify({ patch: { not_a_section: { x: 1 } } })
      });

      const afterEdits = await request('/api/profile/full');

      // Undo again: this must roll back only the most recent change.
      const undoneAgain = await request('/api/profile/undo', { method:'POST', body: JSON.stringify({}) });
      const afterSecondUndo = await request('/api/profile/full');

      process.stdout.write(JSON.stringify({
        full: full.value,
        undone_status: undone.status,
        undone: undone.value,
        after_undo: afterUndo.value,
        edited_list_status: editedList.status,
        edited_skills_status: editedSkills.status,
        empty_status: empty.status,
        empty_code: empty.value.code,
        editable_sections: empty.value.editable_sections,
        after_edits: afterEdits.value,
        undone_again_status: undoneAgain.status,
        after_second_undo: afterSecondUndo.value
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], {
      encoding: 'utf8', timeout: 20000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);

    // Every section of the profile is readable in one call.
    assert.equal(outcome.full.has_profile, true);
    assert.deepEqual(
      Object.keys(outcome.full.sections).sort(),
      ['career_goals', 'certifications', 'education', 'experience', 'identity', 'interview_stories',
        'job_preferences', 'languages', 'projects', 'skills'].sort()
    );
    assert.equal(outcome.full.sections.identity.full_name, 'Synthetic Two');
    assert.equal(outcome.full.version.version, 2);
    assert.equal(outcome.full.can_undo, true, 'a profile with an earlier version must be undoable');
    assert.equal(outcome.full.undo_target.version, 1, 'undo targets the immediately previous version');

    // Policy fields are declared "ask every time" so the UI can badge them and
    // the executor never auto-fills them.
    for (const field of ['work_authorization', 'sponsorship', 'salary']) {
      assert.ok(outcome.full.ask_every_time_fields.includes(field), `${field} must be ask-every-time`);
    }

    // Undo from the seeded state restores v1's content wholesale.
    assert.equal(outcome.undone_status, 200);
    assert.equal(outcome.after_undo.sections.identity.full_name, 'Synthetic One');
    assert.equal(outcome.after_undo.sections.education[0].degree, 'BSc');
    assert.ok(
      outcome.after_undo.history.length >= 2,
      'undo must not discard the version it moved away from'
    );

    assert.equal(outcome.edited_list_status, 200, 'list sections must be editable');
    assert.equal(outcome.edited_skills_status, 200, 'object sections must be editable');
    assert.equal(outcome.empty_status, 400, 'a patch touching no known section is rejected');
    assert.equal(outcome.empty_code, 'EMPTY_APPLICATION_PROFILE_PATCH');
    assert.ok(
      outcome.editable_sections.includes('experience') && outcome.editable_sections.includes('skills'),
      'the rejection must name the sections the user can actually edit'
    );

    assert.equal(outcome.after_edits.sections.experience[0].company, 'Synthetic Corp');
    assert.deepEqual(outcome.after_edits.sections.skills.ai_tools, ['Synthetic Tool']);
    assert.deepEqual(
      outcome.after_edits.sections.skills.programming, ['Python'],
      'an object-section patch must merge, not replace the whole section'
    );
    assert.equal(
      outcome.after_edits.approved, false,
      'editing the profile must revoke approval until the user re-approves'
    );

    // A second undo rolls back only the most recent change: the skills edit is
    // reverted while the experience edit that preceded it survives.
    assert.equal(outcome.undone_again_status, 200);
    assert.deepEqual(
      outcome.after_second_undo.sections.skills.ai_tools, [],
      'undo must revert the most recent change'
    );
    assert.equal(
      outcome.after_second_undo.sections.experience[0].company, 'Synthetic Corp',
      'undo must not revert changes older than the most recent one'
    );
    assert.ok(
      fs.readdirSync(archiveDir).some(name => name.startsWith('career_profiles.local.json.')),
      'profile writes must leave a restorable backup'
    );
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
