"""Invitation-only SPOT accounts; public model results remain public.

Uses the existing Supabase identity service, with independent server-owned
``app_metadata.spot_explorer`` permissions. Provider credentials and tokens
never leave the server. One process owns the bounded session vault; restart
signs users out. No COP31 metadata or provider configuration is changed.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import wraps
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import hmac
from hashlib import sha256
import json
import os
import re
import secrets
import threading
import time
import uuid

from flask import jsonify, request, send_from_directory, session
from werkzeug.exceptions import RequestEntityTooLarge

NAMESPACE = 'spot_explorer'
SESSION_SECONDS = 8 * 3600
SETUP_SECONDS = 15 * 60
MAX_BODY = 2 * 1024 * 1024
WEB = Path(__file__).resolve().parent / 'web'


class AuthError(Exception):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status


def email_address(value):
    if not isinstance(value, str):
        raise AuthError('Enter a valid email address.', 400)
    value = value.strip().lower()
    if len(value) > 254 or not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', value):
        raise AuthError('Enter a valid email address.', 400)
    return value


def account_state(user):
    metadata = user.get('app_metadata') if isinstance(user, dict) else None
    state = metadata.get(NAMESPACE) if isinstance(metadata, dict) else None
    if not isinstance(state, dict) or not isinstance(state.get('auth_version'), str):
        return None
    return state if re.fullmatch(r'[A-Za-z0-9_-]{16,128}', state['auth_version']) else None


def confirmed(user):
    return bool(user.get('email_confirmed_at') or user.get('confirmed_at'))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class SupabaseProvider:
    def __init__(self, url, public_key, secret_key):
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or
                parsed.password or parsed.path not in ('', '/') or parsed.query or
                parsed.fragment or parsed.hostname in {'localhost', '127.0.0.1', '::1'}):
            raise ValueError('Use the provider HTTPS origin.')
        self.url = url.rstrip('/')
        self.public_key, self.secret_key = public_key, secret_key
        self.opener = build_opener(NoRedirect())

    def call(self, method, path, body=None, *, admin=False, token=None):
        key = self.secret_key if admin else self.public_key
        headers = {'apikey': key, 'Accept': 'application/json'}
        bearer = token or (key if key.count('.') == 2 else None)
        if bearer:
            headers['Authorization'] = 'Bearer ' + bearer
        data = None if body is None else json.dumps(body, allow_nan=False).encode('utf-8')
        if data is not None:
            headers['Content-Type'] = 'application/json'
        try:
            req = Request(self.url + '/auth/v1' + path, data=data, headers=headers, method=method)
            with self.opener.open(req, timeout=12) as response:
                raw = response.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                raise ValueError('Response too large')
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError('Invalid provider response')
            return value
        except HTTPError as exc:
            status = 429 if exc.code == 429 else 401 if exc.code in {400, 401, 403, 404, 422} else 503
            raise AuthError('The account request could not be completed. Check the details or request a new invitation.', status) from None
        except (URLError, TimeoutError, OSError, ValueError):
            raise AuthError('The account service is unavailable. Please try again later.') from None

    def invite_only(self):
        settings = self.call('GET', '/settings')
        external = settings.get('external', {})
        if settings.get('disable_signup') is not True or (isinstance(external, dict) and external.get('anonymous_users') is True):
            raise AuthError('The account service must remain invitation-only. Ask the owner to check its configuration.')

    def get_user(self, uid):
        result = self.call('GET', '/admin/users/' + str(uuid.UUID(uid)), admin=True)
        return result.get('user', result)

    def users(self):
        result = []
        for page in range(1, 51):
            items = self.call('GET', f'/admin/users?page={page}&per_page=100', admin=True).get('users')
            if not isinstance(items, list):
                raise AuthError('The account list could not be verified.')
            result.extend(items)
            if len(items) < 100:
                return result
        raise AuthError('The account list is too large to manage here.')

    def find_email(self, email):
        return next((u for u in self.users() if str(u.get('email', '')).lower() == email), None)

    def state(self, user, **changes):
        metadata = user.get('app_metadata', {})
        if not isinstance(metadata, dict):
            raise AuthError('The account permissions could not be verified.')
        state = {**(account_state(user) or {}), **changes, 'auth_version': secrets.token_urlsafe(24)}
        result = self.call('PUT', '/admin/users/' + str(uuid.UUID(user['id'])),
                           {'app_metadata': {**metadata, NAMESPACE: state}}, admin=True)
        actual = result.get('user', result)
        if account_state(actual) != state:
            raise AuthError('The account permissions could not be saved.')
        return actual

    def link(self, email, kind):
        value = self.call('POST', '/admin/generate_link', {'type': kind, 'email': email}, admin=True)
        properties = value.get('properties', value)
        token = properties.get('hashed_token')
        user = value.get('user')
        if not isinstance(token, str) or not 20 <= len(token) <= 2048 or not isinstance(user, dict):
            raise AuthError('The private invitation could not be created.')
        return user, token


@dataclass
class LoginSession:
    uid: str
    email: str
    epoch: str
    stage: str
    access: str = field(repr=False)
    refresh: str = field(repr=False)
    token_deadline: float = 0
    deadline: float = 0
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False)


class SpotAccounts:
    def __init__(self, provider=None, admin_email='', *, clock=time.time):
        self.provider, self.admin_email, self.clock = provider, admin_email, clock
        self.sessions, self.attempts = {}, {}
        self.lock, self.mutations = threading.RLock(), threading.RLock()

    @classmethod
    def from_environment(cls):
        get = lambda name, fallback='': os.environ.get('SPOT_' + name, os.environ.get(name, fallback)).strip()
        owner = get('ADMIN_EMAIL', os.environ.get('DASHBOARD_ADMIN_EMAIL', 'ed@edcook.org.uk'))
        url = get('SUPABASE_URL')
        public = get('SUPABASE_PUBLISHABLE_KEY') or get('SUPABASE_ANON_KEY')
        private = get('SUPABASE_SECRET_KEY') or get('SUPABASE_SERVICE_ROLE_KEY')
        provider = None
        if all((url, public, private)):
            try:
                provider = SupabaseProvider(url, public, private)
            except ValueError:
                pass
        return cls(provider, email_address(owner) if owner else '')

    @property
    def enabled(self):
        return self.provider is not None and bool(self.admin_email)

    def require_provider(self):
        if not self.enabled:
            raise AuthError('Accounts are awaiting owner configuration. The public results remain available.')
        return self.provider

    def admit(self, key, limit=12):
        now = self.clock()
        with self.lock:
            self.attempts = {k: v for k, v in self.attempts.items() if v[0] > now - 900}
            times = self.attempts.setdefault(key, [])
            if len(times) >= limit or len(self.attempts) > 4096:
                raise AuthError('Too many account attempts. Please try again in 15 minutes.', 429)
            times.append(now)

    def approved(self, user, *, complete=True):
        state = account_state(user)
        if not state or state.get('approved') is not True or not confirmed(user) or (complete and state.get('password_set') is not True):
            raise AuthError('This account has not completed its SPOT invitation.', 403)
        return state

    def remove(self, handle):
        with self.lock:
            self.sessions.pop(handle, None)

    def invalidate(self, uid):
        with self.lock:
            self.sessions = {k: v for k, v in self.sessions.items() if v.uid != uid}

    def new_session(self, payload, stage='ready'):
        provider = self.require_provider()
        access, refresh, expires = payload.get('access_token'), payload.get('refresh_token'), payload.get('expires_in')
        if (not isinstance(access, str) or not 20 <= len(access) <= 16384 or
                not isinstance(refresh, str) or not 10 <= len(refresh) <= 16384 or
                not isinstance(expires, (int, float)) or isinstance(expires, bool) or not 0 < expires <= 86400):
            raise AuthError('The account session could not be verified.')
        actual = provider.call('GET', '/user', token=access)
        actual = actual.get('user', actual)
        user = provider.get_user(str(actual.get('id', '')))
        state = self.approved(user, complete=stage == 'ready')
        handle = secrets.token_urlsafe(48)
        now = self.clock()
        record = LoginSession(user['id'], email_address(user['email']), state['auth_version'], stage,
                              access, refresh, now + expires, now + (SESSION_SECONDS if stage == 'ready' else SETUP_SECONDS))
        with self.lock:
            self.sessions = {k: v for k, v in self.sessions.items() if v.deadline > now}
            if len(self.sessions) >= 512:
                raise AuthError('The account service is busy. Please try again later.')
            self.sessions[handle] = record
        return handle, record

    def pending_existing(self, user):
        """A SPOT-only invitation carries no provider password-reset authority."""
        state = self.approved(user, complete=False)
        handle, now = secrets.token_urlsafe(48), self.clock()
        record = LoginSession(user['id'], email_address(user['email']), state['auth_version'],
                              'password', '', '', 0, now + SETUP_SECONDS)
        with self.lock:
            self.sessions = {k: v for k, v in self.sessions.items() if v.deadline > now}
            if len(self.sessions) >= 512:
                raise AuthError('The account service is busy. Please try again later.')
            self.sessions[handle] = record
        return handle, record

    def validate(self, handle, stage='ready'):
        provider = self.require_provider()
        with self.lock:
            record = self.sessions.get(handle)
        if not record or record.stage != stage or record.deadline <= self.clock():
            self.remove(handle)
            raise AuthError('Your session expired. Please sign in again.', 401)
        with record.lock:
            if stage == 'password' and not record.access:
                user = provider.get_user(record.uid)
                state = self.approved(user, complete=False)
                if state['auth_version'] != record.epoch or str(user.get('email', '')).lower() != record.email:
                    self.remove(handle)
                    raise AuthError('This session was reset. Please sign in again.', 401)
                return record
            if record.token_deadline <= self.clock() + 30:
                payload = provider.call('POST', '/token?grant_type=refresh_token', {'refresh_token': record.refresh})
                access, refresh, expires = payload.get('access_token'), payload.get('refresh_token'), payload.get('expires_in')
                if (not isinstance(access, str) or not 20 <= len(access) <= 16384 or
                        not isinstance(refresh, str) or not 10 <= len(refresh) <= 16384 or
                        not isinstance(expires, (int, float)) or isinstance(expires, bool) or not 0 < expires <= 86400):
                    self.remove(handle)
                    raise AuthError('Your session expired. Please sign in again.', 401)
                record.access, record.refresh, record.token_deadline = access, refresh, self.clock() + expires
            actual = provider.call('GET', '/user', token=record.access)
            actual = actual.get('user', actual)
            user = provider.get_user(record.uid)
            state = self.approved(user, complete=stage == 'ready')
            if (actual.get('id') != record.uid or str(actual.get('email', '')).lower() != record.email or
                    str(user.get('email', '')).lower() != record.email or state['auth_version'] != record.epoch):
                self.remove(handle)
                raise AuthError('This session was reset. Please sign in again.', 401)
        return record

    def login(self, email, password):
        provider = self.require_provider()
        if not isinstance(password, str) or not 1 <= len(password) <= 1024:
            raise AuthError('The email or password was not recognised.', 401)
        provider.invite_only()
        payload = provider.call('POST', '/token?grant_type=password', {'email': email, 'password': password})
        actual = provider.call('GET', '/user', token=payload.get('access_token', ''))
        user = provider.get_user(str(actual.get('user', actual).get('id', '')))
        if email_address(user.get('email')) != email or not confirmed(user):
            raise AuthError('The email or password was not recognised.', 401)
        # Bootstrap only the configured owner after a verified provider login.
        if email == self.admin_email and account_state(user) is None:
            provider.state(user, approved=True, password_set=True, existing_account=True)
        return self.new_session(payload)

    def invite(self, email, origin):
        provider = self.require_provider()
        provider.invite_only()
        if email == self.admin_email:
            raise AuthError('The owner signs in with their existing provider account.', 400)
        with self.mutations:
            existing = provider.find_email(email)
            state = account_state(existing) if existing else None
            if state and state.get('approved') is True:
                raise AuthError('This account already has a SPOT invitation. Revoke it before issuing another.', 409)
            reuse = bool(existing and confirmed(existing))
            if existing and not reuse:
                metadata = existing.get('app_metadata', {})
                if not isinstance(metadata, dict) or any(key not in {'provider', 'providers', NAMESPACE} for key in metadata):
                    raise AuthError('This email has an unfinished authentication account. Complete its original invitation before joining SPOT.', 409)
            if reuse:
                current, token = existing, secrets.token_urlsafe(48)
                provider.state(current, approved=True, password_set=False, existing_account=True,
                               invitation_hash=sha256(token.encode('utf-8')).hexdigest(),
                               invitation_expires=self.clock() + 7 * 24 * 3600)
                parameters = {'token_hash': token, 'type': 'spot_existing', 'uid': current['id']}
            else:
                generated, token = provider.link(email, 'invite')
                current = provider.get_user(generated['id'])
                provider.state(current, approved=True, password_set=False, existing_account=False,
                               invitation_hash=sha256(token.encode('utf-8')).hexdigest(),
                               invitation_expires=self.clock() + 7 * 24 * 3600)
                parameters = {'token_hash': token, 'type': 'invite', 'uid': current['id']}
            self.invalidate(current['id'])
            return {'email': email, 'link': origin + '/account#' + urlencode(parameters),
                    'delivery': 'manual', 'existing_account': reuse}

    def activate(self, token, kind, uid=None):
        provider = self.require_provider()
        if kind not in {'invite', 'spot_existing'} or not isinstance(token, str) or not 20 <= len(token) <= 2048:
            raise AuthError('Use the complete private invitation link.', 400)
        provider.invite_only()
        if kind == 'spot_existing':
            with self.mutations:
                user = provider.get_user(str(uuid.UUID(uid)))
                state = self.approved(user, complete=False)
                expected, expiry = state.get('invitation_hash'), state.get('invitation_expires')
                if (state.get('existing_account') is not True or state.get('password_set') is not False or
                        not isinstance(expected, str) or not isinstance(expiry, (int, float)) or isinstance(expiry, bool) or
                        expiry <= self.clock() or not hmac.compare_digest(expected, sha256(token.encode('utf-8')).hexdigest())):
                    raise AuthError('This SPOT invitation expired or was already used. Ask the owner for another.', 401)
                user = provider.state(user, invitation_hash=None, invitation_expires=None)
                return self.pending_existing(user)
        with self.mutations:
            # Check the SPOT grant before redeeming a provider invite. A link
            # issued by another application must not be consumed on this site.
            user = provider.get_user(str(uuid.UUID(uid)))
            state = account_state(user)
            expected = state.get('invitation_hash') if state else None
            expiry = state.get('invitation_expires') if state else None
            if (not state or state.get('approved') is not True or state.get('password_set') is not False or
                    state.get('existing_account') is not False or not isinstance(expected, str) or
                    not isinstance(expiry, (int, float)) or isinstance(expiry, bool) or expiry <= self.clock() or
                    not hmac.compare_digest(expected, sha256(token.encode('utf-8')).hexdigest())):
                raise AuthError('This is not an active SPOT invitation. Ask the SPOT owner for another.', 401)
            payload = provider.call('POST', '/verify', {'token_hash': token, 'type': kind})
            actual = provider.call('GET', '/user', token=payload.get('access_token', ''))
            if actual.get('user', actual).get('id') != user['id']:
                raise AuthError('The invitation identity could not be verified.', 401)
            user = provider.get_user(user['id'])
            provider.state(user, invitation_hash=None, invitation_expires=None)
            return self.new_session(payload, 'password')

    def password(self, handle, password, repeated):
        provider = self.require_provider()
        if not isinstance(password, str) or not 1 <= len(password) <= 1024 or password != repeated:
            raise AuthError('Enter the same password twice.', 400)
        provider.invite_only()
        record = self.validate(handle, 'password')
        with self.mutations:
            user = provider.get_user(record.uid)
            state = self.approved(user, complete=False)
            if state.get('existing_account') is True:
                # A separate SPOT invitation never changes a COP31 user's password.
                payload = provider.call('POST', '/token?grant_type=password', {'email': record.email, 'password': password})
                actual = provider.call('GET', '/user', token=payload.get('access_token', ''))
                if actual.get('user', actual).get('id') != record.uid:
                    raise AuthError('The existing account password was not recognised.', 401)
            else:
                if len(password) < 14:
                    raise AuthError('Use at least 14 characters for your new password.', 400)
                provider.call('PUT', '/user', {'password': password}, token=record.access)
                payload = provider.call('POST', '/token?grant_type=password', {'email': record.email, 'password': password})
            provider.state(user, approved=True, password_set=True, existing_account=True)
            self.invalidate(record.uid)
            return self.new_session(payload)

    def revoke(self, uid):
        provider = self.require_provider()
        try:
            uid = str(uuid.UUID(uid))
        except (ValueError, TypeError, AttributeError):
            raise AuthError('Select a valid account.', 400) from None
        with self.mutations:
            user = provider.get_user(uid)
            if str(user.get('email', '')).lower() == self.admin_email:
                raise AuthError('Owner access cannot be revoked here.', 400)
            if account_state(user) is None:
                raise AuthError('This account has no SPOT invitation.', 404)
            provider.state(user, approved=False, password_set=False, invitation_hash=None, invitation_expires=None)
            self.invalidate(uid)


def register_auth(app):
    """Add isolated account routes. Call once while creating the Flask app."""
    secret = os.environ.get('SPOT_SESSION_SECRET') or os.environ.get('SESSION_SECRET')
    app.secret_key = secret or secrets.token_urlsafe(48)
    app.config.update(SESSION_COOKIE_NAME='spot_explorer_session', SESSION_COOKIE_HTTPONLY=True,
                      SESSION_COOKIE_SECURE=os.environ.get('SPOT_AUTH_LOCAL_PREVIEW') != '1',
                      SESSION_COOKIE_SAMESITE='Lax', SESSION_REFRESH_EACH_REQUEST=False)
    accounts = app.config.get('SPOT_ACCOUNT_MANAGER') or SpotAccounts.from_environment()
    app.extensions['spot_accounts'] = accounts

    def csrf():
        if 'spot_csrf' not in session:
            session['spot_csrf'] = secrets.token_urlsafe(32)
        return session['spot_csrf']

    def origin():
        configured = os.environ.get('SPOT_PUBLIC_ORIGIN') or os.environ.get('RENDER_EXTERNAL_URL')
        if configured:
            return configured.rstrip('/')
        return request.host_url.rstrip('/')

    def data():
        # Flask 3.1 also applies this limit to streamed request bodies.
        request.max_content_length = 16384
        if request.content_length and request.content_length > 16384:
            raise AuthError('The account request is too large.', 413)
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            raise AuthError('Submit the account form again.', 400)
        supplied = value.get('csrf')
        expected = session.get('spot_csrf')
        if (request.headers.get('Origin') != origin() or not isinstance(supplied, str) or
                not isinstance(expected, str) or not hmac.compare_digest(supplied.encode('utf-8'), expected.encode('utf-8'))):
            raise AuthError('This account form expired. Refresh the page and try again.', 403)
        return value

    def endpoint(function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            try:
                if request.query_string:
                    raise AuthError('Account links must not contain query parameters.', 400)
                return function(*args, **kwargs)
            except AuthError as exc:
                return jsonify(error=str(exc)), exc.status
            except RequestEntityTooLarge:
                return jsonify(error='The account request is too large.'), 413
            except (ValueError, TypeError, KeyError, UnicodeError):
                return jsonify(error='The account request could not be verified.'), 400
        return wrapped

    def current():
        return accounts.validate(session.get('spot_handle'))

    def owner():
        record = current()
        if record.email != accounts.admin_email:
            raise AuthError('Only the SPOT owner can manage invitations.', 403)
        return record

    def save_login(handle, record):
        accounts.remove(session.get('spot_handle'))
        accounts.remove(session.get('spot_pending'))
        session.clear()
        session['spot_handle'] = handle
        return jsonify(authenticated=True, email=record.email, is_owner=record.email == accounts.admin_email, csrf=csrf())

    @app.after_request
    def private_accounts(response):
        if request.path == '/account' or request.path.startswith('/api/auth/') or request.path in {'/static/account.js', '/static/account.css', '/static/account.html'}:
            response.headers['Cache-Control'] = 'no-store, private'
            response.headers['Referrer-Policy'] = 'no-referrer'
            response.headers['X-Frame-Options'] = 'DENY'
        return response

    @app.get('/account')
    @endpoint
    def spot_account_page():
        return send_from_directory(WEB, 'account.html')

    @app.get('/api/auth/config')
    @endpoint
    def spot_auth_config():
        return jsonify(configured=accounts.enabled, invitation_only=True,
                       message='Sign in with your invited SPOT account.' if accounts.enabled else 'Accounts are awaiting owner configuration. Public results are available.', csrf=csrf())

    @app.get('/api/auth/session')
    @endpoint
    def spot_auth_session():
        if session.get('spot_pending'):
            record = accounts.validate(session['spot_pending'], 'password')
            user = accounts.provider.get_user(record.uid)
            return jsonify(authenticated=False, pending=True, email=record.email,
                           existing_account=account_state(user).get('existing_account') is True, csrf=csrf())
        if not session.get('spot_handle'):
            return jsonify(authenticated=False, configured=accounts.enabled, csrf=csrf())
        record = current()
        return jsonify(authenticated=True, email=record.email, is_owner=record.email == accounts.admin_email, csrf=csrf())

    @app.post('/api/auth/login')
    @endpoint
    def spot_auth_login():
        body = data()
        email = email_address(body.get('email'))
        # Keep a generous transport limit: without a trusted proxy setting,
        # several hosted visitors may share remote_addr. Never trust arbitrary
        # client-supplied forwarded IP headers here.
        accounts.admit(('login-ip', request.remote_addr), limit=120)
        accounts.admit(('login-account', email))
        return save_login(*accounts.login(email, body.get('password')))

    @app.post('/api/auth/logout')
    @endpoint
    def spot_auth_logout():
        data()
        accounts.remove(session.get('spot_handle'))
        accounts.remove(session.get('spot_pending'))
        session.clear()
        return jsonify(authenticated=False, csrf=csrf())

    @app.post('/api/auth/activate')
    @endpoint
    def spot_auth_activate():
        body = data()
        accounts.admit(('activate', request.remote_addr), limit=120)
        handle, record = accounts.activate(body.get('token_hash'), body.get('type'), body.get('uid'))
        accounts.remove(session.get('spot_handle'))
        accounts.remove(session.get('spot_pending'))
        session.clear()
        session['spot_pending'] = handle
        user = accounts.provider.get_user(record.uid)
        return jsonify(pending=True, email=record.email, existing_account=account_state(user).get('existing_account') is True, csrf=csrf())

    @app.post('/api/auth/password')
    @endpoint
    def spot_auth_password():
        body = data()
        accounts.admit(('password', request.remote_addr), limit=120)
        return save_login(*accounts.password(session.get('spot_pending'), body.get('password'), body.get('repeat_password')))

    @app.get('/api/auth/viewers')
    @endpoint
    def spot_auth_viewers():
        owner()
        accounts.provider.invite_only()
        viewers = []
        for user in accounts.provider.users():
            state = account_state(user)
            if state is not None:
                viewers.append({'id': user['id'], 'email': user['email'], 'approved': state.get('approved') is True,
                                'password_set': state.get('password_set') is True,
                                'is_owner': str(user.get('email', '')).lower() == accounts.admin_email})
        return jsonify(viewers=viewers)

    @app.post('/api/auth/invite')
    @endpoint
    def spot_auth_invite():
        body = data()
        owner()
        accounts.admit(('invite', request.remote_addr))
        return jsonify(accounts.invite(email_address(body.get('email')), origin())), 201

    @app.post('/api/auth/viewers/<uid>/revoke')
    @endpoint
    def spot_auth_revoke(uid):
        data()
        owner()
        accounts.provider.invite_only()
        accounts.revoke(uid)
        return jsonify(ok=True)
