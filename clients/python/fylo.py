"""Fylo client — drives the `fylo` binary's persistent NDJSON loop.

No pip dependencies. Requires the `fylo` binary on PATH (brew/scoop) or an
explicit path. One long-lived subprocess keeps the engine warm across calls.

    from fylo import Fylo

    with Fylo("/path/to/db") as db:
        db.create_collection("users")
        doc_id = db.put_data("users", {"name": "Ada", "role": "admin"})
        doc = db.get_latest("users", doc_id)
        admins = db.find_docs("users", {"$ops": [{"role": {"$eq": "admin"}}]})

Each operation method builds the request, sends it, and returns the operation's
`result` (raising FyloError on failure). Method names follow Python's snake_case
convention. `request(op)` remains as a raw escape hatch returning the full
response dict — use it for ops without a dedicated method (branching, schema).
"""

import json
import asyncio
import functools
import inspect
import subprocess
import threading

MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024


class FyloError(RuntimeError):
    pass


class Fylo:
    def __init__(self, root, binary="fylo"):
        args = [
            binary,
            "exec",
            "--loop",
            "--root",
            root,
            "--max-request-bytes",
            str(MAX_REQUEST_BYTES),
            "--max-response-bytes",
            str(MAX_RESPONSE_BYTES),
        ]
        self._proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            bufsize=0,
        )
        self._lock = threading.Lock()

    def request(self, op):
        """Send one raw machine-protocol op; return the full response dict."""
        line = json.dumps(op, separators=(",", ":")).encode("utf-8")
        if len(line) > MAX_REQUEST_BYTES:
            raise FyloError(f"FYLO request exceeds {MAX_REQUEST_BYTES} bytes")
        with self._lock:  # ponytail: one call in flight; drop the lock only if you pipeline
            if self._proc.poll() is not None:
                raise FyloError("fylo process has exited")
            self._proc.stdin.write(line + b"\n")
            self._proc.stdin.flush()
            reply = self._proc.stdout.readline(MAX_RESPONSE_BYTES + 2)
        if not reply:
            raise FyloError("fylo closed the stream (stderr may have details)")
        if not reply.endswith(b"\n") or len(reply) - 1 > MAX_RESPONSE_BYTES:
            self._proc.kill()
            raise FyloError(f"FYLO response exceeds {MAX_RESPONSE_BYTES} bytes")
        try:
            return json.loads(reply[:-1].decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            self._proc.kill()
            raise FyloError("fylo returned malformed UTF-8 or JSON") from error

    def _op(self, op, **fields):
        payload = {"op": op}
        for key, value in fields.items():
            if value is not None:
                payload[key] = value
        response = self.request(payload)
        if not response.get("ok"):
            raise FyloError((response.get("error") or {}).get("message", "fylo error"))
        return response.get("result")

    # --- Collections ---
    def create_collection(self, collection, kind="document"):
        return self._op("createCollection", collection=collection, kind=kind)

    def drop_collection(self, collection):
        return self._op("dropCollection", collection=collection)

    def inspect_collection(self, collection):
        return self._op("inspectCollection", collection=collection)

    def rebuild_collection(self, collection):
        return self._op("rebuildCollection", collection=collection)

    # --- Durable serverless queue ---
    def queue_publish(self, topic, payload, delay_ms=None, idempotency_key=None):
        return self._op(
            "queuePublish",
            topic=topic,
            payload=payload,
            delayMs=delay_ms,
            idempotencyKey=idempotency_key,
        )

    def queue_claim(
        self, topic, group, max_messages=None, visibility_timeout_ms=None, max_attempts=None
    ):
        return self._op(
            "queueClaim",
            topic=topic,
            group=group,
            maxMessages=max_messages,
            visibilityTimeoutMs=visibility_timeout_ms,
            maxAttempts=max_attempts,
        )

    def queue_ack(self, topic, group, id, receipt):
        return self._op("queueAck", topic=topic, group=group, id=id, receipt=receipt)

    def queue_nack(self, topic, group, id, receipt, delay_ms=None, reason=None):
        return self._op(
            "queueNack",
            topic=topic,
            group=group,
            id=id,
            receipt=receipt,
            delayMs=delay_ms,
            reason=reason,
        )

    def queue_extend(self, topic, group, id, receipt, visibility_timeout_ms=None):
        return self._op(
            "queueExtend",
            topic=topic,
            group=group,
            id=id,
            receipt=receipt,
            visibilityTimeoutMs=visibility_timeout_ms,
        )

    def queue_stats(self, topic, group):
        return self._op("queueStats", topic=topic, group=group)

    def queue_dead_letters(self, topic, group, limit=None):
        return self._op("queueDeadLetters", topic=topic, group=group, limit=limit)

    def queue_process(
        self,
        topic,
        group,
        handler,
        max_messages=1,
        visibility_timeout_ms=30000,
        max_attempts=3,
        retry_delay_ms=0,
    ):
        """Process and settle one bounded batch; handler failures are retried."""
        if not callable(handler):
            raise TypeError("queue handler must be callable")
        deliveries = self.queue_claim(
            topic,
            group,
            max_messages=max_messages,
            visibility_timeout_ms=visibility_timeout_ms,
            max_attempts=max_attempts,
        )
        result = {
            "claimed": len(deliveries),
            "acknowledged": 0,
            "retried": 0,
            "deadLettered": 0,
        }
        for delivery in deliveries:
            failed = False
            try:
                outcome = handler(delivery)
                if inspect.isawaitable(outcome):
                    if inspect.iscoroutine(outcome):
                        outcome.close()
                    raise TypeError("async queue handlers require queue_process_async")
            except Exception:
                failed = True
            if not failed:
                self.queue_ack(topic, group, delivery["id"], delivery["receipt"])
                result["acknowledged"] += 1
            else:
                settled = self.queue_nack(
                    topic,
                    group,
                    delivery["id"],
                    delivery["receipt"],
                    delay_ms=retry_delay_ms,
                    reason="queue handler failed",
                )
                key = "deadLettered" if settled.get("deadLettered") else "retried"
                result[key] += 1
        return result

    def queue_consumer(
        self,
        topic,
        group,
        *,
        max_messages=1,
        visibility_timeout_ms=30000,
        max_attempts=3,
        retry_delay_ms=0,
    ):
        """Decorate a function or method as a one-batch queue invocation."""

        def decorate(handler):
            if not callable(handler):
                raise TypeError("queue consumer can decorate only a callable")

            if inspect.iscoroutinefunction(handler):

                @functools.wraps(handler)
                async def async_consumer(*args, **kwargs):
                    return await self.queue_process_async(
                        topic,
                        group,
                        lambda delivery: handler(*args, delivery, **kwargs),
                        max_messages=max_messages,
                        visibility_timeout_ms=visibility_timeout_ms,
                        max_attempts=max_attempts,
                        retry_delay_ms=retry_delay_ms,
                    )

                async_consumer.__fylo_queue_consumer__ = {
                    "topic": topic,
                    "group": group,
                    "maxMessages": max_messages,
                    "visibilityTimeoutMs": visibility_timeout_ms,
                    "maxAttempts": max_attempts,
                    "retryDelayMs": retry_delay_ms,
                }
                return async_consumer

            @functools.wraps(handler)
            def consumer(*args, **kwargs):
                return self.queue_process(
                    topic,
                    group,
                    lambda delivery: handler(*args, delivery, **kwargs),
                    max_messages=max_messages,
                    visibility_timeout_ms=visibility_timeout_ms,
                    max_attempts=max_attempts,
                    retry_delay_ms=retry_delay_ms,
                )

            consumer.__fylo_queue_consumer__ = {
                "topic": topic,
                "group": group,
                "maxMessages": max_messages,
                "visibilityTimeoutMs": visibility_timeout_ms,
                "maxAttempts": max_attempts,
                "retryDelayMs": retry_delay_ms,
            }
            return consumer

        return decorate

    async def queue_process_async(
        self,
        topic,
        group,
        handler,
        max_messages=1,
        visibility_timeout_ms=30000,
        max_attempts=3,
        retry_delay_ms=0,
    ):
        """Async-handler variant; blocking protocol calls run off the event loop."""
        deliveries = await asyncio.to_thread(
            self.queue_claim,
            topic,
            group,
            max_messages,
            visibility_timeout_ms,
            max_attempts,
        )
        result = {
            "claimed": len(deliveries),
            "acknowledged": 0,
            "retried": 0,
            "deadLettered": 0,
        }
        for delivery in deliveries:
            failed = False
            try:
                await handler(delivery)
            except Exception:
                failed = True
            if not failed:
                await asyncio.to_thread(
                    self.queue_ack, topic, group, delivery["id"], delivery["receipt"]
                )
                result["acknowledged"] += 1
            else:
                settled = await asyncio.to_thread(
                    self.queue_nack,
                    topic,
                    group,
                    delivery["id"],
                    delivery["receipt"],
                    retry_delay_ms,
                    "queue handler failed",
                )
                key = "deadLettered" if settled.get("deadLettered") else "retried"
                result[key] += 1
        return result

    # --- Documents ---
    def put_data(self, collection, data):
        return self._op("putData", collection=collection, data=data)

    def batch_put_data(self, collection, batch):
        return self._op("batchPutData", collection=collection, batch=batch)

    def get_doc(self, collection, id):
        return self._op("getDoc", collection=collection, id=id)

    def get_meta(self, collection, id):
        return self._op("getMeta", collection=collection, id=id)

    def set_meta(self, collection, id, meta):
        return self._op("setMeta", collection=collection, id=id, meta=meta)

    def get_latest(self, collection, id, only_id=False):
        return self._op("getLatest", collection=collection, id=id, onlyId=only_id)

    def patch_doc(self, collection, id, new_doc, old_doc=None):
        return self._op("patchDoc", collection=collection, id=id, newDoc=new_doc, oldDoc=old_doc)

    def patch_docs(self, collection, update):
        return self._op("patchDocs", collection=collection, update=update)

    def del_doc(self, collection, id):
        return self._op("delDoc", collection=collection, id=id)

    def del_docs(self, collection, criteria):
        return self._op("delDocs", collection=collection, delete=criteria)

    def restore_doc(self, collection, id):
        return self._op("restoreDoc", collection=collection, id=id)

    # --- Query ---
    def find_docs(self, collection, query):
        return self._op("findDocs", collection=collection, query=query)

    def find_deleted_docs(self, collection, query=None):
        return self._op("findDeletedDocs", collection=collection, query=query or {})

    def find_docs_page(self, collection, query, page=None):
        return self._op("findDocs", collection=collection, query=query, page=page or {})

    def find_deleted_docs_page(self, collection, query=None, page=None):
        return self._op(
            "findDeletedDocs", collection=collection, query=query or {}, page=page or {}
        )

    def join_docs(self, join):
        return self._op("joinDocs", join=join)

    def execute_sql(self, sql, access=None):
        return self._op("executeSQL", sql=sql, access=access)

    def sql(self, query, access=None):
        """Run raw SQL, built with a native f-string: db.sql(f"... {x}").
        Values are inlined verbatim — escape/validate untrusted input yourself.
        """
        return self.execute_sql(query, access)

    def import_bulk_data(self, collection, url, limit_or_options=None):
        return self._op(
            "importBulkData", collection=collection, url=url, limitOrOptions=limit_or_options
        )

    # Collection-scoped facade with short method names, so
    # `db.collection("users").put(data)` reads like the browser client.
    def collection(self, name):
        return _Collection(self, name)

    def close(self):
        if self._proc.poll() is None:
            self._proc.stdin.close()
            self._proc.wait(timeout=30)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def __getattr__(self, name):
        # Sugar: `db.users.put(...)` -> `db.collection("users").put(...)`. Only
        # fires for names that aren't real attributes; skip private/dunder.
        if name.startswith("_"):
            raise AttributeError(name)
        return _Collection(self, name)


class _Collection:
    """A collection-scoped view; methods drop the leading collection argument."""

    def __init__(self, db, name):
        self._db = db
        self._name = name

    def create(self, kind="document"):
        return self._db.create_collection(self._name, kind)

    def drop(self):
        return self._db.drop_collection(self._name)

    def inspect(self):
        return self._db.inspect_collection(self._name)

    def rebuild(self):
        return self._db.rebuild_collection(self._name)

    def put(self, data):
        return self._db.put_data(self._name, data)

    def get(self, id):
        return self._db.get_doc(self._name, id)

    def get_metadata(self, id):
        return self._db.get_meta(self._name, id)

    def set_metadata(self, id, meta):
        return self._db.set_meta(self._name, id, meta)

    def latest(self, id, only_id=False):
        return self._db.get_latest(self._name, id, only_id)

    def patch(self, id, new_doc, old_doc=None):
        return self._db.patch_doc(self._name, id, new_doc, old_doc)

    def delete(self, id):
        return self._db.del_doc(self._name, id)

    def restore(self, id):
        return self._db.restore_doc(self._name, id)

    def find(self, query):
        return self._db.find_docs(self._name, query)

    def find_page(self, query, page=None):
        return self._db.find_docs_page(self._name, query, page)
