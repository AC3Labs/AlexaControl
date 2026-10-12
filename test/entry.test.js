'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ids = require('../src/ids');
const { REGIONS } = require('../src/regions');
const { buildZip } = require('../scripts/package');
const { tempDir } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');
const entry = JSON.parse(fs.readFileSync(path.join(ROOT, 'entry.tp'), 'utf8'));
const category = entry.categories[0];

test('entry.tp targets API 10 (Touch Portal 4.3+) and starts the plugin with node', () => {
  assert.equal(entry.api, 10);
  assert.equal(entry.id, ids.PLUGIN_ID);
  assert.match(entry.plugin_start_cmd_windows, /%TP_PLUGIN_FOLDER%AlexaControl\\src\\index\.js/);
  for (const key of ['actions', 'events', 'states']) assert.ok(Array.isArray(category[key]), `${key} is required by the docs`);
});

test('every action, state, connector, event and setting id matches src/ids.js', () => {
  assert.deepEqual(category.actions.map((a) => a.id).sort(), Object.values(ids.ACTIONS).sort());
  assert.deepEqual(category.states.map((s) => s.id).sort(), Object.values(ids.STATES).sort());
  assert.deepEqual(category.connectors.map((c) => c.id), Object.values(ids.CONNECTORS));
  assert.deepEqual(category.events.map((e) => e.id), Object.values(ids.EVENTS));
  assert.deepEqual(entry.settings.map((s) => s.name).sort(), Object.values(ids.SETTINGS).sort());

  const dataIds = new Set(Object.values(ids.DATA));
  const used = [...category.actions, ...category.connectors].flatMap((a) => a.data.map((d) => d.id));
  for (const id of used) assert.ok(dataIds.has(id), `unknown data id ${id}`);
});

test('every action is communicate-type with valid lines that reference its own data', () => {
  const subIds = new Set(category.subCategories.map((s) => s.id));
  for (const action of category.actions) {
    assert.equal(action.type, 'communicate', action.id);
    assert.ok(subIds.has(action.subCategoryId), `${action.id} sub category`);
    const lines = action.lines.action.find((l) => l.language === 'default');
    assert.ok(lines && lines.data.length > 0, `${action.id} needs default lines`);
    const referenced = lines.data.flatMap((l) => [...l.lineFormat.matchAll(/\{\$([^$]+)\$\}/g)].map((m) => m[1]));
    assert.deepEqual(referenced.sort(), action.data.map((d) => d.id).sort(), `${action.id} lines and data disagree`);
  }
});

test('connection event and state list the same values as the code', () => {
  const values = Object.values(ids.CONNECTION);
  assert.deepEqual(category.events[0].valueChoices, values);
  assert.deepEqual(category.states.find((s) => s.id === ids.STATES.CONNECTION).valueChoices, values);
});

test('region choices in entry.tp match src/regions.js', () => {
  const setting = entry.settings.find((s) => s.name === ids.SETTINGS.REGION);
  assert.deepEqual(setting.choices, REGIONS.map((r) => r.label));
  assert.equal(entry.settings.find((s) => s.name === ids.SETTINGS.VM_TOKEN).isPassword, true);
});

test('no em-dashes in README, entry.tp or source comments', () => {
  const files = ['README.md', 'entry.tp', ...['src', 'src/alexa', 'scripts', 'test'].flatMap((d) => fs.readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.js')).map((f) => `${d}/${f}`))];
  for (const f of files) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) assert.ok(!fs.readFileSync(p, 'utf8').includes(String.fromCharCode(0x2014)), `em-dash in ${f}`);
  }
});

test('zip writer output has one root folder and opens with a standard unzip tool', (t) => {
  const zip = buildZip('AlexaControl', [
    { name: 'AlexaControl/entry.tp', data: Buffer.from('{"api":10}'), mtime: new Date() },
    { name: 'AlexaControl/src/index.js', data: Buffer.from('console.log("hi")\n'.repeat(50)), mtime: new Date() },
  ]);
  const file = path.join(tempDir(), 'test.tpp');
  fs.writeFileSync(file, zip);
  let python = null;
  for (const cmd of ['python3', 'python']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore' });
      python = cmd;
      break;
    } catch {
      // try next
    }
  }
  if (!python) {
    t.skip('python not available to cross-check the zip');
    return;
  }
  const out = execFileSync(python, ['-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print("\\n".join(z.namelist())); print(z.read("AlexaControl/entry.tp").decode())`, file]).toString();
  assert.match(out, /^AlexaControl\/\nAlexaControl\/entry\.tp\nAlexaControl\/src\/index\.js\n\{"api":10\}/);
});
