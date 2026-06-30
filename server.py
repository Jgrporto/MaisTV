#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import calendar
import json
import os
import re
from io import BytesIO
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.parse import urlencode, urlparse

try:
    import cloudscraper  # type: ignore
except Exception:
    cloudscraper = None

import requests
from openpyxl import Workbook

PORT = int(os.environ.get('PORT', '3000'))
BASE_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = BASE_DIR / 'public'
API_BASE = os.environ.get('API_BASE', 'https://painel.newbr.top')
USER_AGENT = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/135.0.0.0 Safari/537.36'
)
DEFAULT_TIMEOUT = 60
MAX_CUSTOMER_PAGES = 500


MONTH_LABELS_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez']


def normalize_base_url(url: str) -> str:
    raw = (url or '').strip()
    if not raw:
        raise ValueError('Base URL nao informada.')
    if not re.match(r'^https?://', raw, flags=re.I):
        raw = f'https://{raw}'
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError(f'Base URL invalida: {url}')
    return f'{parsed.scheme}://{parsed.netloc}'.rstrip('/')


API_BASE = normalize_base_url(API_BASE)


def log(message: str) -> None:
    timestamp = datetime.now().strftime('%H:%M:%S')
    print(f'[{timestamp}] {message}')


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


class ApiError(Exception):
    def __init__(self, message: str, status: int = 500, payload: Any = None):
        super().__init__(message)
        self.status = status
        self.payload = payload


class ApiClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = normalize_base_url(base_url)
        self.session = self._build_session()

    def _build_session(self) -> requests.Session:
        if cloudscraper is not None:
            session = cloudscraper.create_scraper(browser={'browser': 'chrome', 'platform': 'windows', 'mobile': False})
            engine = 'cloudscraper'
        else:
            session = requests.Session()
            engine = 'requests'

        session.headers.update(
            {
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                'User-Agent': USER_AGENT,
                'Origin': self.base_url,
                'Referer': f'{self.base_url}/',
            }
        )
        log(f'Sessao iniciada com {engine}.')
        return session

    def safe_json(self, response: requests.Response) -> Any:
        try:
            return response.json()
        except Exception:
            snippet = response.text[:500].strip()
            if looks_like_cloudflare(response.text):
                raise ApiError('O servidor respondeu com uma pagina de protecao anti-bot/Cloudflare em vez de JSON.', 403, {'html': snippet})
            raise ApiError(f'Resposta nao-JSON em {response.request.method} {response.url}', response.status_code, {'raw': snippet})

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

    def login(self, username: str, password: str) -> Dict[str, Any]:
        login_url = f'{self.base_url}/api/auth/login'
        candidate_payloads = [
            {'username': username, 'password': password, 'captcha': '', 'twofactor': ''},
            {'username': username, 'password': password, 'captchaToken': '', 'twofactor': ''},
            {'username': username, 'password': password, 'captcha': None, 'twofactor': None},
        ]

        last_error: Optional[ApiError] = None
        for idx, payload in enumerate(candidate_payloads, start=1):
            try:
                log(f'Tentando login ({idx}/{len(candidate_payloads)}) em {login_url}')
                response = self.session.post(login_url, json=payload, timeout=DEFAULT_TIMEOUT)
                if response.status_code >= 400:
                    data = None
                    try:
                        data = self.safe_json(response)
                    except ApiError:
                        pass
                    detail = data or response.text[:300]
                    raise ApiError('Falha no login.', response.status_code, {'detail': detail, 'payload_used': payload})

                data = self.safe_json(response)
                token = self.extract_token(data)
                if not token:
                    raise ApiError('Login respondeu sem token reconhecivel.', 502, {'raw': data, 'payload_used': payload})

                self.session.headers.update({'Authorization': f'Bearer {token}'})
                log('Login realizado com sucesso.')
                return {'token': token, 'raw': data, 'payload_used': payload}
            except ApiError as exc:
                last_error = exc

        if last_error:
            raise last_error
        raise ApiError('Falha no login.', 500)

    def get_json(self, endpoint: str, token: str) -> Any:
        url = f'{self.base_url}{endpoint}'
        headers = {'Authorization': f'Bearer {token}'}
        response = self.session.get(url, headers=headers, timeout=DEFAULT_TIMEOUT)
        if response.status_code >= 400:
            payload = None
            try:
                payload = self.safe_json(response)
            except ApiError as exc:
                raise ApiError(str(exc), exc.status, exc.payload)
            raise ApiError(f'Falha ao consultar {endpoint}', response.status_code, payload)
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


def parse_date_any(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None

    normalized = raw.replace('Z', '+00:00')
    try:
        return datetime.fromisoformat(normalized)
    except Exception:
        pass

    candidates = [
        '%Y-%m-%d', '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M',
        '%d/%m/%Y', '%d/%m/%Y %H:%M:%S', '%d/%m/%Y %H:%M',
        '%Y/%m/%d', '%Y/%m/%d %H:%M:%S', '%Y/%m/%d %H:%M',
        '%d-%m-%Y', '%d-%m-%Y %H:%M:%S', '%d-%m-%Y %H:%M',
    ]
    for fmt in candidates:
        try:
            return datetime.strptime(raw, fmt)
        except Exception:
            continue
    return None


def find_expiry_date(customer: dict[str, Any]) -> Optional[datetime]:
    keys = ['expires_at_tz', 'expires_at', 'expiration', 'expiry', 'expiresAt', 'expiration_date', 'due_date', 'dueDate', 'vencimento']
    for key in keys:
        if key in customer:
            parsed = parse_date_any(customer.get(key))
            if parsed is not None:
                return parsed
    for nested_key in ('user', 'customer', 'account'):
        nested = customer.get(nested_key)
        if isinstance(nested, dict):
            for key in keys:
                if key in nested:
                    parsed = parse_date_any(nested.get(key))
                    if parsed is not None:
                        return parsed
    return None


def find_first_value(input_value: Any, preferred_keys: list[str] | None = None) -> Optional[Any]:
    preferred_keys = preferred_keys or []
    if input_value is None:
        return None
    if isinstance(input_value, dict):
        for key in preferred_keys:
            if key in input_value:
                value = input_value.get(key)
                if value not in (None, ''):
                    return value
        for value in input_value.values():
            found = find_first_value(value, preferred_keys)
            if found not in (None, ''):
                return found
    if isinstance(input_value, list):
        for item in input_value:
            found = find_first_value(item, preferred_keys)
            if found not in (None, ''):
                return found
    return None


def stringify_cell(value: Any) -> str:
    if value is None:
        return ''
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        nested = find_first_value(value, ['name', 'title', 'description', 'username', 'phone', 'telefone', 'number'])
        return stringify_cell(nested)
    if isinstance(value, list):
        return ', '.join(part for part in (stringify_cell(item).strip() for item in value) if part)
    return str(value).strip()


def extract_customer_field(
    customer: dict[str, Any],
    keys: list[str],
    nested_keys: tuple[str, ...] = ('user', 'customer', 'account', 'package', 'plan'),
) -> str:
    direct = find_first_value(customer, keys)
    if direct not in (None, ''):
        return stringify_cell(direct)

    for nested_key in nested_keys:
        nested = customer.get(nested_key)
        if isinstance(nested, dict):
            nested_value = find_first_value(nested, keys)
            if nested_value not in (None, ''):
                return stringify_cell(nested_value)

    return ''


def build_customer_export_rows(rows: list[dict[str, Any]]) -> list[list[str]]:
    export_rows: list[list[str]] = []
    for index, customer in enumerate(rows, start=1):
        username = extract_customer_field(customer, ['username', 'user_name', 'login', 'name', 'nome'])
        phone = extract_customer_field(customer, ['telefone', 'phone', 'phone_number', 'mobile', 'cellphone', 'whatsapp'])
        plan = extract_customer_field(customer, ['plano', 'plan', 'plan_name', 'package_name', 'package', 'packageName', 'description'])
        expiry = find_expiry_date(customer)
        due_date = expiry.strftime('%d/%m/%Y') if expiry else ''
        raw_status = extract_customer_field(customer, ['status', 'situation', 'state'])
        status = 'ATIVO' if raw_status.strip().upper() == 'ACTIVE' else 'INATIVO'
        export_rows.append([str(index), username, phone, plan, due_date, status])
    return export_rows


def generate_customers_xlsx(rows: list[dict[str, Any]]) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = 'Clientes'

    headers = ['codigo_numerado', 'username', 'telefone', 'plano', 'vencimento', 'status']
    sheet.append(headers)
    for row in build_customer_export_rows(rows):
        sheet.append(row)

    for column_cells in sheet.columns:
        max_length = max(len(stringify_cell(cell.value)) for cell in column_cells)
        sheet.column_dimensions[column_cells[0].column_letter].width = max(max_length + 2, 16)

    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


def is_non_trial(row: dict[str, Any]) -> bool:
    return str(row.get('is_trial') or '').strip().upper() == 'NO'
def extract_customers_breakdown(input_value: Any) -> dict[str, int]:
    root = input_value.get('data') if isinstance(input_value, dict) and isinstance(input_value.get('data'), dict) else input_value
    if not isinstance(root, dict):
        return {'active': 0, 'inactive': 0, 'toExpire': 0, 'total': 0}
    mine = root.get('mine') if isinstance(root.get('mine'), dict) else {}
    tree = root.get('tree') if isinstance(root.get('tree'), dict) else {}
    active = int(find_number_deep(mine, ['active']) or 0) + int(find_number_deep(tree, ['active']) or 0)
    inactive = int(find_number_deep(mine, ['inactive']) or 0) + int(find_number_deep(tree, ['inactive']) or 0)
    to_expire = int(find_number_deep(mine, ['toExpire']) or 0) + int(find_number_deep(tree, ['toExpire']) or 0)
    return {'active': active, 'inactive': inactive, 'toExpire': to_expire, 'total': active + inactive + to_expire}


def chart_dates_for_mode(length: int, mode: str) -> list[date]:
    today = datetime.now().date()
    if length <= 0:
        return []
    if mode == 'future':
        return [today + timedelta(days=index) for index in range(length)]
    return [today - timedelta(days=(length - 1 - index)) for index in range(length)]


def extract_chart_payload(input_value: Any, mode: str) -> dict[str, Any]:
    if not isinstance(input_value, dict):
        return {'title': '', 'categories': [], 'current': [], 'previous': [], 'fullDates': [], 'total': 0.0, 'valueType': 'number'}
    categories = input_value.get('categories') if isinstance(input_value.get('categories'), list) else []
    series = input_value.get('series') if isinstance(input_value.get('series'), list) else []

    current_series = None
    previous_series = None
    for item in series:
        if not isinstance(item, dict):
            continue
        name = str(item.get('name', '')).strip().lower()
        if current_series is None and name in ('período atual', 'periodo atual', 'atual', 'current period'):
            current_series = item
        if previous_series is None and name in ('período anterior', 'periodo anterior', 'anterior', 'previous period'):
            previous_series = item
    if current_series is None and series:
        current_series = series[0] if isinstance(series[0], dict) else None
    if previous_series is None and len(series) > 1:
        previous_series = series[1] if isinstance(series[1], dict) else None

    current = current_series.get('data') if isinstance(current_series, dict) and isinstance(current_series.get('data'), list) else []
    previous = previous_series.get('data') if isinstance(previous_series, dict) and isinstance(previous_series.get('data'), list) else [0] * len(current)
    full_dates = [item.isoformat() for item in chart_dates_for_mode(len(current), mode)]

    return {
        'title': str(input_value.get('description') or ''),
        'categories': [str(item) for item in categories[:len(current)]],
        'current': [float(item or 0) for item in current],
        'previous': [float(item or 0) for item in previous[:len(current)]],
        'fullDates': full_dates,
        'total': float(find_number_deep(input_value, ['total', 'current']) or 0),
        'change': float(find_number_deep(input_value, ['change']) or 0),
        'valueType': 'number',
    }


def build_cancelados_daily_series(rows: list[dict[str, Any]], days: int = 30) -> dict[str, Any]:
    today = datetime.now().date()
    current_start = today - timedelta(days=days - 1)
    previous_start = current_start - timedelta(days=days)

    current_map = {(current_start + timedelta(days=i)): 0 for i in range(days)}
    previous_map = {(previous_start + timedelta(days=i)): 0 for i in range(days)}

    for row in rows:
        if str(row.get('status') or '').upper() != 'EXPIRED':
            continue
        if not is_non_trial(row):
            continue
        expiry = find_expiry_date(row)
        if not expiry:
            continue
        exp_date = expiry.date()
        if exp_date in current_map:
            current_map[exp_date] += 1
        if exp_date in previous_map:
            previous_map[exp_date] += 1

    current_dates = [current_start + timedelta(days=i) for i in range(days)]
    previous_dates = [previous_start + timedelta(days=i) for i in range(days)]
    return {
        'title': 'Cancelados - últimos 30 dias',
        'categories': [str(item.day) for item in current_dates],
        'current': [float(current_map[item]) for item in current_dates],
        'previous': [float(previous_map[item]) for item in previous_dates],
        'fullDates': [item.isoformat() for item in current_dates],
        'total': float(sum(current_map.values())),
        'change': 0.0,
        'valueType': 'number',
        'valueMode': 'sum',
    }


def calculate_projection_metrics(customers_breakdown: dict[str, int], sales_chart: dict[str, Any], cancelados_chart: dict[str, Any]) -> dict[str, Any]:
    today = datetime.now().date()
    reference_date = today - timedelta(days=1)
    current_active_total = int(customers_breakdown.get('active') or 0)

    sales_current = sales_chart.get('current') if isinstance(sales_chart.get('current'), list) else []
    sales_dates = sales_chart.get('fullDates') if isinstance(sales_chart.get('fullDates'), list) else []
    sales_used_this_month = 0.0
    for idx, value in enumerate(sales_current):
        if idx >= len(sales_dates):
            continue
        point = parse_date_any(sales_dates[idx])
        if not point:
            continue
        point_date = point.date()
        if point_date.year == reference_date.year and point_date.month == reference_date.month and point_date <= reference_date:
            sales_used_this_month += float(value or 0)

    cancel_current = cancelados_chart.get('current') if isinstance(cancelados_chart.get('current'), list) else []
    cancel_dates = cancelados_chart.get('fullDates') if isinstance(cancelados_chart.get('fullDates'), list) else []
    cancellations_used_this_month = 0.0
    for idx, value in enumerate(cancel_current):
        if idx >= len(cancel_dates):
            continue
        point = parse_date_any(cancel_dates[idx])
        if not point:
            continue
        point_date = point.date()
        if point_date.year == reference_date.year and point_date.month == reference_date.month and point_date <= reference_date:
            cancellations_used_this_month += float(value or 0)

    elapsed_days_month = max(reference_date.day, 1)

    avg_daily_sales = float(sales_used_this_month) / elapsed_days_month
    avg_daily_cancellations = float(cancellations_used_this_month) / elapsed_days_month
    projected_daily_sales = avg_daily_sales
    projected_daily_cancellations = avg_daily_cancellations
    net_daily_variation = projected_daily_sales - projected_daily_cancellations

    month_last_day = calendar.monthrange(reference_date.year, reference_date.month)[1]
    month_end = date(reference_date.year, reference_date.month, month_last_day)
    days_remaining_month = max((month_end - reference_date).days, 0)

    year_end = date(reference_date.year, 12, 31)
    days_remaining_year = max((year_end - reference_date).days, 0)

    projected_month_sales = projected_daily_sales * days_remaining_month
    projected_month_cancellations = projected_daily_cancellations * days_remaining_month
    projected_year_sales = projected_daily_sales * days_remaining_year
    projected_year_cancellations = projected_daily_cancellations * days_remaining_year

    projected_end_month = max(current_active_total + projected_month_sales - projected_month_cancellations, 0.0)
    projected_end_year = max(current_active_total + projected_year_sales - projected_year_cancellations, 0.0)

    return {
        'currentActiveTotal': current_active_total,
        'calculationBaseDate': reference_date.isoformat(),
        'salesUsedThisMonth': sales_used_this_month,
        'cancellationsUsedThisMonth': cancellations_used_this_month,
        'elapsedDaysMonth': elapsed_days_month,
        'avgDailySales': avg_daily_sales,
        'avgDailyCancellations': avg_daily_cancellations,
        'projectedDailySales': projected_daily_sales,
        'projectedDailyCancellations': projected_daily_cancellations,
        'netDailyVariation': net_daily_variation,
        'projectedMonthSales': projected_month_sales,
        'projectedMonthCancellations': projected_month_cancellations,
        'projectedYearSales': projected_year_sales,
        'projectedYearCancellations': projected_year_cancellations,
        'daysRemainingMonth': days_remaining_month,
        'daysRemainingYear': days_remaining_year,
        'projectedEndMonth': projected_end_month,
        'projectedEndYear': projected_end_year,
    }


def build_projection_chart(title: str, start_date: date, end_date: date, current_active_total: int, daily_sales: float, daily_cancellations: float) -> dict[str, Any]:
    total_days = max((end_date - start_date).days, 0)
    points_dates = [start_date + timedelta(days=offset) for offset in range(total_days + 1)]

    current = [max(current_active_total + (daily_sales * offset) - (daily_cancellations * offset), 0.0) for offset in range(total_days + 1)]
    previous = [float(current_active_total) for _ in points_dates]

    categories = []
    for point_date in points_dates:
        if len(points_dates) <= 20:
            categories.append(str(point_date.day))
        else:
            categories.append(point_date.strftime('%d/%m'))

    return {
        'title': title,
        'categories': categories,
        'current': current,
        'previous': previous,
        'fullDates': [item.isoformat() for item in points_dates],
        'total': float(current[-1] if current else current_active_total),
        'change': 0.0,
        'valueType': 'number',
        'valueMode': 'last',
    }


def summarize_customer_metrics(rows: list[dict[str, Any]]) -> dict[str, int]:
    today = datetime.now().date()
    current_month = today.month
    current_year = today.year
    vencem_hoje = 0
    cancelados_mes = 0

    for row in rows:
        expiry = find_expiry_date(row)
        if not expiry:
            continue
        exp_date = expiry.date()
        if exp_date == today and is_non_trial(row):
            vencem_hoje += 1

        if is_non_trial(row) and str(row.get('status') or '').upper() == 'EXPIRED' and exp_date.month == current_month and exp_date.year == current_year:
            cancelados_mes += 1

    return {'canceladosMes': cancelados_mes, 'vencemHoje': vencem_hoje}


def build_metrics(raw: dict[str, Any]) -> dict[str, Any]:
    customers_breakdown = extract_customers_breakdown(raw.get('customersCount'))
    customer_rows = raw.get('customersAll', {}).get('rows', []) if isinstance(raw.get('customersAll'), dict) else []
    customer_summary = summarize_customer_metrics(customer_rows)

    new_customers = extract_chart_payload(raw.get('newCustomers'), 'past')
    cancelados_chart = build_cancelados_daily_series(customer_rows)
    projection = calculate_projection_metrics(customers_breakdown, new_customers, cancelados_chart)

    today = datetime.now().date()
    reference_date = today - timedelta(days=1)
    month_last_day = calendar.monthrange(reference_date.year, reference_date.month)[1]
    month_end = date(reference_date.year, reference_date.month, month_last_day)
    year_end = date(reference_date.year, 12, 31)

    month_forecast = build_projection_chart(
        'Previsão até terminar o mês',
        reference_date,
        month_end,
        projection['currentActiveTotal'],
        projection['projectedDailySales'],
        projection['projectedDailyCancellations'],
    )
    year_forecast = build_projection_chart(
        'Previsão até o final do ano',
        reference_date,
        year_end,
        projection['currentActiveTotal'],
        projection['projectedDailySales'],
        projection['projectedDailyCancellations'],
    )

    return {
        'cards': [
            {'id': 'ativos-agora', 'title': 'ATIVOS AGORA', 'rawValue': customers_breakdown['active'], 'note': 'Clientes ativos', 'icon': 'users'},
            {'id': 'vendas-mes', 'title': 'VENDAS NO MÊS', 'rawValue': int(new_customers['total']), 'note': 'Novos clientes do mês', 'icon': 'trend-up'},
            {'id': 'cancelados-mes', 'title': 'CANCELADOS NO MÊS', 'rawValue': customer_summary['canceladosMes'], 'note': 'Status EXPIRED no mês atual com isTrial = NO', 'icon': 'cancel'},
            {'id': 'vencem-hoje', 'title': 'VENCEM HOJE', 'rawValue': customer_summary['vencemHoje'], 'note': 'Somente clientes com isTrial = NO', 'icon': 'calendar'},
        ],
        'charts': {
            'monthForecast': {
                **month_forecast,
                'valueFormatted': str(int(round(month_forecast['total']))),
                'icon': 'forecast-month',
                'accent': '#50cd89',
                'previousColor': '#a7afc3',
                'filterMode': 'date',
            },
            'yearForecast': {
                **year_forecast,
                'valueFormatted': str(int(round(year_forecast['total']))),
                'icon': 'forecast-year',
                'accent': '#f7b731',
                'previousColor': '#a7afc3',
                'filterMode': 'date',
            },
            'newCustomers': {
                **new_customers,
                'title': 'Vendas novos clientes',
                'valueFormatted': str(int(new_customers['total'])),
                'icon': 'sales',
                'accent': '#1ea7ff',
                'previousColor': '#a7afc3',
                'filterMode': 'date',
                'valueMode': 'sum',
            },
            'cancelados': {
                **cancelados_chart,
                'valueFormatted': str(int(cancelados_chart['total'])),
                'icon': 'cancel',
                'accent': '#ff4d7e',
                'previousColor': '#a7afc3',
                'filterMode': 'date',
            },
        },
        'summary': {
            'ativosAgora': customers_breakdown['active'],
            'vendasMes': int(new_customers['total']),
            'canceladosMes': customer_summary['canceladosMes'],
            'vencemHoje': customer_summary['vencemHoje'],
        },
        'validation': {
            'forecastFormula': 'Clientes Atuais + (Vendas Diarias x Dias Restantes) - (Cancelamentos Diarios x Dias Restantes)',
            'forecastAverageRule': 'As medias diarias usam apenas os dados do mes atual ate um dia antes, divididos pelo dia anterior do mes.',
            'cancellationRule': 'Cancelamentos consideram somente clientes com status EXPIRED e isTrial = NO.',
            'currentActiveTotal': projection['currentActiveTotal'],
            'salesUsedThisMonth': projection['salesUsedThisMonth'],
            'cancellationsUsedThisMonth': projection['cancellationsUsedThisMonth'],
            'elapsedDaysMonth': projection['elapsedDaysMonth'],
            'avgDailySales': projection['avgDailySales'],
            'avgDailyCancellations': projection['avgDailyCancellations'],
            'projectedDailySales': projection['projectedDailySales'],
            'projectedDailyCancellations': projection['projectedDailyCancellations'],
            'netDailyVariation': projection['netDailyVariation'],
            'daysRemainingMonth': projection['daysRemainingMonth'],
            'projectedMonthSales': projection['projectedMonthSales'],
            'projectedMonthCancellations': projection['projectedMonthCancellations'],
            'daysRemainingYear': projection['daysRemainingYear'],
            'projectedYearSales': projection['projectedYearSales'],
            'projectedYearCancellations': projection['projectedYearCancellations'],
            'projectedEndMonth': projection['projectedEndMonth'],
            'projectedEndYear': projection['projectedEndYear'],
        },
    }


class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status: int, data: Any) -> None:
        payload = json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_file(self, file_path: Path, content_type: str) -> None:
        content = file_path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _send_bytes(self, status: int, content: bytes, content_type: str, filename: Optional[str] = None) -> None:
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        if filename:
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get('Content-Length', '0') or '0')
        raw = self.rfile.read(length) if length > 0 else b'{}'
        return json.loads(raw.decode('utf-8') or '{}')

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == '/api/metrics':
            return self.handle_metrics()
        if parsed.path == '/api/customers/export.xlsx':
            return self.handle_customers_export()

        static_map = {
            '/': ('index.html', 'text/html; charset=utf-8'),
            '/index.html': ('index.html', 'text/html; charset=utf-8'),
            '/styles.css': ('styles.css', 'text/css; charset=utf-8'),
            '/app.js': ('app.js', 'application/javascript; charset=utf-8'),
        }
        if parsed.path in static_map:
            name, content_type = static_map[parsed.path]
            file_path = PUBLIC_DIR / name
            if file_path.exists():
                return self._send_file(file_path, content_type)
        self._send_json(404, {'error': 'Rota não encontrada.'})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == '/api/login':
            return self.handle_login()
        self._send_json(404, {'error': 'Rota não encontrada.'})

    def handle_login(self) -> None:
        try:
            body = self._read_json_body()
            username = str(body.get('username') or '').strip()
            password = str(body.get('password') or '')
            if not username or not password:
                return self._send_json(400, {'error': 'Informe usuário e senha.'})
            client = ApiClient(API_BASE)
            result = client.login(username, password)
            return self._send_json(200, {'ok': True, **result})
        except ApiError as exc:
            return self._send_json(exc.status, {'error': 'Falha no login.', 'details': str(exc), 'raw': exc.payload})
        except Exception as exc:
            return self._send_json(500, {'error': 'Erro interno no login.', 'details': str(exc)})

    def handle_metrics(self) -> None:
        try:
            auth_header = self.headers.get('Authorization', '')
            token = auth_header[7:] if auth_header.startswith('Bearer ') else ''
            if not token:
                return self._send_json(401, {'error': 'Token não informado.'})

            client = ApiClient(API_BASE)
            raw = {
                'customersCount': client.get_json('/api/resellers/customers-count', token),
                'newCustomers': client.get_json('/api/dashboard/charts/new-customers', token),
                'revenueForecast': client.get_json('/api/dashboard/charts/revenue-forecast', token),
                'customersAll': client.get_all_customers(token, per_page=100),
            }
            metrics = build_metrics(raw)
            return self._send_json(200, {'ok': True, 'metrics': metrics, 'raw': raw})
        except ApiError as exc:
            return self._send_json(exc.status, {'error': 'Falha ao consultar métricas.', 'details': str(exc), 'raw': exc.payload})
        except Exception as exc:
            return self._send_json(500, {'error': 'Erro interno ao consultar métricas.', 'details': str(exc)})

    def handle_customers_export(self) -> None:
        try:
            auth_header = self.headers.get('Authorization', '')
            token = auth_header[7:] if auth_header.startswith('Bearer ') else ''
            if not token:
                return self._send_json(401, {'error': 'Token não informado.'})

            client = ApiClient(API_BASE)
            customers = client.get_all_customers(token, per_page=100)
            rows = customers.get('rows', []) if isinstance(customers, dict) else []
            workbook_bytes = generate_customers_xlsx(rows)
            filename = f"clientes-{datetime.now().strftime('%Y-%m-%d')}.xlsx"
            return self._send_bytes(
                200,
                workbook_bytes,
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                filename,
            )
        except ApiError as exc:
            return self._send_json(exc.status, {'error': 'Falha ao exportar clientes.', 'details': str(exc), 'raw': exc.payload})
        except Exception as exc:
            return self._send_json(500, {'error': 'Erro interno ao exportar clientes.', 'details': str(exc)})


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    log(f'Servidor local em http://localhost:{PORT}')
    log(f'API_BASE: {API_BASE}')
    server.serve_forever()
