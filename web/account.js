'use strict';
(() => {
  const RESET_LINK_ERROR = 'This password reset link is invalid or has expired. Request a new email below and open its link in this browser.';
  const RESET_REQUEST_MESSAGE = 'If this address has an eligible SPOT account, a reset email has been requested. Open the email link in this browser.';
  function parseAccountLink(url) {
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (url.pathname === '/account/reset') {
      const query = new URLSearchParams(url.search);
      const codes = query.getAll('code');
      const hasParameters = Boolean(url.search || url.hash);
      const valid = !url.hash && [...query.keys()].every(key => key === 'code') && codes.length === 1 && /^[A-Za-z0-9_-]{1,2048}$/.test(codes[0]);
      return {resetCallback: true, resetCode: valid ? codes[0] : null, invitation: null, error: hasParameters && !valid, clearURL: hasParameters};
    }
    if (fragment.has('access_token') || fragment.has('refresh_token') || fragment.getAll('type').includes('recovery')) {
      return {resetCallback: false, resetCode: null, invitation: null, error: true, clearURL: true};
    }
    return {resetCallback: false, resetCode: null, error: false, clearURL: fragment.has('token_hash'),
      invitation: fragment.has('token_hash') ? {token_hash: fragment.get('token_hash'), type: fragment.get('type'), uid: fragment.get('uid')} : null};
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {parseAccountLink};
  if (typeof document === 'undefined') return;
  // Capture private link data once, then clear the address before any API call.
  const link = parseAccountLink(location);
  if (link.clearURL) history.replaceState(null, '', location.pathname);
  const $ = id => document.getElementById(id);
  let csrf = '', invitation = link.invitation, busy = false;
  const status = (message, error = false) => {
    $('account-status').textContent = message;
    $('account-status').classList.toggle('error', error);
  };
  const show = id => ['login-panel', 'invitation-panel', 'password-panel', 'reset-request-panel', 'reset-password-panel', 'signed-in-panel', 'owner-panel'].forEach(name => { $(name).hidden = name !== id; });
  async function api(path, body) {
    const options = {credentials: 'same-origin', cache: 'no-store', headers: {Accept: 'application/json'}};
    if (body !== undefined) {
      options.method = 'POST';
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify({...body, csrf});
    }
    const response = await fetch('/api/auth/' + path, options);
    const value = await response.json();
    if (value.csrf) csrf = value.csrf;
    if (!response.ok) throw new Error(value.error || 'The account service is unavailable. Please try again.');
    return value;
  }
  async function task(action) {
    if (busy) return;
    busy = true;
    document.querySelectorAll('button').forEach(button => { button.disabled = true; });
    status('Please wait…');
    try { await action(); }
    catch (error) { status(error.message || 'The account request could not be completed.', true); }
    finally { busy = false; document.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  }
  async function viewers() {
    const result = await api('viewers');
    $('viewers-list').replaceChildren();
    for (const person of result.viewers) {
      const row = document.createElement('div'); row.className = 'viewer';
      const details = document.createElement('div'); details.className = 'viewer-details';
      const email = document.createElement('div'); email.className = 'viewer-email'; email.textContent = person.email;
      const state = document.createElement('div'); state.className = 'viewer-state';
      state.textContent = person.is_owner ? 'Owner' : !person.approved ? 'Revoked' : person.password_set ? 'Active' : 'Invitation pending';
      details.append(email, state); row.append(details);
      if (!person.is_owner && person.approved) {
        const revoke = document.createElement('button'); revoke.type = 'button'; revoke.className = 'secondary'; revoke.textContent = 'Revoke SPOT';
        revoke.setAttribute('aria-label', 'Revoke SPOT access for ' + person.email);
        revoke.addEventListener('click', () => task(async () => {
          await api('viewers/' + encodeURIComponent(person.id) + '/revoke', {});
          $('invitation-result').hidden = true; $('invitation-link').value = '';
          await viewers(); status('SPOT access revoked. Their other accounts are unchanged.');
        }));
        row.append(revoke);
      }
      $('viewers-list').append(row);
    }
  }
  async function signedIn(value) {
    invitation = null; link.resetCode = null;
    show('signed-in-panel'); $('page-title').textContent = 'Your account';
    $('signed-in-email').textContent = value.email;
    ['login-password', 'new-password', 'repeat-password', 'reset-new-password', 'reset-repeat-password'].forEach(id => { $(id).value = ''; });
    status('Signed in.');
    if (value.is_owner) { $('owner-panel').hidden = false; await viewers(); }
  }
  function pendingAccount(result) {
    invitation = null; show('password-panel'); $('page-title').textContent = 'Complete your SPOT account';
    $('password-heading').textContent = result.existing_account ? 'Use your existing account password' : 'Choose your password';
    $('password-note').textContent = result.existing_account
      ? 'This email already has an account with our authentication service. Enter that password twice to activate SPOT. Your existing password and COP31 permissions will stay the same.'
      : 'Choose a password for ' + result.email + '. This is your password for this authentication account.';
    $('new-password').autocomplete = result.existing_account ? 'current-password' : 'new-password';
    $('repeat-password').autocomplete = result.existing_account ? 'current-password' : 'new-password';
    $('new-password').minLength = result.existing_account ? 1 : 14;
    $('repeat-password').minLength = result.existing_account ? 1 : 14;
    $('password-length-note').textContent = result.existing_account ? 'Use your existing authentication account password.' : 'Use at least 14 characters.';
    status('Invitation verified. Complete the form below.'); $('new-password').focus();
  }
  function signInPanel() {
    invitation = null; link.resetCode = null;
    ['new-password', 'repeat-password', 'reset-new-password', 'reset-repeat-password'].forEach(id => { $(id).value = ''; });
    show('login-panel'); $('page-title').textContent = 'Sign in'; status('Sign in with an invited SPOT account.'); $('login-email').focus();
  }
  function resetRequest() {
    invitation = null; link.resetCode = null;
    $('login-password').value = '';
    show('reset-request-panel'); $('page-title').textContent = 'Reset your password';
    $('reset-email').value = $('reset-email').value || $('login-email').value;
    status('Open the email link in this browser.'); $('reset-email').focus();
  }
  function pendingReset(result) {
    invitation = null; link.resetCode = null;
    show('reset-password-panel'); $('page-title').textContent = 'Reset your password';
    $('reset-password-note').textContent = 'Choose a new password for ' + result.email + '.';
    status('Reset link verified. Choose your new password below.'); $('reset-new-password').focus();
  }
  $('forgot-password-button').addEventListener('click', resetRequest);
  ['reset-request-back', 'reset-password-back'].forEach(id => $(id).addEventListener('click', signInPanel));
  $('reset-request-form').addEventListener('submit', event => {
    event.preventDefault();
    task(async () => {
      await api('reset-request', {email: $('reset-email').value});
      status(RESET_REQUEST_MESSAGE);
    });
  });
  $('reset-password-form').addEventListener('submit', event => {
    event.preventDefault();
    task(async () => signedIn(await api('reset-password', {password: $('reset-new-password').value, repeat_password: $('reset-repeat-password').value})));
  });
  $('login-form').addEventListener('submit', event => {
    event.preventDefault();
    task(async () => signedIn(await api('login', {email: $('login-email').value, password: $('login-password').value})));
  });
  $('activate-button').addEventListener('click', () => task(async () => {
    const result = await api('activate', invitation);
    pendingAccount(result);
  }));
  $('password-form').addEventListener('submit', event => {
    event.preventDefault();
    task(async () => signedIn(await api('password', {password: $('new-password').value, repeat_password: $('repeat-password').value})));
  });
  $('logout-button').addEventListener('click', () => task(async () => {
    await api('logout', {}); $('invitation-link').value = ''; $('invitation-result').hidden = true;
    $('viewers-list').replaceChildren(); show('login-panel'); $('page-title').textContent = 'Sign in'; status('Signed out.');
  }));
  $('invite-form').addEventListener('submit', event => {
    event.preventDefault();
    task(async () => {
      const result = await api('invite', {email: $('invite-email').value});
      $('invitation-link').value = result.link; $('invitation-result').hidden = false;
      await viewers(); status('Private invitation created. Share the link directly; no email has been sent.');
    });
  });
  $('copy-link').addEventListener('click', () => task(async () => {
    await navigator.clipboard.writeText($('invitation-link').value); status('Private link copied.');
  }));
  task(async () => {
    const config = await api('config');
    if (!config.configured) { show(null); status(config.message); return; }
    if (link.error) { resetRequest(); status(RESET_LINK_ERROR, true); return; }
    if (link.resetCode) {
      const code = link.resetCode; link.resetCode = null;
      try { pendingReset(await api('reset-activate', {code})); }
      catch (_) { resetRequest(); status(RESET_LINK_ERROR, true); }
      return;
    }
    if (invitation) { show('invitation-panel'); $('page-title').textContent = 'Your SPOT invitation'; status('Continue to verify your private invitation.'); return; }
    let value;
    try { value = await api('session'); }
    catch (error) {
      if (link.resetCallback) { resetRequest(); status(RESET_LINK_ERROR, true); }
      else { show('login-panel'); status(error.message, true); }
      return;
    }
    if (value.pending_reset) pendingReset(value);
    else if (value.pending) pendingAccount(value);
    else if (value.authenticated) await signedIn(value);
    else if (link.resetCallback) { resetRequest(); status(RESET_LINK_ERROR, true); }
    else { show('login-panel'); status('Sign in with an invited SPOT account.'); }
  });
})();
