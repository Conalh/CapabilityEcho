import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPythonDeps } from '../dist/detectors/python-deps.js';
import { makeOldNewFixture } from 'agent-gov-core/test-utils';

async function makeFixture(oldFiles, newFiles) {
  const fx = await makeOldNewFixture({ old: oldFiles, new: newFiles });
  return { oldRoot: fx.old, newRoot: fx.new, cleanup: fx.cleanup };
}

test('flags newly added high-capability dep in requirements.txt', async () => {
  const fixture = await makeFixture(
    { 'requirements.txt': 'flask==3.0.0\n' },
    { 'requirements.txt': 'flask==3.0.0\nrequests==2.31.0\n' }
  );
  try {
    const findings = await detectPythonDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.subject === 'requests');
    assert.ok(f, 'requests not flagged');
    assert.equal(f.kind, 'capability_echo.high_capability_dep_added');
    assert.equal(f.severity, 'high');
    assert.equal(f.line, 2);
  } finally {
    await fixture.cleanup();
  }
});

test('does not flag pre-existing requirements.txt deps', async () => {
  const fixture = await makeFixture(
    { 'requirements.txt': 'requests==2.31.0\n' },
    { 'requirements.txt': 'requests==2.31.0\nflask==3.0.0\n' }
  );
  try {
    const findings = await detectPythonDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.equal(findings.find((f) => f.subject === 'requests'), undefined);
  } finally {
    await fixture.cleanup();
  }
});

test('normalizes PEP-503 names so underscore vs dash variants match', async () => {
  const fixture = await makeFixture(
    { 'requirements.txt': 'sentry_sdk==1.0\n' },
    { 'requirements.txt': 'sentry-sdk==1.0\nrequests==2.31.0\n' }
  );
  try {
    const findings = await detectPythonDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.equal(findings.find((f) => f.subject === 'sentry-sdk'), undefined, 'pre-existing dep flagged after rename');
    assert.ok(findings.find((f) => f.subject === 'requests'));
  } finally {
    await fixture.cleanup();
  }
});

test('ignores comments and pip options in requirements.txt', async () => {
  const fixture = await makeFixture(
    { 'requirements.txt': '' },
    { 'requirements.txt': '# requests is for the API\n--index-url https://pypi.example.com\n-r constraints.txt\nflask==3.0.0\n' }
  );
  try {
    const findings = await detectPythonDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.equal(findings.length, 0, `expected no findings, got: ${JSON.stringify(findings)}`);
  } finally {
    await fixture.cleanup();
  }
});

test('extracts dep name from #egg= VCS install', async () => {
  const fixture = await makeFixture(
    { 'requirements.txt': '' },
    { 'requirements.txt': '-e git+https://github.com/example/requests.git@v1#egg=requests\n' }
  );
  try {
    const findings = await detectPythonDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.ok(findings.find((f) => f.subject === 'requests'));
  } finally {
    await fixture.cleanup();
  }
});

test('flags telemetry deps at medium', async () => {
  const fixture = await makeFixture(
    { 'requirements.txt': '' },
    { 'requirements.txt': 'sentry-sdk==1.0\n' }
  );
  try {
    const findings = await detectPythonDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.kind === 'capability_echo.telemetry_dep_added');
    assert.ok(f);
    assert.equal(f.severity, 'medium');
  } finally {
    await fixture.cleanup();
  }
});

test('flags PEP 621 [project] deps in pyproject.toml', async () => {
  const oldPy = `[project]\nname = "app"\ndependencies = ["flask>=3"]\n`;
  const newPy = `[project]\nname = "app"\ndependencies = [\n  "flask>=3",\n  "requests==2.31.0",\n]\n`;
  const fixture = await makeFixture(
    { 'pyproject.toml': oldPy },
    { 'pyproject.toml': newPy }
  );
  try {
    const findings = await detectPythonDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.subject === 'requests');
    assert.ok(f);
    assert.equal(f.line, 5);
  } finally {
    await fixture.cleanup();
  }
});

test('flags PEP 621 optional-dependencies in pyproject.toml', async () => {
  const oldPy = `[project]\nname = "app"\ndependencies = ["flask"]\n`;
  const newPy = `[project]\nname = "app"\ndependencies = ["flask"]\n[project.optional-dependencies]\nbrowser = ["playwright"]\n`;
  const fixture = await makeFixture(
    { 'pyproject.toml': oldPy },
    { 'pyproject.toml': newPy }
  );
  try {
    const findings = await detectPythonDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.ok(findings.find((f) => f.subject === 'playwright'));
  } finally {
    await fixture.cleanup();
  }
});

test('flags Poetry [tool.poetry.dependencies]', async () => {
  const oldPy = `[tool.poetry.dependencies]\npython = "^3.11"\nflask = "^3.0"\n`;
  const newPy = `[tool.poetry.dependencies]\npython = "^3.11"\nflask = "^3.0"\nhttpx = "^0.27"\n`;
  const fixture = await makeFixture(
    { 'pyproject.toml': oldPy },
    { 'pyproject.toml': newPy }
  );
  try {
    const findings = await detectPythonDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.subject === 'httpx');
    assert.ok(f);
    assert.equal(f.line, 4);
    assert.ok(!findings.find((f) => f.subject === 'python'), 'python pin should not be a dep finding');
  } finally {
    await fixture.cleanup();
  }
});

test('flags Pipfile [packages]', async () => {
  const oldPi = `[packages]\nflask = "*"\n`;
  const newPi = `[packages]\nflask = "*"\nrequests = "*"\n`;
  const fixture = await makeFixture(
    { 'Pipfile': oldPi },
    { 'Pipfile': newPi }
  );
  try {
    const findings = await detectPythonDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.subject === 'requests');
    assert.ok(f);
    assert.equal(f.line, 3);
  } finally {
    await fixture.cleanup();
  }
});

test('scans nested requirements/*.txt files', async () => {
  const fixture = await makeFixture(
    { 'requirements/base.txt': 'flask==3.0\n' },
    { 'requirements/base.txt': 'flask==3.0\nrequests==2.31.0\n' }
  );
  try {
    const findings = await detectPythonDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    const f = findings.find((finding) => finding.subject === 'requests');
    assert.ok(f);
    assert.equal(f.file, 'requirements/base.txt');
  } finally {
    await fixture.cleanup();
  }
});

test('ignores benign Python deps', async () => {
  const fixture = await makeFixture(
    { 'requirements.txt': 'flask==3.0\n' },
    { 'requirements.txt': 'flask==3.0\nclick==8.1\nrich==13.0\n' }
  );
  try {
    const findings = await detectPythonDeps({ mode: 'directories', oldRoot: fixture.oldRoot, newRoot: fixture.newRoot });
    assert.equal(findings.length, 0);
  } finally {
    await fixture.cleanup();
  }
});
