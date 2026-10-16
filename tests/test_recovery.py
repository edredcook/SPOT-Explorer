"""PKCE password-recovery boundaries, without real accounts or email delivery."""
from __future__ import annotations

import base64
import copy
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit
import uuid

from flask import Flask

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from spot_auth import (AuthError, NAMESPACE, RESET_LINK_ERROR, RESET_REQUEST_MESSAGE,
                       SpotAccounts, SupabaseProvider, account_state, register_auth)
from test_auth import FakeProvider, PASSWORD

NEW_PASSWORD = 'the new independently chosen password'


class FakeRecoveryProvider(FakeProvider):
    """Reusable localhost QA fixture. ``recovery_mail[-1]['code']`` is fake mail.

    Implements the real S256 challenge/verifier comparison. It never contacts
    Supabase or sends mail. The parent fixture retains real metadata adapter
    and account-check code, replacing only HTTP transport.
    """
    def __init__(self):
        super().__init__()
        self.recovery_mail, self.recovery_codes = [], {}
        self.recover_error = None
        self.exchange_uid = None
        self.exchange_type = 'bearer'

    def payload(self, user):
        value = super().payload(user)
        value['token_type'] = self.exchange_type
        return value

    def call(self, method, path, body=None, *, admin=False, token=None):
        if path.startswith('/recover?'):
            self.events.append((method, '/recover'))
            if self.recover_error:
                raise self.recover_error
            user = next(u for u in self.records.values() if u['email'] == body['email'])
            code = 'fixture-reset-' + uuid.uuid4().hex
            mail = {'email': body['email'], 'uid': user['id'], 'code': code,
                    'challenge': body['code_challenge'], 'method': body['code_challenge_method'],
                    'redirect': parse_qs(urlsplit(path).query)['redirect_to'][0]}
            self.recovery_mail.append(mail)
            self.recovery_codes[code] = mail
            return {}
        if path == '/token?grant_type=pkce':
            self.events.append((method, path))
            mail = self.recovery_codes.pop(body['auth_code'], None)
            computed = base64.urlsafe_b64encode(sha256(body['code_verifier'].encode('ascii')).digest()).rstrip(b'=').decode('ascii')
            if not mail or mail['method'] != 's256' or computed != mail['challenge']:
                raise AuthError('Invalid fixture PKCE exchange.', 401)
            return self.payload(self.records[self.exchange_uid or mail['uid']])
        return super().call(method, path, body, admin=admin, token=token)


class RecoveryBoundaries(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'SPOT_AUTH_LOCAL_PREVIEW': '1', 'SPOT_PUBLIC_ORIGIN': 'http://localhost'})
        self.env.start()
        self.now = [10000]
        self.provider = FakeRecoveryProvider()
        self.cop31 = {'approved': True, 'password_set': True, 'download_access': False, 'auth_version': 'c' * 24}
        self.owner = self.provider.add_user('owner@example.org', metadata={'cop31_mfa': self.cop31})
        self.manager = SpotAccounts(self.provider, self.owner['email'], clock=lambda: self.now[0])
        self.app = Flask(__name__)
        self.app.config.update(TESTING=True, SPOT_ACCOUNT_MANAGER=self.manager)
        register_auth(self.app)
        self.client = self.app.test_client()
        self.csrf = self.client.get('/api/auth/config').json['csrf']

    def tearDown(self):
        self.env.stop()

    def post(self, path, body=None, *, client=None, csrf=None):
        result = (client or self.client).post('/api/auth/' + path,
                                             json={**(body or {}), 'csrf': csrf or self.csrf},
                                             headers={'Origin': 'http://localhost'})
        if client is None and result.is_json and result.json.get('csrf'):
            self.csrf = result.json['csrf']
        return result

    def request_reset(self, email=None):
        result = self.post('reset-request', {'email': email or self.owner['email']})
        self.assertEqual(result.status_code, 200, result.json)
        return result

    def activate_reset(self, email=None):
        self.request_reset(email)
        result = self.post('reset-activate', {'code': self.provider.recovery_mail[-1]['code']})
        self.assertEqual(result.status_code, 200, result.json)
        return result

    def add_spot_user(self, email='viewer@example.org'):
        return self.provider.add_user(email, metadata={'cop31_mfa': self.cop31,
            NAMESPACE: {'approved': True, 'password_set': True, 'auth_version': 's' * 24, 'custom_permission': False}})

    def test_pkce_challenge_browser_binding_and_fixed_redirect(self):
        result = self.request_reset()
        self.assertEqual(result.json['message'], RESET_REQUEST_MESSAGE)
        mail = self.provider.recovery_mail[-1]
        self.assertEqual(mail['method'], 's256')
        self.assertEqual(mail['redirect'], 'http://localhost/account/reset')
        self.assertRegex(mail['challenge'], r'^[A-Za-z0-9_-]{43}$')
        with self.client.session_transaction() as browser:
            recovery = self.manager.recoveries[browser['spot_recovery']]
            self.assertEqual(recovery.uid, self.owner['id'])
            self.assertRegex(recovery.verifier, r'^[A-Za-z0-9_-]{43,128}$')
            self.assertNotIn(recovery.verifier, str(dict(browser)))
        outsider = self.app.test_client()
        csrf = outsider.get('/api/auth/config').json['csrf']
        denied = self.post('reset-activate', {'code': mail['code']}, client=outsider, csrf=csrf)
        self.assertEqual(denied.status_code, 401)
        self.assertIn(mail['code'], self.provider.recovery_codes)
        accepted = self.post('reset-activate', {'code': mail['code']})
        self.assertEqual(accepted.status_code, 200)
        self.assertNotIn('access_token', str(accepted.json))
        self.assertNotIn('code_verifier', str(accepted.json))
        self.assertNotIn(('POST', '/verify'), self.provider.events)

    def test_unknown_ineligible_and_mail_failure_have_same_public_reply(self):
        unknown = self.request_reset('unknown@example.org')
        pending = self.provider.add_user('pending@example.org', confirmed=False)
        unconfirmed = self.request_reset(pending['email'])
        foreign = self.provider.add_user('cop31-only@example.org', metadata={'cop31_mfa': self.cop31})
        ineligible = self.request_reset(foreign['email'])
        self.assertEqual(self.provider.recovery_mail, [])
        self.provider.recover_error = AuthError('private upstream body owner@example.org password-secret', 401)
        with self.assertLogs('spot_auth', level='WARNING') as captured:
            failed = self.request_reset()
        self.assertEqual([r.json['message'] for r in (unknown, unconfirmed, ineligible, failed)], [RESET_REQUEST_MESSAGE] * 4)
        self.assertEqual([set(r.json) for r in (unknown, unconfirmed, ineligible, failed)], [{'message', 'csrf'}] * 4)
        log = ' '.join(captured.output)
        self.assertIn('operation=recover status=401', log)
        self.assertNotIn(self.owner['email'], log)
        self.assertNotIn('password-secret', log)
        self.assertNotIn('private upstream', log)

    def test_reset_request_never_creates_accounts_or_changes_permissions(self):
        before = copy.deepcopy(self.provider.records)
        self.request_reset()
        self.assertEqual(before, self.provider.records)
        self.assertNotIn(('POST', '/admin/generate_link'), self.provider.events)

    def test_no_ready_or_owner_access_until_new_password_is_saved(self):
        result = self.activate_reset()
        self.assertFalse(result.json['authenticated'])
        self.assertTrue(result.json['pending_reset'])
        current = self.client.get('/api/auth/session')
        self.assertTrue(current.json['pending_reset'])
        self.assertFalse(current.json['authenticated'])
        self.assertEqual(self.client.get('/api/auth/viewers').status_code, 401)
        with self.client.session_transaction() as browser:
            self.assertNotIn('spot_handle', browser)
            self.assertEqual(self.manager.sessions[browser['spot_reset']].stage, 'reset')

    def test_owner_recovery_bootstraps_spot_and_preserves_cop31(self):
        before = copy.deepcopy(self.owner['app_metadata']['cop31_mfa'])
        self.activate_reset()
        result = self.post('reset-password', {'password': NEW_PASSWORD, 'repeat_password': NEW_PASSWORD})
        self.assertEqual(result.status_code, 200, result.json)
        self.assertTrue(result.json['authenticated'])
        self.assertTrue(result.json['is_owner'])
        self.assertEqual(self.owner['password'], NEW_PASSWORD)
        self.assertEqual(before, self.owner['app_metadata']['cop31_mfa'])
        self.assertTrue(account_state(self.owner)['password_set'])
        self.assertEqual(self.client.get('/api/auth/viewers').status_code, 200)
        self.assertIn(('PUT', '/user'), self.provider.events)
        self.assertEqual(self.manager.recoveries, {})
        self.assertTrue(all(record.stage == 'ready' for record in self.manager.sessions.values()))

    def test_existing_permissions_preserved_and_old_spot_sessions_invalidated(self):
        user = self.add_spot_user()
        before = copy.deepcopy(user['app_metadata'])
        handle, _ = self.manager.new_session(self.provider.payload(user))
        self.activate_reset(user['email'])
        result = self.post('reset-password', {'password': NEW_PASSWORD, 'repeat_password': NEW_PASSWORD})
        self.assertEqual(result.status_code, 200, result.json)
        self.assertFalse(result.json['is_owner'])
        self.assertEqual(before['cop31_mfa'], user['app_metadata']['cop31_mfa'])
        current = account_state(user)
        self.assertNotEqual(before[NAMESPACE]['auth_version'], current['auth_version'])
        self.assertEqual({k: v for k, v in before[NAMESPACE].items() if k != 'auth_version'},
                         {k: v for k, v in current.items() if k != 'auth_version'})
        with self.assertRaises(AuthError):
            self.manager.validate(handle)

    def test_wrong_identity_token_type_and_verifier_cannot_activate(self):
        self.request_reset()
        other = self.add_spot_user()
        self.provider.exchange_uid = other['id']
        result = self.post('reset-activate', {'code': self.provider.recovery_mail[-1]['code']})
        self.assertEqual(result.status_code, 401)
        self.assertEqual(self.manager.sessions, {})
        self.provider.exchange_uid = None
        self.request_reset()
        self.provider.exchange_type = 'mac'
        result = self.post('reset-activate', {'code': self.provider.recovery_mail[-1]['code']})
        self.assertEqual(result.status_code, 401)
        self.assertEqual(self.manager.sessions, {})
        self.provider.exchange_type = 'bearer'
        self.request_reset()
        with self.client.session_transaction() as browser:
            self.manager.recoveries[browser['spot_recovery']].verifier = 'wrong-' + 'x' * 50
        result = self.post('reset-activate', {'code': self.provider.recovery_mail[-1]['code']})
        self.assertEqual(result.status_code, 401)
        self.assertEqual(self.manager.sessions, {})

    def test_missing_expired_and_consumed_requests_fail_without_exchange(self):
        missing = self.post('reset-activate', {'code': 'fixture-code'})
        self.assertEqual(missing.status_code, 401)
        self.request_reset()
        code = self.provider.recovery_mail[-1]['code']
        self.now[0] += 901
        expired = self.post('reset-activate', {'code': code})
        self.assertEqual(expired.status_code, 401)
        self.assertNotIn(('POST', '/token?grant_type=pkce'), self.provider.events)
        self.activate_reset()
        replay = self.post('reset-activate', {'code': self.provider.recovery_mail[-1]['code']})
        self.assertEqual(replay.status_code, 401)
        self.assertEqual(str(replay.json['error']), RESET_LINK_ERROR)

    def test_revocation_before_exchange_and_before_save_cannot_be_bypassed(self):
        user = self.add_spot_user()
        self.request_reset(user['email'])
        user['app_metadata'][NAMESPACE]['approved'] = False
        result = self.post('reset-activate', {'code': self.provider.recovery_mail[-1]['code']})
        self.assertEqual(result.status_code, 401)
        self.assertNotIn(('POST', '/token?grant_type=pkce'), self.provider.events)
        user['app_metadata'][NAMESPACE]['approved'] = True
        self.activate_reset(user['email'])
        self.manager.revoke(user['id'])
        result = self.post('reset-password', {'password': NEW_PASSWORD, 'repeat_password': NEW_PASSWORD})
        self.assertEqual(result.status_code, 401)
        self.assertEqual(user['password'], PASSWORD)
        self.assertEqual(self.cop31, user['app_metadata']['cop31_mfa'])

    def test_pending_reset_expiry_logout_and_replaced_request(self):
        self.request_reset()
        with self.client.session_transaction() as browser:
            old = browser['spot_recovery']
        self.request_reset()
        self.assertNotIn(old, self.manager.recoveries)
        result = self.post('reset-activate', {'code': self.provider.recovery_mail[-1]['code']})
        self.assertEqual(result.status_code, 200)
        self.now[0] += 901
        self.assertEqual(self.post('reset-password', {'password': NEW_PASSWORD, 'repeat_password': NEW_PASSWORD}).status_code, 401)
        self.request_reset()
        self.assertEqual(self.post('logout').status_code, 200)
        self.assertEqual(self.manager.recoveries, {})
        self.assertEqual(self.post('reset-activate', {'code': self.provider.recovery_mail[-1]['code']}).status_code, 401)

    def test_new_password_minimum_confirmation_and_unverified_stage(self):
        self.assertEqual(self.post('reset-password', {'password': NEW_PASSWORD, 'repeat_password': NEW_PASSWORD}).status_code, 401)
        self.activate_reset()
        for password, repeated in [('short', 'short'), (NEW_PASSWORD, 'different long password')]:
            result = self.post('reset-password', {'password': password, 'repeat_password': repeated})
            self.assertEqual(result.status_code, 400)
        self.assertNotIn(('PUT', '/user'), self.provider.events)

    def test_csrf_code_bounds_and_callback_query_allowlist(self):
        self.assertEqual(self.client.post('/api/auth/reset-request', json={'email': self.owner['email'], 'csrf': self.csrf}).status_code, 403)
        for code in ['', {'code': 'x'}, 'x' * 2049, '#type=recovery', 'token.with.dots']:
            result = self.post('reset-activate', {'code': code})
            self.assertEqual(result.status_code, 401)
        for query in ['code=fixture-code', 'error=access_denied&error_code=expired&error_description=PRIVATE_ERROR', '']:
            result = self.client.get('/account/reset' + ('?' + query if query else ''))
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.headers['Cache-Control'], 'no-store, private')
            self.assertEqual(result.headers['Referrer-Policy'], 'no-referrer')
            self.assertNotIn('PRIVATE_ERROR', result.get_data(as_text=True))
            result.close()
        for path in ['/account/reset?code=x&code=y', '/account/reset?token_hash=x', '/account/reset?redirect_to=https://attacker.example', '/account?code=x', '/api/auth/config?code=x']:
            self.assertEqual(self.client.get(path).status_code, 400)

    def test_recovery_vault_is_bounded_and_expired_entries_are_pruned(self):
        for _ in range(512):
            self.manager.reset_request('unknown@example.org', 'http://localhost')
        with self.assertRaises(AuthError):
            self.manager.reset_request('unknown@example.org', 'http://localhost')
        self.now[0] += 901
        self.manager.reset_request('unknown@example.org', 'http://localhost')
        self.assertEqual(len(self.manager.recoveries), 1)


class LinkRestAdapter(unittest.TestCase):
    def test_flat_rest_and_sdk_link_replies_are_supported(self):
        uid = str(uuid.uuid4())
        identity = {'id': uid, 'email': 'invited@example.org'}
        token = 'fixture-private-' + 'x' * 40
        replies = [dict(identity, hashed_token=token, action_link='https://ignored.example'),
                   {'properties': {'hashed_token': token}, 'user': identity}]
        provider = SupabaseProvider('https://project.supabase.co', 'public', 'private')
        for reply in replies:
            with patch.object(provider, 'call', return_value=reply):
                user, actual = provider.link(identity['email'], 'invite')
            self.assertEqual(user['id'], uid)
            self.assertEqual(actual, token)

    def test_malformed_or_mismatched_link_identity_is_rejected(self):
        provider = SupabaseProvider('https://project.supabase.co', 'public', 'private')
        token = 'fixture-private-' + 'x' * 40
        for reply in [{'properties': [], 'user': {}}, {'id': 7, 'email': 'invited@example.org', 'hashed_token': token},
                      {'id': str(uuid.uuid4()), 'email': 'other@example.org', 'hashed_token': token}]:
            with patch.object(provider, 'call', return_value=reply):
                with self.assertRaises(AuthError):
                    provider.link('invited@example.org', 'invite')


if __name__ == '__main__':
    unittest.main()
