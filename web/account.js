'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let csrf = '', invitation = null, busy = false;
  const parameters = new URLSearchParams(location.hash.slice(1));
  if (parameters.has('token_hash')) {
    invitation = {token_hash: parameters.get('token_hash'), type: parameters.get('type'), uid: parameters.get('uid')};
    history.replaceState(null, '', location.pathname);
  }
  const status = (message, error = false) => {
    $('account-status').textContent = message;
    $('account-status').classList.toggle('error', error);
  };
  const show = id => ['login-panel', 'invitation-panel', 'password-panel', 'signed-in-panel', 'owner-panel'].forEach(name => { $(name).hidden = name !== id; });
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
    invitation = null;
    show('signed-in-panel'); $('page-title').textContent = 'Your account';
    $('signed-in-email').textContent = value.email;
    $('login-password').value = ''; $('new-password').value = ''; $('repeat-password').value = '';
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
    if (invitation) { show('invitation-panel'); $('page-title').textContent = 'Your SPOT invitation'; status('Continue to verify your private invitation.'); return; }
    let value;
    try { value = await api('session'); }
    catch (error) { show('login-panel'); status(error.message, true); return; }
    if (value.pending) pendingAccount(value);
    else if (value.authenticated) await signedIn(value);
    else { show('login-panel'); status('Sign in with an invited SPOT account.'); }
  });
})();
