// CI-only process-output collector for the pinned DevSpace Codex tool contract.
// Every exec_command/write_stdin response drains its current output buffer.
// Keep actual output in arrival order, removing only the generated status suffix.
import assert from 'node:assert/strict';

function outputPart(result) {
  assert.ok(result && typeof result.running === 'boolean', 'Missing process state');
  assert.equal(typeof result.result, 'string', 'Missing process output');
  assert.equal(result.output_truncated, false, 'Process output was truncated');
  const status = result.running
    ? `Process running with session ID ${result.session_id}.`
    : result.signal
      ? `Process exited after signal ${result.signal}.`
      : `Process exited with code ${result.exit_code ?? 'unknown'}.`;
  if (result.result === status) return '';
  const suffix = '\n' + status;
  assert.ok(result.result.endsWith(suffix), 'Unexpected DevSpace process result format');
  return result.result.slice(0, -suffix.length);
}

export async function collectCommandResult(initial, poll, { requirePoll = false } = {}) {
  let result = initial;
  const parts = [outputPart(result)];
  let count = 0;
  const sessionId = result.session_id;
  while (result.running && count < 12) {
    assert.ok(Number.isSafeInteger(result.session_id) && result.session_id > 0,
      'Invalid process session ID');
    assert.equal(result.session_id, sessionId, 'Process session changed unexpectedly');
    result = await poll(sessionId);
    count++;
    parts.push(outputPart(result));
  }
  assert.equal(result.running, false, 'Command still running');
  assert.ok(!result.signal, 'Command terminated by signal');
  assert.equal(result.exit_code, 0, 'Command exited unsuccessfully');
  if (requirePoll) assert.ok(count > 0, 'Process polling was not exercised');
  // The tool formatter strips one trailing LF per batch. Do not insert status
  // lines or invented line breaks inside a marker split between batches.
  return { ...result, result: parts.join('') };
}
