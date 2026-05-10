#!/usr/bin/env node
/**
 * Characterization test for `manage_ai.get_ai_info(blackboardPath)`.
 *
 * Pins the current Blackboard key serialization shape so that future refactors
 * of the BB serialization path in `McpAutomationBridge_AIHandlers.cpp` cannot
 * silently regress the response contract that downstream callers depend on.
 *
 * Run:
 *   npm run build:core
 *   node tests/integration/get_ai_info_characterization.mjs
 *
 * Requires UE editor running with the McpAutomationBridge plugin loaded.
 *
 * Pinned facts (observed against UE 5.7 + current dev):
 *   - Response data lives at `response.structuredContent.result.aiInfo`.
 *   - UE auto-inserts a `SelfActor` key inherited from BlackboardData base, so
 *     `keyCount` is (added keys + 1). This inheritance must be preserved.
 *   - Type strings carry the `BlackboardKeyType_*` prefix (the C++ class name),
 *     not the bare authoring enum (`Bool`/`Object`/`Int`).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const TEST_FOLDER = '/Game/IntegrationTest';
const BB_NAME = 'BB_GetAiInfoCharacterization';
const BB_PATH = `${TEST_FOLDER}/${BB_NAME}`;

const transport = new StdioClientTransport({
  command: 'node',
  args: [path.join(repoRoot, 'dist', 'cli.js')],
  cwd: repoRoot,
});

const client = new Client({ name: 'pr0a-characterization', version: '0.0.1' }, { capabilities: {} });

async function call(toolName, args) {
  const res = await client.callTool({ name: toolName, arguments: args });
  if (res?.isError) {
    const detail = (res?.content?.[0]?.text ?? '').slice(0, 500);
    throw new Error(`Tool ${toolName} returned isError; detail: ${detail}`);
  }
  // MCP server wraps the C++ automation_response in `structuredContent`. The
  // human-readable `content[0].text` is a flat summary, not JSON, so we read
  // structuredContent directly.
  const sc = res?.structuredContent;
  if (!sc) throw new Error(`No structuredContent from ${toolName}`);
  if (sc.success === false) {
    throw new Error(`Tool ${toolName} reported success:false; payload: ${JSON.stringify(sc).slice(0, 500)}`);
  }
  return sc;
}

let exitCode = 0;
try {
  // Connect inside try so a failed connect (transport spawn / MCP handshake) still hits the finally cleanup
  await client.connect(transport);

  // Idempotent setup — best-effort delete of any leftover from prior failed runs
  try { await call('manage_asset', { action: 'delete', path: BB_PATH, force: true }); } catch {}

  // Setup
  // create_folder is best-effort: if /Game/IntegrationTest already exists from a prior
  // test run (or shared with tests/integration.mjs), the call may report success:false
  // which call() converts to a throw — wrap so we tolerate "already exists" silently.
  try { await call('manage_asset', { action: 'create_folder', path: TEST_FOLDER }); } catch {}
  await call('manage_ai', { action: 'create_blackboard_asset', path: TEST_FOLDER, name: BB_NAME });
  await call('manage_ai', { action: 'add_blackboard_key', blackboardPath: BB_PATH, keyName: 'Spotted',       keyType: 'Bool' });
  await call('manage_ai', { action: 'add_blackboard_key', blackboardPath: BB_PATH, keyName: 'TargetActor',   keyType: 'Object', baseObjectClass: 'Actor' });
  await call('manage_ai', { action: 'add_blackboard_key', blackboardPath: BB_PATH, keyName: 'WaypointIndex', keyType: 'Int' });
  await call('manage_ai', { action: 'set_key_instance_synced', blackboardPath: BB_PATH, keyName: 'WaypointIndex', isInstanceSynced: true });

  // Action under test
  const resp = await call('manage_ai', { action: 'get_ai_info', blackboardPath: BB_PATH });

  // Envelope
  assert.equal(resp.success, true, 'structuredContent.success must be true');

  // Access path: structuredContent.result.aiInfo
  const aiInfo = resp.result?.aiInfo;
  assert.ok(aiInfo, 'response must include result.aiInfo for blackboardPath input');

  // Existing top-level fields (must remain bit-identical across PR1a refactor)
  assert.equal(aiInfo.assignedBlackboard, BB_NAME,
    'assignedBlackboard must equal the BB asset name');

  // 3 keys we added + 1 SelfActor inherited from BlackboardData base = 4
  assert.equal(aiInfo.keyCount, 4,
    'keyCount = added keys + 1 SelfActor (inherited from BlackboardData)');

  assert.ok(Array.isArray(aiInfo.blackboardKeys),
    'blackboardKeys must be an array');
  assert.equal(aiInfo.blackboardKeys.length, 4,
    'blackboardKeys array length matches keyCount');

  const byName = (n) => aiInfo.blackboardKeys.find((k) => k.name === n);

  // Per-key shape: name, type ("BlackboardKeyType_*" — the UE C++ class name),
  // instanceSynced. PR1a may add fields (baseClass, entryCategory,
  // parentBlackboard, ...); per-key extra fields are tolerated, the existing
  // three fields must remain unchanged.

  const selfActor = byName('SelfActor');
  assert.ok(selfActor, 'SelfActor key must be present (auto-inserted by UE BlackboardData base)');
  assert.equal(selfActor.name, 'SelfActor');
  assert.equal(selfActor.type, 'BlackboardKeyType_Object');
  assert.equal(selfActor.instanceSynced, false);

  const spotted = byName('Spotted');
  assert.ok(spotted, 'Spotted key must be present');
  assert.equal(spotted.name, 'Spotted');
  assert.equal(spotted.type, 'BlackboardKeyType_Bool');
  assert.equal(spotted.instanceSynced, false);

  const targetActor = byName('TargetActor');
  assert.ok(targetActor, 'TargetActor key must be present');
  assert.equal(targetActor.name, 'TargetActor');
  assert.equal(targetActor.type, 'BlackboardKeyType_Object');
  assert.equal(targetActor.instanceSynced, false);

  const waypointIndex = byName('WaypointIndex');
  assert.ok(waypointIndex, 'WaypointIndex key must be present');
  assert.equal(waypointIndex.name, 'WaypointIndex');
  assert.equal(waypointIndex.type, 'BlackboardKeyType_Int');
  assert.equal(waypointIndex.instanceSynced, true,
    'set_key_instance_synced must have flipped this to true');

  console.log('PASS: get_ai_info BB shape characterization');
} catch (err) {
  console.error('FAIL:', err?.message ?? err);
  if (err?.stack) console.error(err.stack);
  exitCode = 1;
} finally {
  // Teardown — best-effort, do NOT throw if cleanup fails
  try { await call('manage_asset', { action: 'delete', path: BB_PATH, force: true }); } catch {}
  try { await client.close(); } catch {}
}

process.exit(exitCode);
