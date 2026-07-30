'use strict';

// Tester för barnprocess-isoleringen av autoMachine.
//
// Bakgrund: hela pipelinen är synkron filbearbetning och blockerade serverns
// event-loop i 22,6s (mätt i drift 2026-07-30T20:38:32Z — hela körningen, inte
// ett enskilt steg). Den körs nu i en barnprocess.
//
// Testerna prövar KONTRAKTET runt isoleringen, inte pipelinen i sig: att
// dispatchern forkar, skickar rätt argument, returnerar barnets resultat, och
// att parentens tillstånd alltid släpps när barnet fallerar. Den beteendemässiga
// A/B-mätningen (14663ms -> 56ms maxfrysning) görs mot en sandlådekopia med
// riktig data och hör inte hemma i en testsvit.
//
// Både statusfilen och workerfilen pekas om via env, så den riktiga pipelinen
// aldrig startar och prods datakatalog aldrig rörs.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-machine-isolation-'));
const STATUS_FILE = path.join(tmpDir, 'auto-machine-status.json');
const OK_WORKER = path.join(tmpDir, 'ok-worker.js');
const FAIL_WORKER = path.join(tmpDir, 'fail-worker.js');
const SILENT_WORKER = path.join(tmpDir, 'silent-worker.js');

// Stubbe som svarar precis som den riktiga workern, men utan pipeline.
fs.writeFileSync(OK_WORKER, `
process.on('message', (msg) => {
  if (!msg || msg.type !== 'auto_machine_run') return;
  const payload = {
    ok: true, startedAt: '2026-07-30T20:00:00.000Z', finishedAt: '2026-07-30T20:00:10.000Z',
    lookbackDays: msg.lookbackDays, groups: msg.groups, steps: { stub: { ok: true } },
  };
  process.send({ type: 'auto_machine_result', ok: true, payload }, () => process.exit(0));
});
`, 'utf8');

// Stubbe som rapporterar ett fel på samma sätt som den riktiga workern gör.
fs.writeFileSync(FAIL_WORKER, `
process.on('message', (msg) => {
  if (!msg || msg.type !== 'auto_machine_run') return;
  process.send({ type: 'auto_machine_result', ok: false, error: 'stub_pipeline_exploded' },
    () => process.exit(1));
});
`, 'utf8');

// Stubbe som aldrig svarar — prövar timeout-vägen.
fs.writeFileSync(SILENT_WORKER, 'setInterval(() => {}, 1000);\n', 'utf8');

process.env.AUTO_MACHINE_STATUS_FILE = STATUS_FILE;
process.env.AUTO_MACHINE_WORKER_TIMEOUT_MS = '1500';
process.env.AUTO_MACHINE_WORKER_FILE = OK_WORKER;
delete process.env.AUTO_MACHINE_WORKER;

const autoMachine = require('./autoMachine');

function reloadWith(workerFile) {
  process.env.AUTO_MACHINE_WORKER_FILE = workerFile;
  delete require.cache[require.resolve('./autoMachine')];
  return require('./autoMachine');
}

async function main() {
  // 1. Exportytan är intakt — systemHealth.js och api.js hänger på den.
  for (const fn of ['runAutoMachine', 'runAutoMachineInProcess', 'isRunning', 'getStatus']) {
    assert.equal(typeof autoMachine[fn], 'function', `${fn} exporteras`);
  }

  // 2. Den riktiga workerfilen finns där dispatchern letar som default. Utan den
  //    skulle varje körning i drift falla på fork-fel.
  const realWorker = path.resolve(__dirname, './runAutoMachineWorker.js');
  assert.ok(fs.existsSync(realWorker), 'runAutoMachineWorker.js finns');
  assert.equal(typeof require('./runAutoMachineWorker').handleRun, 'function',
    'workern exporterar handleRun');

  // 3. Lyckad väg: dispatchern forkar, skickar argumenten vidare och returnerar
  //    barnets resultat oförändrat.
  {
    const svc = reloadWith(OK_WORKER);
    assert.equal(svc.isRunning(), false, 'inget kör vid start');
    const res = await svc.runAutoMachine({ lookbackDays: 3, groups: ['stocks', 'crypto'] });
    assert.equal(res.ok, true, 'barnets resultat returneras');
    assert.equal(res.lookbackDays, 3, 'lookbackDays når barnet');
    assert.deepEqual(res.groups, ['stocks', 'crypto'], 'groups når barnet');
    assert.deepEqual(res.steps, { stub: { ok: true } }, 'stegen kommer från barnet');
    assert.equal(svc.isRunning(), false, '_running släppt efter lyckad körning');
  }

  // 4. Barnet rapporterar fel: felet ska nå anroparen ärligt. Ingen tyst
  //    fallback till in-process — det skulle återinföra frysningen isoleringen
  //    finns för.
  {
    const svc = reloadWith(FAIL_WORKER);
    const res = await svc.runAutoMachine({ lookbackDays: 1, groups: ['stocks'] });
    assert.equal(res.ok, false, 'fel ger ok:false');
    assert.equal(res.error, 'stub_pipeline_exploded', 'barnets felmeddelande bevaras');
    assert.equal(svc.isRunning(), false, '_running släppt efter fel');
    const status = svc.getStatus();
    assert.equal(status.running, false, 'status running:false efter fel');
    assert.equal(status.error, 'stub_pipeline_exploded', 'felet syns i statusfilen');
  }

  // 5. Timeout: dispatchern får inte hänga, och framför allt får den inte lämna
  //    kvar running:true — en kvarhängande flagga blockerar varje framtida tick
  //    permanent via isRunning()-vakten.
  {
    const svc = reloadWith(SILENT_WORKER);
    const t0 = Date.now();
    const res = await svc.runAutoMachine({ lookbackDays: 1, groups: ['stocks'] });
    const elapsed = Date.now() - t0;
    assert.equal(res.ok, false, 'timeout ger ok:false');
    assert.equal(res.error, 'auto_machine_worker_timeout', 'ärlig felkod');
    assert.ok(elapsed < 30000, `dispatchern gav upp i tid (${elapsed}ms)`);
    assert.equal(svc.isRunning(), false, '_running släppt efter timeout');
    const status = svc.getStatus();
    assert.ok(status, 'statusfil skriven även vid timeout');
    assert.equal(status.running, false, 'status running:false efter timeout');
    assert.ok(status.startedAt && status.finishedAt, 'start- och sluttid satta');
  }

  // 6. Prods datakatalog ska vara helt orörd: inget av ovanstående startade den
  //    riktiga pipelinen.
  const prodStatus = path.resolve(__dirname, '../../data/system/auto-machine-status.json');
  assert.notEqual(path.resolve(STATUS_FILE), prodStatus, 'testet skriver aldrig i prods statusfil');

  console.log('autoMachine.isolation.test.js passed');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });
