"""Minimal client for the Reap Agentic Payments API (https://docs.reap.global/agentic-payments)."""
import uuid

import requests

DEFAULT_BASE_URL = "https://sandbox.api.reap.global"
API_VERSION = "2025-02-14"


class ReapError(Exception):
    def __init__(self, status, body):
        super().__init__(f"Reap API error {status}: {body}")
        self.status = status
        self.body = body


class ReapClient:
    def __init__(self, api_key, base_url=DEFAULT_BASE_URL, api_version=API_VERSION, timeout=30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update(
            {"Authorization": f"Bearer {api_key}", "Reap-Version": api_version}
        )

    def _request(self, method, path, json=None, params=None, idempotent=False, headers=None):
        hdrs = dict(headers or {})
        if idempotent:
            hdrs["Idempotency-Key"] = str(uuid.uuid4())
        resp = self.session.request(
            method, f"{self.base_url}{path}", json=json, params=params,
            headers=hdrs, timeout=self.timeout,
        )
        if not resp.ok:
            raise ReapError(resp.status_code, resp.text)
        return resp.json() if resp.content else None

    def get_enrollment(self, enrollment_id):
        return self._request("GET", f"/agentic/enrollments/{enrollment_id}")

    def search_products(self, query, country="US", currency="USD", limit=10, merchant_preference=None):
        body = {
            "query": query,
            "context": {"country": country, "currency": currency},
            "filters": {"availability": "AVAILABLE_ONLY"},
            "pagination": {"limit": limit},
        }
        if merchant_preference:
            body["merchantPreference"] = merchant_preference
        return self._request("POST", "/agentic/products/search", json=body)

    def create_quote(self, items, email, shipping_address=None):
        body = {"items": items, "email": email}
        if shipping_address:
            body["shippingAddress"] = shipping_address
        return self._request("POST", "/agentic/quotes", json=body, idempotent=True)

    def create_checkout(self, quote_id, enrollment_id, return_url, simulate=None):
        body = {
            "quoteId": quote_id,
            "enrollmentId": enrollment_id,
            "presentation": {"type": "REDIRECT", "returnUrl": return_url},
        }
        headers = {"X-Simulate-Checkout": simulate} if simulate else None
        return self._request("POST", "/agentic/checkouts", json=body, idempotent=True, headers=headers)

    def get_checkout(self, checkout_id):
        return self._request("GET", f"/agentic/checkouts/{checkout_id}")
