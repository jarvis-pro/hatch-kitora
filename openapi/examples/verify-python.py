"""可运行的 Python 示例：直接嵌入 FastAPI / Flask / Django 处理器。

冒烟测试运行方式：
    python openapi/examples/verify-python.py
"""
import hmac
import hashlib
import time

MAX_AGE = 300  # seconds — must match Kitora's window


def verify_kitora_signature(*, header: str, body: bytes, secret: str, now: float | None = None) -> bool:
    """若 X-Kitora-Signature 请求头对 `body` 有效则返回 True。

    `body` 必须是原始请求字节（不得重新序列化 JSON 字典）。
    """
    if now is None:
        now = time.time()
    parts = dict(p.strip().split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t = int(parts["t"])
    except (KeyError, ValueError):
        return False
    if abs(now - t) > MAX_AGE:
        return False
    signed_payload = f"{t}.".encode() + body
    expected = hmac.new(secret.encode(), signed_payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))


if __name__ == "__main__":
    secret = "whsec_test_secret"
    body = b'{"id":"evt_1","type":"subscription.created"}'
    t = int(time.time())
    v1 = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    header = f"t={t},v1={v1}"
    print("OK" if verify_kitora_signature(header=header, body=body, secret=secret) else "FAIL")
