"""Independent stdlib reference for fixed quota-history-v1 bytes/digests.
Not imported or executed by the TypeScript implementation or CI tests.
Run manually: python tests/fixtures/generate-history-fingerprint-vectors.py
"""
import hashlib
import json
import struct
from pathlib import Path


def tlv(tag, value):
    payload = value.encode("utf-8") if isinstance(value, str) else str(value).encode("ascii")
    return bytes([tag]) + struct.pack(">I", len(payload)) + payload


def reference(history):
    fields = [tlv(1, "quota-history-v1")]
    metadata = history["metadata"]
    if metadata is None:
        fields += [bytes.fromhex("0400000000"), tlv(5, 0)]
    else:
        fields += [tlv(1, metadata["providerKey"]), tlv(1, metadata["historyStatus"]), tlv(2, metadata["initializedAtMs"]), tlv(2, metadata["lastSequence"]), tlv(5, len(history["consumptions"]))]
        for row in history["consumptions"]:
            fields += [tlv(2, row["sequence"]), tlv(2, row["reservedAtMs"])]
    data = b"".join(fields)
    return data.hex(), hashlib.sha256(data).hexdigest()


def provisioned(provider="p", status="ACTIVE", times=()):
    return {"metadata": {"providerKey": provider, "historyStatus": status, "initializedAtMs": 0, "lastSequence": len(times)}, "consumptions": [{"sequence": i + 1, "reservedAtMs": timestamp} for i, timestamp in enumerate(times)]}


inputs = [
    ("unprovisioned", {"metadata": None, "consumptions": []}),
    ("provisioned-zero", provisioned()),
    ("provisioned-one", provisioned(status="SUSPENDED", times=(10,))),
    ("provisioned-multiple", provisioned(times=(10, 20))),
    ("multibyte", provisioned("天気☔", times=(0, 8640000000000000))),
    ("nfc", provisioned("é")),
    ("nfd", provisioned("e\u0301")),
    ("length-300", provisioned("a" * 300)),
]
result = []
for name, history in inputs:
    raw, digest = reference(history)
    result.append({"name": name, "history": history, "hex": raw, "digest": digest})
Path(__file__).with_name("quota-history-v1-vectors.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
