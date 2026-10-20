import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCdpCommand, parseCdpParams } from '../src/policy.js';

test('cdp refuses commands that bypass dedicated actions or URL policy', () => {
  for (const [method, action] of [
    ['Page.navigate', /navigate/],
    ['Page.reload', /reload/],
    ['Page.captureScreenshot', /screenshot/],
    ['Page.startScreencast', /screenshot/],
    ['Input.dispatchKeyEvent', /press/],
    ['DOM.setFileInputFiles', /upload/],
    ['Page.setDownloadBehavior', /download/],
    ['Page.handleJavaScriptDialog', /dialog/],
  ])
    assert.throws(
      () => checkCdpCommand(method, { url: 'file:///etc/passwd' }),
      action,
    );
});
test('cdp refuses partition-wide cookie access and guest lifetime control', () => {
  for (const method of [
    'Network.getCookies',
    'Network.getAllCookies',
    'Network.setCookie',
    'Network.clearBrowserCookies',
    'Network.loadNetworkResource',
    'Page.close',
    'Page.crash',
  ])
    assert.throws(() => checkCdpCommand(method), /not permitted/);
  assert.throws(
    () =>
      checkCdpCommand('Page.createIsolatedWorld', {
        grantUniveralAccess: true,
      }),
    /universal access/,
  );
});
test('cdp refuses browser and target domains but allows page-level inspection', () => {
  for (const method of [
    'Target.createTarget',
    'Browser.close',
    'Storage.clearDataForOrigin',
    'SystemInfo.getInfo',
    'Page',
    '',
    undefined,
  ])
    assert.throws(() => checkCdpCommand(method), /Unsupported CDP domain/);
  for (const method of [
    'Runtime.evaluate',
    'DOM.getDocument',
    'Network.getResponseBody',
    'Page.printToPDF',
    'Accessibility.getFullAXTree',
  ])
    assert.deepEqual(checkCdpCommand(method, { a: 1 }), { a: 1 });
});
test('cdp params must be a JSON object', () => {
  assert.deepEqual(parseCdpParams(undefined), {});
  assert.deepEqual(parseCdpParams('{"depth":2}'), { depth: 2 });
  for (const bad of ['[1]', 'null', '3', '{oops'])
    assert.throws(() => parseCdpParams(bad), /JSON object/);
});
