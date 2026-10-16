'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {parseAccountLink} = require('../web/account.js');
const source = fs.readFileSync(path.join(__dirname, '../web/account.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../web/account.html'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function locationFor(value) {
  const url = new URL(value, 'https://spot.example');
  return {pathname: url.pathname, search: url.search, hash: url.hash};
}
function browser(url, replies) {
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], {
    hidden: true, value: '', textContent: '', disabled: false, listeners: {},
    classList: {toggle() {}}, focus() {}, replaceChildren() {}, append() {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
  }]));
  const location = locationFor(url), events = [];
  const document = {getElementById: id => elements.get(id), querySelectorAll: () => [...elements.values()]};
  const context = {
    URLSearchParams, document, location,
    history: {replaceState(_state, _unused, clean) {
      events.push({type: 'clear', path: clean}); location.search = ''; location.hash = '';
    }},
    async fetch(requestPath, options) {
      const route = requestPath.replace('/api/auth/', '');
      events.push({type: 'request', route, options, body: options.body ? JSON.parse(options.body) : null, search: location.search, hash: location.hash});
      assert.ok(Object.hasOwn(replies, route), 'Unexpected request to ' + route);
      const reply = replies[route];
      return {ok: !reply.failure, json: async () => reply};
    },
  };
  vm.runInNewContext(source, context, {filename: 'account.js'});
  return {elements, events, async fire(id, type = 'click') {
    elements.get(id).listeners[type]({preventDefault() {}}); await settle();
  }};
}

test('only a single bounded code on the fixed reset callback is accepted', () => {
  const valid = parseAccountLink(locationFor('/account/reset?code=code_123-ABC'));
  assert.equal(valid.resetCode, 'code_123-ABC'); assert.equal(valid.clearURL, true);
  for (const url of ['/account/reset?code=a&code=b', '/account/reset?code=a&next=elsewhere',
    '/account/reset?error=denied&error_description=private', '/account/reset?code=',
    '/account/reset?code=a%2Fb', '/account/reset?code=' + 'a'.repeat(2049),
    '/account/reset?code=a#fragment', '/account/reset#access_token=private&type=recovery',
    '/account/reset#token_hash=private&type=recovery']) {
    const result = parseAccountLink(locationFor(url));
    assert.equal(result.resetCode, null, url); assert.equal(result.error, true, url); assert.equal(result.clearURL, true, url);
  }
  assert.equal(parseAccountLink(locationFor('/account?code=elsewhere')).resetCode, null);
});

test('raw recovery fragments are rejected while private invitation fields are preserved', () => {
  for (const url of ['/account#access_token=private&type=recovery', '/account#token_hash=private&type=recovery',
    '/account#token_hash=private&type=invite&type=recovery', '/account#refresh_token=private']) {
    const result = parseAccountLink(locationFor(url));
    assert.equal(result.invitation, null); assert.equal(result.error, true); assert.equal(result.clearURL, true);
  }
  const result = parseAccountLink(locationFor('/account#token_hash=invite-123&type=spot_existing&uid=user-123'));
  assert.deepEqual(result.invitation, {token_hash: 'invite-123', type: 'spot_existing', uid: 'user-123'});
  assert.equal(result.error, false); assert.equal(result.clearURL, true);
});

test('reset callback clears the URL before network and routes its form to reset-password', async () => {
  const page = browser('/account/reset?code=fixture-code', {
    config: {configured: true, csrf: 'csrf-config'},
    'reset-activate': {pending_reset: true, email: 'fixture@example.org', csrf: 'csrf-reset'},
    'reset-password': {authenticated: true, email: 'fixture@example.org', is_owner: false, csrf: 'csrf-ready'},
  });
  await settle();
  assert.equal(page.events[0].type, 'clear');
  const requests = page.events.filter(event => event.type === 'request');
  assert.deepEqual(requests.map(event => event.route), ['config', 'reset-activate']);
  requests.forEach(event => { assert.equal(event.search, ''); assert.equal(event.hash, ''); assert.equal(event.options.credentials, 'same-origin'); });
  assert.deepEqual(requests[1].body, {code: 'fixture-code', csrf: 'csrf-config'});
  assert.equal(page.elements.get('reset-password-panel').hidden, false);
  page.elements.get('reset-new-password').value = 'a fixture password only';
  page.elements.get('reset-repeat-password').value = 'a fixture password only';
  await page.fire('reset-password-form', 'submit');
  assert.deepEqual(page.events.at(-1).body, {password: 'a fixture password only', repeat_password: 'a fixture password only', csrf: 'csrf-reset'});
  assert.equal(page.events.at(-1).route, 'reset-password');
  assert.equal(page.elements.get('signed-in-panel').hidden, false);
  assert.equal(page.elements.get('reset-new-password').value, '');
});

test('callback failures and raw recovery fragments show fixed text without provider data', async () => {
  const page = browser('/account/reset?code=fixture-code', {
    config: {configured: true, csrf: 'csrf-config'},
    'reset-activate': {failure: true, error: 'PRIVATE upstream response and fixture-code'},
  });
  await settle();
  assert.equal(page.elements.get('reset-request-panel').hidden, false);
  assert.match(page.elements.get('account-status').textContent, /invalid or has expired/);
  assert.doesNotMatch(page.elements.get('account-status').textContent, /PRIVATE|fixture-code|upstream/);
  const rejected = browser('/account#token_hash=PRIVATE&type=recovery', {config: {configured: true, csrf: 'csrf-config'}});
  await settle();
  assert.deepEqual(rejected.events.filter(event => event.type === 'request').map(event => event.route), ['config']);
  assert.equal(rejected.events[0].type, 'clear');
  assert.equal(rejected.elements.get('reset-request-panel').hidden, false);
  assert.doesNotMatch(rejected.elements.get('account-status').textContent, /PRIVATE/);
  const expired = browser('/account/reset', {config: {configured: true, csrf: 'csrf-config'}, session: {failure: true, error: 'PRIVATE session response'}});
  await settle();
  assert.equal(expired.elements.get('reset-request-panel').hidden, false);
  assert.doesNotMatch(expired.elements.get('account-status').textContent, /PRIVATE/);
});

test('forgot-password requests use generic text and pending reset sessions resume', async () => {
  const page = browser('/account', {
    config: {configured: true, csrf: 'csrf-config'}, session: {authenticated: false, csrf: 'csrf-session'},
    'reset-request': {message: 'PRIVATE response must not replace the fixed confirmation', csrf: 'csrf-request'},
  });
  await settle();
  page.elements.get('login-email').value = 'fixture@example.org';
  await page.fire('forgot-password-button');
  assert.equal(page.elements.get('reset-email').value, 'fixture@example.org');
  await page.fire('reset-request-form', 'submit');
  assert.deepEqual(page.events.at(-1).body, {email: 'fixture@example.org', csrf: 'csrf-session'});
  assert.equal(page.events.at(-1).route, 'reset-request');
  assert.match(page.elements.get('account-status').textContent, /If this address has an eligible SPOT account/);
  assert.doesNotMatch(page.elements.get('account-status').textContent, /PRIVATE/);
  await page.fire('reset-request-back'); assert.equal(page.elements.get('login-panel').hidden, false);
  const resumed = browser('/account/reset', {config: {configured: true, csrf: 'csrf-config'}, session: {pending_reset: true, email: 'fixture@example.org', csrf: 'csrf-resumed'}});
  await settle(); assert.equal(resumed.elements.get('reset-password-panel').hidden, false);
});

test('normal login and invitation password forms retain their original API routes', async () => {
  const login = browser('/account', {config: {configured: true, csrf: 'csrf-config'}, session: {authenticated: false}, login: {authenticated: true, email: 'fixture@example.org', is_owner: false}});
  await settle();
  login.elements.get('login-email').value = 'fixture@example.org'; login.elements.get('login-password').value = 'fixture only';
  await login.fire('login-form', 'submit'); assert.equal(login.events.at(-1).route, 'login');
  assert.equal(login.elements.get('signed-in-panel').hidden, false);
  const invited = browser('/account#token_hash=fixture-invite&type=spot_existing&uid=fixture-user', {
    config: {configured: true, csrf: 'csrf-config'},
    activate: {pending: true, existing_account: true, email: 'fixture@example.org', csrf: 'csrf-pending'},
    password: {authenticated: true, email: 'fixture@example.org', is_owner: false},
  });
  await settle(); assert.equal(invited.elements.get('invitation-panel').hidden, false);
  await invited.fire('activate-button');
  assert.deepEqual(invited.events.at(-1).body, {token_hash: 'fixture-invite', type: 'spot_existing', uid: 'fixture-user', csrf: 'csrf-config'});
  assert.equal(invited.elements.get('new-password').minLength, 1);
  invited.elements.get('new-password').value = 'existing fixture'; invited.elements.get('repeat-password').value = 'existing fixture';
  await invited.fire('password-form', 'submit'); assert.equal(invited.events.at(-1).route, 'password');
  assert.equal(invited.elements.get('signed-in-panel').hidden, false);
});
