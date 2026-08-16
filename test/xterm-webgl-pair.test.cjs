'use strict';

/**
 * The xterm / @xterm/addon-webgl pair must stay compatible.
 *
 * @xterm/addon-webgl is released in lockstep with @xterm/xterm but (as of
 * 0.19.0) declares NO peerDependencies, so npm happily installs a broken
 * pair. 0.19.0 pairs with xterm 5.6's DisposableStore core: its teardown
 * runs `this._terminal._core._store._isDisposed` before restoring the DOM
 * renderer. xterm 5.5.0 has no `_store`, so dispose() ALWAYS threw — the
 * render service kept pointing at the disposed WebGL renderer, which kept a
 * dead GL context alive and produced the "black terminal" panes (see
 * webgl-lease-release.test.cjs for the context-leak side of that bug).
 *
 * The addon cannot instantiate headless (activate() needs a real GL
 * context), so these tests pin the invariant at the source level: whatever
 * private core API the addon's teardown dereferences must exist in the
 * installed @xterm/xterm.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ADDON_LIB = path.join(ROOT, 'node_modules', '@xterm/addon-webgl/lib/addon-webgl.js');
const XTERM_LIB = path.join(ROOT, 'node_modules', '@xterm/xterm/lib/xterm.js');

const addonPkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'node_modules', '@xterm/addon-webgl/package.json'), 'utf8'),
);
const xtermPkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'node_modules', '@xterm/xterm/package.json'), 'utf8'),
);

test('the installed pair matches what package.json declares (no lockfile drift)', () => {
  assert.equal(addonPkg.version, '0.18.0');
  assert.equal(xtermPkg.version, '5.5.0');
});

test('when the addon declares an @xterm/xterm peer range, the installed xterm satisfies it', () => {
  const range = addonPkg.peerDependencies && addonPkg.peerDependencies['@xterm/xterm'];
  if (!range) return; // 0.19+ ships none — the deref test below is the real guard
  // ^5.0.0-style ranges only; the addon never ships anything fancier.
  const match = range.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
  assert.ok(match, `unparsed peer range ${range} — teach this test real semver`);
  const [maj, min] = match.slice(1).map(Number);
  const [xMaj, xMin, xPat] = xtermPkg.version.split('.').map(Number);
  assert.ok(
    xMaj === maj && (xMin > min || (xMin === min && xPat >= 0)),
    `@xterm/xterm@${xtermPkg.version} does not satisfy peer range ${range}`,
  );
});

test('every private core API the addon dereferences exists in the installed xterm core', () => {
  const addonLib = fs.readFileSync(ADDON_LIB, 'utf8');
  const xtermLib = fs.readFileSync(XTERM_LIB, 'utf8');
  // The teardown derefs `this._terminal._core.<api>`; each must be defined on
  // the installed core's Terminal. `_store` is the one that broke dispose().
  for (const api of ['_store', '_renderService', '_createRenderer', '_core']) {
    if (!addonLib.includes(`._core.${api}`) && !addonLib.includes(`_core.${api}`)) continue;
    assert.ok(
      new RegExp(`${api}\\s*[=:]`).test(xtermLib) || xtermLib.includes(`this.${api}`),
      `addon dereferences terminal core API "${api}" but @xterm/xterm@${xtermPkg.version} does not define it — dispose() will throw before restoring the DOM renderer`,
    );
  }
});
