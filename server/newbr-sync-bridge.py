#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Optional
from urllib.parse import urlencode, urlparse

try:
    import cloudscraper  # type: ignore
except Exception:
    cloudscraper = None

import requests

DEFAULT_USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/135.0.0.0 Safari/537.36'
)

DEFAULT_TIMEOUT_SECONDS = 60
MAX_CUSTOMER_PAGES = 500


class BridgeError(Exception):
    def __init__(self, message: str, status: int = 500, code: str = 'bridge_error', payload: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.payload = payload


def looks_like_cloudflare(text: str) -> bool:
    snippet = (text or '')[:4000].lower()
    markers = [
        'just a moment',
        'cloudflare',
        'cf-browser-verification',
        'challenge-platform',
        'attention required',
    ]
    return any(marker in snippet for marker in markers)


def normalize_base_url(url: str) -> str:
    raw = (url or '').strip()
    if not raw:
        raise BridgeError('Base URL do NewBr nao informada.', 500, 'config')
    if not re.match(r'^https?://', raw, flags=re.I):
        raw = f'https://{raw}'
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        raise BridgeError(f'Base URL do NewBr invalida: {url}', 500, 'config')
    return f'{parsed.scheme}://{parsed.netloc}'.rstrip('/')


def find_number_deep(input_value: Any, preferred_keys: list[str] | None = None) -> Optional[float]:
    preferred_keys = preferred_keys or []
    if input_value is None:
        return None
    if isinstance(input_value, (int, float)):
        return float(input_value)
    if isinstance(input_value, str):
        normalized = input_value.replace('.', '').replace(',', '.').strip()
        try:
            return float(normalized)
        except Exception:
            return None
    if isinstance(input_value, list):
        for item in input_value:
            found = find_number_deep(item, preferred_keys)
            if found is not None:
                return found
        return None
    if isinstance(input_value, dict):
        for key in preferred_keys:
            if key in input_value:
                found = find_number_deep(input_value.get(key), preferred_keys)
                if found is not None:
                    return found
        for value in input_value.values():
            found = find_number_deep(value, preferred_keys)
            if found is not None:
                return found
    return None


def extract_rows(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ('data', 'rows', 'items', 'customers', 'results'):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
        if isinstance(payload.get('data'), dict):
            nested = payload['data']
            for key in ('data', 'rows', 'items', 'customers', 'results'):
                value = nested.get(key)
                if isinstance(value, list):
                    return [item for item in value if isinstance(item, dict)]
    return []


def extract_meta_container(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        if isinstance(payload.get('meta'), dict):
            return payload['meta']
        if isinstance(payload.get('data'), dict) and isinstance(payload['data'].get('meta'), dict):
            return payload['data']['meta']
    return {}


def extract_last_page(payload: Any) -> Optional[int]:
    meta = extract_meta_container(payload)
    value = find_number_deep(meta, ['last_page', 'lastPage']) or find_number_deep(payload, ['last_page', 'lastPage'])
    return int(value) if value is not None else None


def extract_current_page(payload: Any) -> Optional[int]:
    meta = extract_meta_container(payload)
    value = find_number_deep(meta, ['current_page', 'currentPage', 'page']) or find_number_deep(payload, ['current_page', 'currentPage', 'page'])
    return int(value) if value is not None else None


def extract_per_page(payload: Any) -> Optional[int]:
    meta = extract_meta_container(payload)
    value = find_number_deep(meta, ['per_page', 'perPage']) or find_number_deep(payload, ['per_page', 'perPage'])
    return int(value) if value is not None else None


def extract_total(payload: Any) -> Optional[int]:
    meta = extract_meta_container(payload)
    value = find_number_deep(meta, ['total']) or find_number_deep(payload, ['total'])
    return int(value) if value is not None else None


class ApiClient:
    def __init__(self, base_url: str, timeout_seconds: int, user_agent: str, cookie_header: str, app_version: str) -> None:
        self.base_url = normalize_base_url(base_url)
        self.timeout_seconds = timeout_seconds
        self.user_agent = user_agent or DEFAULT_USER_AGENT
        self.cookie_header = cookie_header or ''
        self.app_version = app_version or ''
        self.session = self._build_session()

    def _build_session(self) -> requests.Session:
        if cloudscraper is not None:
            session = cloudscraper.create_scraper(browser={'browser': 'chrome', 'platform': 'windows', 'mobile': False})
        else:
            session = requests.Session()

        session.headers.update(
            {
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                'User-Agent': self.user_agent,
                'Origin': self.base_url,
                'Referer': f'{self.base_url}/',
                'locale': 'pt',
            }
        )
        if self.app_version:
            session.headers.update({'x-app-version': self.app_version})
        if self.cookie_header:
            session.headers.update({'Cookie': self.cookie_header})
        return session

    def safe_json(self, response: requests.Response) -> Any:
        try:
            return response.json()
        except Exception:
            snippet = response.text[:500].strip()
            if looks_like_cloudflare(response.text):
                raise BridgeError(
                    'O servidor respondeu com uma pagina de protecao anti-bot/Cloudflare em vez de JSON.',
                    403,
                    'cloudflare',
                    {'html': snippet},
                )
            raise BridgeError(
                f'Resposta nao-JSON em {response.request.method} {response.url}',
                response.status_code,
                'invalid_response',
                {'raw': snippet},
            )

    def extract_token(self, payload: Any) -> Optional[str]:
        if not isinstance(payload, dict):
            return None
        return (
            payload.get('token')
            or payload.get('accessToken')
            or payload.get('access_token')
            or payload.get('jwt')
            or ((payload.get('data') or {}).get('token') if isinstance(payload.get('data'), dict) else None)
            or ((payload.get('data') or {}).get('accessToken') if isinstance(payload.get('data'), dict) else None)
            or ((payload.get('data') or {}).get('access_token') if isinstance(payload.get('data'), dict) else None)
        )

    def login(self, username: str, password: str) -> str:
        if not username or not password:
            raise BridgeError('Credenciais do NewBr nao configuradas.', 500, 'config')

        login_url = f'{self.base_url}/api/auth/login'
        candidate_payloads = [
            {
                'captcha': 'not-a-robot',
                'captchaChecked': True,
                'username': username,
                'password': password,
                'twofactor_code': '',
                'twofactor_recovery_code': '',
                'twofactor_trusted_device_id': '',
            },
            {'username': username, 'password': password, 'captchaToken': '', 'twofactor': ''},
            {'username': username, 'password': password, 'captcha': None, 'twofactor': None},
        ]

        last_error: Optional[BridgeError] = None

        for payload in candidate_payloads:
            try:
                response = self.session.post(login_url, json=payload, timeout=self.timeout_seconds)
                if response.status_code >= 400:
                    data = None
                    try:
                        data = self.safe_json(response)
                    except BridgeError as exc:
                        if exc.code == 'cloudflare':
                            raise exc
                    detail = data or response.text[:300]
                    raise BridgeError('Falha no login.', response.status_code, 'auth', {'detail': detail, 'payload_used': payload})

                data = self.safe_json(response)
                token = self.extract_token(data)
                if not token:
                    raise BridgeError('Login respondeu sem token reconhecivel.', 502, 'auth', {'raw': data, 'payload_used': payload})

                self.session.headers.update({'Authorization': f'Bearer {token}'})
                return token
            except BridgeError as exc:
                last_error = exc

        if last_error:
            raise last_error
        raise BridgeError('Falha no login.', 500, 'auth')

    def get_json(self, endpoint: str, token: str) -> Any:
        url = f'{self.base_url}{endpoint}'
        headers = {'Authorization': f'Bearer {token}'}
        response = self.session.get(url, headers=headers, timeout=self.timeout_seconds)
        if response.status_code >= 400:
            payload = None
            try:
                payload = self.safe_json(response)
            except BridgeError as exc:
                raise BridgeError(str(exc), exc.status, exc.code, exc.payload)
            raise BridgeError(f'Falha ao consultar {endpoint}', response.status_code, 'request_failed', payload)
        return self.safe_json(response)

    def get_all_customers(self, token: str, per_page: int = 100, max_pages: int = MAX_CUSTOMER_PAGES) -> dict[str, Any]:
        all_rows: list[dict[str, Any]] = []
        pages_loaded = 0
        last_page_seen: Optional[int] = None

        for page in range(1, max_pages + 1):
            query = urlencode(
                {
                    'page': page,
                    'username': '',
                    'serverId': '',
                    'packageId': '',
                    'expiryFrom': '',
                    'expiryTo': '',
                    'status': '',
                    'isTrial': '',
                    'connections': '',
                    'perPage': per_page,
                }
            )
            payload = self.get_json(f'/api/customers?{query}', token)
            page_rows = extract_rows(payload)
            all_rows.extend(page_rows)
            pages_loaded += 1

            current_page = extract_current_page(payload) or page
            last_page_seen = extract_last_page(payload) or last_page_seen
            total_seen = extract_total(payload)
            per_page_seen = extract_per_page(payload) or per_page

            if last_page_seen and current_page >= last_page_seen:
                break
            if total_seen is not None and len(all_rows) >= total_seen:
                break
            if not page_rows or len(page_rows) < per_page_seen:
                break

        return {
            'rows': all_rows,
            'pagesLoaded': pages_loaded,
            'lastPage': last_page_seen,
            'totalRows': len(all_rows),
        }


def run_sync() -> dict[str, Any]:
    base_url = os.environ.get('NEWBR_SYNC_BASE_URL', 'https://painel.newbr.top')
    username = os.environ.get('NEWBR_SYNC_USERNAME', '').strip()
    password = os.environ.get('NEWBR_SYNC_PASSWORD', '')
    user_agent = os.environ.get('NEWBR_SYNC_USER_AGENT', '').strip() or DEFAULT_USER_AGENT
    app_version = os.environ.get('NEWBR_SYNC_APP_VERSION', '').strip()
    cookie_header = os.environ.get('NEWBR_SYNC_COOKIE_HEADER', '').strip()
    cf_clearance = os.environ.get('NEWBR_SYNC_CF_CLEARANCE', '').strip()
    per_page = int(os.environ.get('NEWBR_SYNC_PER_PAGE', '100') or '100')
    max_pages = int(os.environ.get('NEWBR_SYNC_MAX_PAGES', str(MAX_CUSTOMER_PAGES)) or str(MAX_CUSTOMER_PAGES))
    timeout_seconds = max(30, int(int(os.environ.get('NEWBR_SYNC_TIMEOUT_MS', str(DEFAULT_TIMEOUT_SECONDS * 1000))) / 1000))

    if not cookie_header and cf_clearance:
        cookie_header = f'cf_clearance={cf_clearance}'

    client = ApiClient(base_url, timeout_seconds, user_agent, cookie_header, app_version)
    token = client.login(username, password)
    payload = client.get_all_customers(token, per_page=per_page, max_pages=max_pages)

    return {
        'rows': payload.get('rows', []) if isinstance(payload, dict) else [],
        'pagesLoaded': int(payload.get('pagesLoaded') or 0) if isinstance(payload, dict) else 0,
        'lastPage': payload.get('lastPage') if isinstance(payload, dict) else None,
        'totalRows': int(payload.get('totalRows') or 0) if isinstance(payload, dict) else 0,
    }


def main() -> None:
    try:
        payload = run_sync()
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    except BridgeError as exc:
        sys.stderr.write(
            json.dumps(
                {
                    'error': str(exc),
                    'status': exc.status,
                    'code': exc.code,
                    'payload': exc.payload,
                },
                ensure_ascii=False,
            )
        )
        raise SystemExit(1)
    except Exception as exc:
        message = str(exc)
        code = 'bridge_unhandled'
        if 'cloudflare' in message.lower():
            code = 'cloudflare'
        elif 'login' in message.lower():
            code = 'auth'

        sys.stderr.write(
            json.dumps(
                {
                    'error': message,
                    'status': getattr(exc, 'status', 500),
                    'code': code,
                    'payload': getattr(exc, 'payload', None),
                },
                ensure_ascii=False,
            )
        )
        raise SystemExit(1)


if __name__ == '__main__':
    main()
