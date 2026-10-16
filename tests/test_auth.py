"""Security boundaries for invitation-only SPOT accounts; no live provider calls."""
from __future__ import annotations

import copy
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import uuid

from flask import Flask

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from spot_auth import (AuthError, NAMESPACE, SpotAccounts, SupabaseProvider,
                       account_state, register_auth)

PASSWORD = 'a sufficiently long password'


class FakeProvider(SupabaseProvider):
    """Only the HTTP transport is replaced; permission merge code is real."""
    def __init__(self):
        self.records, self.tokens, self.links = {}, {}, {}
        self.events = []
        self.disabled_signup = True
        self.counter = 0

    def add_user(self, email, *, confirmed=True, password=PASSWORD, metadata=None):
        uid = str(uuid.uuid4())
        user = {'id': uid, 'email': email, 'email_confirmed_at': '2026-10-16' if confirmed else None,
                'app_metadata': copy.deepcopy(metadata or {}), 'password': password}
        self.records[uid] = user
        return user

    def payload(self, user):
        self.counter += 1
        token = 'access-' + str(self.counter) + '-' + 'x' * 40
        self.tokens[token] = user['id']
        return {'access_token': token, 'refresh_token': 'refresh-' + 'x' * 40, 'expires_in': 3600}

    def call(self, method, path, body=None, *, admin=False, token=None):
        self.events.append((method, path))
        if path == '/settings':
            return {'disable_signup': self.disabled_signup, 'external': {'anonymous_users': False}}
        if path.startswith('/admin/users?page='):
            return {'users': copy.deepcopy(list(self.records.values()))}
        if path.startswith('/admin/users/'):
            uid = path.split('/')[-1]
            if method == 'PUT':
                self.records[uid]['app_metadata'] = copy.deepcopy(body['app_metadata'])
            return copy.deepcopy(self.records[uid])
        if path == '/admin/generate_link':
            user = next((u for u in self.records.values() if u['email'] == body['email']), None)
            if user is None:
                user = self.add_user(body['email'], confirmed=False, password=None)
            token_hash = 'private-token-' + str(len(self.links)) + '-' + 'x' * 40
            self.links[token_hash] = user['id']
            return {'user': copy.deepcopy(user), 'properties': {'hashed_token': token_hash}}
        if path == '/token?grant_type=password':
            user = next((u for u in self.records.values() if u['email'] == body['email']), None)
            if not user or user['password'] != body['password'] or not user['email_confirmed_at']:
                raise AuthError('The email or password was not recognised.', 401)
            return self.payload(user)
        if path == '/verify':
            uid = self.links.pop(body['token_hash'], None)
            if not uid:
                raise AuthError('The invitation has expired.', 401)
            self.records[uid]['email_confirmed_at'] = '2026-10-16'
            return self.payload(self.records[uid])
        if path == '/user':
            user = self.records[self.tokens[token]]
            if method == 'PUT':
                user['password'] = body['password']
            return copy.deepcopy(user)
        raise AssertionError((method, path))


class AuthBoundaries(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'SPOT_AUTH_LOCAL_PREVIEW': '1', 'SPOT_PUBLIC_ORIGIN': 'http://localhost'})
        self.env.start()
        self.provider = FakeProvider()
        self.owner = self.provider.add_user('owner@example.org', metadata={'cop31_mfa': {'approved': True, 'auth_version': 'c' * 24, 'password_set': True}})
        self.manager = SpotAccounts(self.provider, self.owner['email'])
        self.app = Flask(__name__)
        self.app.config.update(TESTING=True, SPOT_ACCOUNT_MANAGER=self.manager)
        register_auth(self.app)
        self.app.add_url_rule('/public-results', view_func=lambda: 'public model results')
        self.client = self.app.test_client()
        self.csrf = self.client.get('/api/auth/config').json['csrf']

    def tearDown(self):
        self.env.stop()

    def post(self, route, value=None, client=None, csrf=None):
        result = (client or self.client).post('/api/auth/' + route, json={**(value or {}), 'csrf': csrf or self.csrf}, headers={'Origin': 'http://localhost'})
        if result.is_json and result.json.get('csrf') and client is None:
            self.csrf = result.json['csrf']
        return result

    def owner_login(self):
        result = self.post('login', {'email': self.owner['email'], 'password': PASSWORD})
        self.assertEqual(result.status_code, 200, result.json)
        self.assertTrue(result.json['is_owner'])
        return result

    def invitation(self, email):
        self.owner_login()
        result = self.post('invite', {'email': email})
        self.assertEqual(result.status_code, 201, result.json)
        from urllib.parse import parse_qs, urlsplit
        token = {k: v[0] for k, v in parse_qs(urlsplit(result.json['link']).fragment).items()}
        return result, token

    def client_activation(self, token):
        client = self.app.test_client()
        csrf = client.get('/api/auth/config').json['csrf']
        result = self.post('activate', token, client=client, csrf=csrf)
        self.assertEqual(result.status_code, 200, result.json)
        return client, result.json

    def test_public_results_and_unconfigured_status(self):
        self.assertEqual(self.client.get('/public-results').status_code, 200)
        self.manager.provider = None
        result = self.client.get('/api/auth/config')
        self.assertFalse(result.json['configured'])
        self.assertEqual(self.post('login', {'email': self.owner['email'], 'password': PASSWORD}).status_code, 503)
        self.assertNotIn('key', str(result.json).lower())
        self.assertEqual(self.client.get('/public-results').status_code, 200)

    def test_owner_bootstrap_requires_verified_password_and_preserves_cop31(self):
        before = copy.deepcopy(self.owner['app_metadata']['cop31_mfa'])
        self.assertEqual(self.post('login', {'email': self.owner['email'], 'password': 'wrong long password'}).status_code, 401)
        self.assertNotIn(NAMESPACE, self.owner['app_metadata'])
        self.owner_login()
        self.assertEqual(before, self.owner['app_metadata']['cop31_mfa'])
        self.assertTrue(account_state(self.owner)['approved'])
        self.assertEqual(self.client.get('/api/auth/viewers').status_code, 200)

    def test_cop31_approval_and_client_metadata_cannot_grant_spot(self):
        user = self.provider.add_user('other@example.org', metadata={'cop31_mfa': {'approved': True, 'password_set': True, 'auth_version': 'c' * 24}})
        user['user_metadata'] = {NAMESPACE: {'approved': True, 'password_set': True, 'auth_version': 's' * 24}}
        result = self.post('login', {'email': user['email'], 'password': PASSWORD})
        self.assertEqual(result.status_code, 403)
        self.assertEqual(self.client.get('/api/auth/viewers').status_code, 401)

    def test_new_invitation_activation_and_only_owner_management(self):
        result, token = self.invitation('new@example.org')
        self.assertEqual(result.json['delivery'], 'manual')
        self.assertFalse(result.json['existing_account'])
        client, pending = self.client_activation(token)
        self.assertFalse(pending['existing_account'])
        resumed = client.get('/api/auth/session')
        self.assertTrue(resumed.json['pending'])
        self.assertFalse(resumed.json['authenticated'])
        result = self.post('password', {'password': PASSWORD, 'repeat_password': PASSWORD}, client=client, csrf=pending['csrf'])
        self.assertEqual(result.status_code, 200, result.json)
        self.assertFalse(result.json['is_owner'])
        self.assertNotIn('access_token', str(result.json))
        user = next(u for u in self.provider.records.values() if u['email'] == 'new@example.org')
        self.assertNotIn('cop31_mfa', user['app_metadata'])
        self.assertEqual(client.get('/api/auth/viewers').status_code, 403)
        self.assertEqual(self.post('invite', {'email': 'third@example.org'}, client=client, csrf=result.json['csrf']).status_code, 403)

    def test_existing_account_activation_never_changes_shared_password_or_cop31(self):
        existing = self.provider.add_user('existing@example.org', metadata={'cop31_mfa': {'approved': True, 'download_access': False, 'password_set': True, 'auth_version': 'c' * 24}})
        before = copy.deepcopy(existing['app_metadata']['cop31_mfa'])
        _, token = self.invitation(existing['email'])
        self.assertEqual(token['type'], 'spot_existing')
        self.assertEqual(token['uid'], existing['id'])
        self.assertNotIn(token['token_hash'], str(existing['app_metadata']))
        self.assertEqual(len(account_state(existing)['invitation_hash']), 64)
        self.assertNotIn(('POST', '/admin/generate_link'), self.provider.events)
        client, pending = self.client_activation(token)
        self.assertTrue(pending['existing_account'])
        wrong = 'a different long password'
        result = self.post('password', {'password': wrong, 'repeat_password': wrong}, client=client, csrf=pending['csrf'])
        self.assertEqual(result.status_code, 401)
        result = self.post('password', {'password': PASSWORD, 'repeat_password': PASSWORD}, client=client, csrf=pending['csrf'])
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(before, existing['app_metadata']['cop31_mfa'])
        self.assertEqual(existing['password'], PASSWORD)
        self.assertNotIn(('PUT', '/user'), self.provider.events)
        self.assertNotIn(('POST', '/verify'), self.provider.events)
        replay = self.post('activate', token, client=client, csrf=result.json['csrf'])
        self.assertEqual(replay.status_code, 401)

    def test_unfinished_other_app_account_cannot_take_new_password_branch(self):
        existing = self.provider.add_user('pending-cop31@example.org', confirmed=False,
                                          metadata={'cop31_mfa': {'approved': True, 'password_set': False}})
        before = copy.deepcopy(existing)
        self.owner_login()
        result = self.post('invite', {'email': existing['email']})
        self.assertEqual(result.status_code, 409)
        self.assertEqual(existing, before)
        self.assertNotIn(('POST', '/admin/generate_link'), self.provider.events)

    def test_other_apps_invitation_is_not_consumed(self):
        user = self.provider.add_user('cop31-pending@example.org', confirmed=False,
                                      metadata={'cop31_mfa': {'approved': True}})
        generated, token = self.provider.link(user['email'], 'invite')
        before = copy.deepcopy(user)
        result = self.post('activate', {'token_hash': token, 'type': 'invite', 'uid': user['id']})
        self.assertEqual(result.status_code, 401)
        self.assertEqual(before, user)
        self.assertIn(token, self.provider.links)
        self.assertNotIn(('POST', '/verify'), self.provider.events)

    def test_existing_short_provider_password_works_but_new_short_password_fails(self):
        existing = self.provider.add_user('old@example.org', password='old-pass')
        _, token = self.invitation(existing['email'])
        client, pending = self.client_activation(token)
        result = self.post('password', {'password': 'old-pass', 'repeat_password': 'old-pass'}, client=client, csrf=pending['csrf'])
        self.assertEqual(result.status_code, 200, result.json)
        result = self.post('login', {'email': existing['email'], 'password': 'old-pass'}, client=client, csrf=result.json['csrf'])
        self.assertEqual(result.status_code, 200, result.json)
        created, token = self.invitation('new-short@example.org')
        client, pending = self.client_activation(token)
        result = self.post('password', {'password': 'old-pass', 'repeat_password': 'old-pass'}, client=client, csrf=pending['csrf'])
        self.assertEqual(result.status_code, 400)
        self.assertNotIn(('PUT', '/user'), self.provider.events)

    def test_csrf_origin_and_query_controls(self):
        url = '/api/auth/login'
        body = {'email': self.owner['email'], 'password': PASSWORD, 'csrf': self.csrf}
        self.assertEqual(self.client.post(url, json=body).status_code, 403)
        self.assertEqual(self.client.post(url, json=body, headers={'Origin': 'https://attacker.example'}).status_code, 403)
        body['csrf'] = 'wrong'
        self.assertEqual(self.client.post(url, json=body, headers={'Origin': 'http://localhost'}).status_code, 403)
        self.assertEqual(self.client.get('/account?token_hash=private').status_code, 400)
        self.assertEqual(self.client.get('/api/auth/config?x=y').status_code, 400)

    def test_revoke_spot_invalidates_session_and_preserves_other_app(self):
        user = self.provider.add_user('existing@example.org', metadata={'cop31_mfa': {'approved': True, 'auth_version': 'c' * 24}})
        before = copy.deepcopy(user['app_metadata']['cop31_mfa'])
        _, token = self.invitation(user['email'])
        client, pending = self.client_activation(token)
        result = self.post('password', {'password': PASSWORD, 'repeat_password': PASSWORD}, client=client, csrf=pending['csrf'])
        self.assertEqual(result.status_code, 200)
        self.assertEqual(client.get('/api/auth/session').status_code, 200)
        self.assertEqual(self.post('viewers/' + user['id'] + '/revoke').status_code, 200)
        self.assertEqual(client.get('/api/auth/session').status_code, 401)
        self.assertEqual(before, user['app_metadata']['cop31_mfa'])

    def test_logout_removes_server_session_and_cookie_has_flags(self):
        result = self.owner_login()
        cookie = result.headers['Set-Cookie']
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Lax', cookie)
        old_cookie = self.client.get_cookie('spot_explorer_session').value
        self.assertEqual(self.post('logout').status_code, 200)
        self.client.set_cookie('spot_explorer_session', old_cookie)
        self.assertEqual(self.client.get('/api/auth/session').status_code, 401)

    def test_provider_must_remain_invitation_only(self):
        self.provider.disabled_signup = False
        self.assertEqual(self.post('login', {'email': self.owner['email'], 'password': PASSWORD}).status_code, 503)
        self.assertNotIn(NAMESPACE, self.owner['app_metadata'])

    def test_private_responses_and_no_signup_route(self):
        for path in ['/account', '/api/auth/config', '/api/auth/session', '/api/auth/viewers']:
            result = self.client.get(path)
            self.assertEqual(result.headers['Cache-Control'], 'no-store, private')
            self.assertEqual(result.headers['Referrer-Policy'], 'no-referrer')
            result.close()
        self.assertEqual(self.client.post('/api/auth/signup', json={}).status_code, 404)

    def test_replayed_invitation_and_password_confirmation(self):
        _, token = self.invitation('new@example.org')
        client, pending = self.client_activation(token)
        self.assertEqual(self.post('activate', token, client=client, csrf=pending['csrf']).status_code, 401)
        self.assertEqual(self.post('password', {'password': PASSWORD, 'repeat_password': 'not matching'}, client=client, csrf=pending['csrf']).status_code, 400)

    def test_provider_origin_validation(self):
        for url in ['http://project.supabase.co', 'https://localhost', 'https://project.supabase.co/path', 'https://secret@project.supabase.co']:
            with self.assertRaises(ValueError):
                SupabaseProvider(url, 'public', 'private')


if __name__ == '__main__':
    unittest.main()
