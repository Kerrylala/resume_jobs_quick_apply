import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guard = './tests/offline_test_guard.mjs';

const scenarios = [
  { name: 'package_review_multi_job', repetitions: 5, cyclesPerRun: 2, metric: 'package_create_review_cycles', args: ['--import', guard, '--test', 'tests/multi_job_workflow.test.mjs'] },
  { name: 'session_recovery_restart', repetitions: 10, cyclesPerRun: 1, metric: 'session_create_recover_cancel_restart_cycles', args: ['--import', guard, '--test', 'tests/application_state.test.mjs'] },
  { name: 'executor_selection_and_legacy', repetitions: 5, cyclesPerRun: 2, metric: 'executor_selection_changes_before_execution', args: ['--import', guard, '--test', 'tests/legacy_execution_recovery.test.mjs'] },
  { name: 'safe_fill_retry_state', repetitions: 5, cyclesPerRun: 1, metric: 'safe_fill_state_retry_cycles', args: ['--import', guard, '--test', 'tests/challenge_policy.test.mjs'] },
  { name: 'profile_create_approve', repetitions: 5, cyclesPerRun: 1, metric: 'profile_draft_create_approve_cycles', args: ['--import', guard, '--test', 'tests/product_workflow_e2e.test.mjs'] },
  { name: 'answer_memory', repetitions: 5, cyclesPerRun: 1, metric: 'answer_memory_save_reuse_cycles', args: ['--import', guard, '--test', 'tests/candidate_records.test.mjs'] },
  { name: 'field_memory', repetitions: 5, cyclesPerRun: 1, metric: 'field_memory_mapping_reuse_cycles', args: ['--import', guard, '--test', 'tests/form_field_memory.test.mjs'] },
  { name: 'learning_candidates', repetitions: 5, cyclesPerRun: 1, metric: 'learning_candidate_review_cycles', args: ['--import', guard, '--test', 'tests/learning_candidates.test.mjs'] },
  { name: 'browser_agent_retry_rescan', repetitions: 5, cyclesPerRun: 1, metric: 'local_browser_agent_launch_retry_rescan_cycles', args: ['scripts/test_browser_agent_dashboard_local.mjs'] }
];

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Reliability child exited with code ${code}.`)));
  });
}

const metrics = {};
const completedScenarios = [];
for (const scenario of scenarios) {
  for (let repetition = 1; repetition <= scenario.repetitions; repetition += 1) {
    try {
      await runNode(scenario.args);
    } catch (error) {
      throw new Error(`${scenario.name} repetition ${repetition} failed: ${error.message}`);
    }
  }
  metrics[scenario.metric] = scenario.repetitions * scenario.cyclesPerRun;
  completedScenarios.push({ name: scenario.name, repetitions: scenario.repetitions });
}

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  metrics,
  scenarios: completedScenarios,
  personal_values_logged: false,
  runtime_data_directory_used: false
}, null, 2)}\n`);
