from datetime import datetime, timezone
from pathlib import Path
import json
import os

from flask import Flask, request, jsonify
import requests


app = Flask(__name__)

NEWBR_BASE_URL = os.getenv("NEWBR_BASE_URL", "https://painel.newbr.top")
NEWBR_APP_VERSION = os.getenv("NEWBR_APP_VERSION", "3.81")
NEWBR_LOCALE = os.getenv("NEWBR_LOCALE", "pt")
NEWBR_USER_AGENT = os.getenv(
    "NEWBR_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
)

RUNTIME_DIR = Path(os.getenv("NEWBR_RUNTIME_DIR", "/var/www/newbr-login/runtime"))
TOKENS_DIR = RUNTIME_DIR / "tokens"
RENEWALS_DIR = RUNTIME_DIR / "renewals"
LOGS_DIR = RUNTIME_DIR / "logs"


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def ensure_dirs():
    for directory in [RUNTIME_DIR, TOKENS_DIR, RENEWALS_DIR, LOGS_DIR]:
        directory.mkdir(parents=True, exist_ok=True)


def safe_key(value: str) -> str:
    return "".join(ch for ch in str(value) if ch.isalnum() or ch in ("-", "_", "."))[:140]


def read_json(path: Path):
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data):
    ensure_dirs()
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def token_path(account_key: str) -> Path:
    return TOKENS_DIR / f"{safe_key(account_key or 'default')}.json"


def renewal_path(external_reference: str) -> Path:
    return RENEWALS_DIR / f"{safe_key(external_reference)}.json"


def newbr_headers(token: str):
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "Locale": NEWBR_LOCALE,
        "X-App-Version": NEWBR_APP_VERSION,
        "Origin": NEWBR_BASE_URL,
        "Referer": f"{NEWBR_BASE_URL}/",
        "User-Agent": NEWBR_USER_AGENT
    }


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "service": "newbr-renewal-api",
        "time": now_iso()
    })


@app.post("/api/local/newbr/browser-start")
def browser_start():
    body = request.get_json(silent=True) or {}

    payload = {
        "mode": body.get("mode", "browser_manual"),
        "startedAt": body.get("startedAt") or now_iso(),
        "source": body.get("source", "browser-newbr"),
        "account_key": body.get("account_key", "default"),
        "renewal": body.get("renewal")
    }

    write_json(LOGS_DIR / f"browser-start-{safe_key(payload['account_key'])}.json", payload)

    return jsonify(payload), 202


@app.post("/api/local/newbr/browser-token")
def browser_token():
    body = request.get_json(silent=True) or {}

    account_key = body.get("account_key", "default")
    token = str(body.get("token", "")).strip()
    status = body.get("status")
    source = body.get("source", "browser-newbr")

    if not token or len(token) < 20:
        return jsonify({
            "ok": False,
            "message": "Token inválido ou ausente."
        }), 400

    payload = {
        "ok": True,
        "account_key": account_key,
        "source": source,
        "status": status,
        "receivedAt": now_iso(),
        "token": token
    }

    write_json(token_path(account_key), payload)

    return jsonify({
        "ok": True,
        "message": "Token recebido e salvo com sucesso.",
        "account_key": account_key,
        "receivedAt": payload["receivedAt"]
    })


@app.post("/api/local/newbr/renewal-intent")
def renewal_intent():
    body = request.get_json(silent=True) or {}

    account_key = body.get("account_key", "default")
    customer_id = str(body.get("customer_id", "")).strip()
    package_id = str(body.get("package_id", "")).strip()
    external_reference = str(body.get("external_reference", "")).strip()
    connections = body.get("connections", 1)

    if not customer_id:
        return jsonify({"ok": False, "message": "customer_id é obrigatório."}), 400

    if not package_id:
        return jsonify({"ok": False, "message": "package_id é obrigatório."}), 400

    try:
        connections = int(connections)
    except Exception:
        return jsonify({"ok": False, "message": "connections precisa ser número."}), 400

    if connections < 1:
        return jsonify({"ok": False, "message": "connections precisa ser maior ou igual a 1."}), 400

    if not external_reference:
        external_reference = f"newbr-renew-{customer_id}-{package_id}"

    existing = read_json(renewal_path(external_reference)) or {}

    payload = {
        **existing,
        "ok": True,
        "status": existing.get("status", "pending_payment"),
        "account_key": account_key,
        "customer_id": customer_id,
        "package_id": package_id,
        "connections": connections,
        "external_reference": external_reference,
        "createdAt": existing.get("createdAt") or now_iso(),
        "updatedAt": now_iso()
    }

    write_json(renewal_path(external_reference), payload)

    return jsonify({
        "ok": True,
        "message": "Renovação pendente registrada.",
        "renewal": payload
    })


@app.post("/api/local/newbr/renewal-result")
def renewal_result():
    body = request.get_json(silent=True) or {}

    external_reference = str(body.get("external_reference", "")).strip()
    if not external_reference:
        return jsonify({"ok": False, "message": "external_reference é obrigatório."}), 400

    renewal = read_json(renewal_path(external_reference)) or {
        "external_reference": external_reference,
        "createdAt": now_iso()
    }

    newbr_ok = bool(body.get("newbr_ok"))
    newbr_status = body.get("newbr_status")

    renewal.update({
        "ok": True,
        "account_key": body.get("account_key", renewal.get("account_key", "default")),
        "customer_id": body.get("customer_id", renewal.get("customer_id")),
        "package_id": body.get("package_id", renewal.get("package_id")),
        "connections": body.get("connections", renewal.get("connections")),
        "trigger_source": body.get("trigger_source", "browser_manual_now"),
        "lastRenewAttemptAt": now_iso(),
        "lastRenewStatusCode": newbr_status,
        "lastRenewResponse": body.get("newbr_response"),
        "status": "renewed" if newbr_ok else "renew_failed",
        "renewedAt": body.get("renewedAt") if newbr_ok else renewal.get("renewedAt"),
        "updatedAt": now_iso()
    })

    write_json(renewal_path(external_reference), renewal)

    return jsonify({
        "ok": True,
        "message": "Resultado da renovação salvo.",
        "renewal": renewal
    })


@app.get("/api/local/newbr/renewal-status")
def renewal_status():
    external_reference = request.args.get("external_reference", "").strip()
    account_key = request.args.get("account_key", "default")

    if not external_reference:
        return jsonify({"ok": False, "message": "external_reference é obrigatório."}), 400

    renewal = read_json(renewal_path(external_reference))
    token_data = read_json(token_path(account_key))
    token = token_data.get("token") if token_data else None

    return jsonify({
        "ok": True,
        "external_reference": external_reference,
        "renewal": renewal,
        "token": {
            "hasToken": bool(token),
            "receivedAt": token_data.get("receivedAt") if token_data else None,
            "account_key": account_key,
            "tokenPreview": f"{token[:20]}...{token[-12:]}" if token else None
        }
    })


@app.post("/api/local/newbr/renew-now")
def renew_now_backend():
    body = request.get_json(silent=True) or {}
    external_reference = str(body.get("external_reference", "")).strip()

    if not external_reference:
        return jsonify({"ok": False, "message": "external_reference é obrigatório."}), 400

    return execute_backend_renewal(external_reference, "manual_backend")


@app.post("/api/webhooks/mercadopago/newbr-renew")
def mercadopago_newbr_renew_webhook():
    body = request.get_json(silent=True) or {}

    status = body.get("status") or body.get("payment_status")
    external_reference = body.get("external_reference") or body.get("externalReference")

    if status not in ("approved", "paid"):
        return jsonify({
            "ok": True,
            "ignored": True,
            "message": "Webhook recebido, mas pagamento ainda não foi aprovado.",
            "status": status
        }), 202

    if not external_reference:
        return jsonify({
            "ok": False,
            "message": "external_reference não encontrado no webhook."
        }), 400

    return execute_backend_renewal(external_reference, "mercadopago_webhook")


def execute_backend_renewal(external_reference: str, trigger_source: str):
    renewal = read_json(renewal_path(external_reference))

    if not renewal:
        return jsonify({
            "ok": False,
            "message": "Renovação pendente não encontrada.",
            "external_reference": external_reference
        }), 404

    if renewal.get("status") == "renewed":
        return jsonify({
            "ok": True,
            "alreadyRenewed": True,
            "message": "Esta renovação já foi executada anteriormente.",
            "renewal": renewal
        }), 200

    account_key = renewal.get("account_key", "default")
    token_data = read_json(token_path(account_key))

    if not token_data or not token_data.get("token"):
        return jsonify({
            "ok": False,
            "message": "Token NewBR não encontrado. Clique na tela para preparar o token antes de renovar.",
            "account_key": account_key
        }), 400

    token = token_data["token"]

    url = f"{NEWBR_BASE_URL}/api/customers/{renewal['customer_id']}/renew"
    payload = {
        "package_id": renewal["package_id"],
        "connections": int(renewal["connections"])
    }

    try:
        response = requests.post(
            url,
            headers=newbr_headers(token),
            json=payload,
            timeout=30
        )

        try:
            data = response.json()
        except ValueError:
            data = {"raw": response.text[:3000]}

        renewal["lastRenewAttemptAt"] = now_iso()
        renewal["lastRenewStatusCode"] = response.status_code
        renewal["lastRenewResponse"] = data
        renewal["trigger_source"] = trigger_source
        renewal["updatedAt"] = now_iso()

        if response.ok:
            renewal["status"] = "renewed"
            renewal["renewedAt"] = now_iso()
            message = "Cliente renovado com sucesso."
        else:
            renewal["status"] = "renew_failed"
            message = "Falha ao renovar cliente na NewBR."

        write_json(renewal_path(external_reference), renewal)

        return jsonify({
            "ok": response.ok,
            "message": message,
            "status_code": response.status_code,
            "renewal": renewal,
            "newbr_response": data
        }), response.status_code

    except requests.RequestException as error:
        renewal["status"] = "renew_error"
        renewal["lastRenewAttemptAt"] = now_iso()
        renewal["lastRenewError"] = str(error)
        renewal["updatedAt"] = now_iso()
        write_json(renewal_path(external_reference), renewal)

        return jsonify({
            "ok": False,
            "message": "Erro HTTP ao chamar renovação NewBR.",
            "error": str(error),
            "renewal": renewal
        }), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8091, debug=False)
