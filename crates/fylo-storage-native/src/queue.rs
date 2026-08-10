//! Durable brokerless queues rooted in the FYLO filesystem.
//!
//! Messages are immutable and globally ordered. Each consumer group owns one
//! atomically replaced state file containing a compacted cursor and the small
//! set of messages between that cursor and its scan frontier. A claim is
//! durable before it is returned, so a worker crash causes redelivery after
//! the visibility lease rather than message loss.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use fylo_vfs as fs;
use hmac::{Hmac, KeyInit, Mac};
use serde::de::{DeserializeOwned, IgnoredAny};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::write::{ensure_directory, unix_millis};
use super::{
    ExpectedType, NativeRoot, NativeStorageError, NativeStorageErrorCode, RootLease,
    is_scratch_file, path_exists_no_follow,
};

const QUEUE_FORMAT: &str = "fylo.queue.v1";
const MESSAGE_FORMAT: &str = "fylo.queue-message.v1";
const GROUP_FORMAT: &str = "fylo.queue-consumer.v1";
const DEAD_LETTER_FORMAT: &str = "fylo.queue-dead-letter.v1";
const DEDUPE_FORMAT: &str = "fylo.queue-dedupe.v1";
const RECEIPT_KEY_FORMAT: &str = "fylo.queue-receipt-key.v1";
const MAX_NAME_BYTES: usize = 127;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 1024;
const MAX_MESSAGE_BYTES: u64 = 1024 * 1024;
const MAX_DEDUPE_BYTES: u64 = MAX_MESSAGE_BYTES + 4096;
const MAX_DEAD_LETTER_BYTES: u64 = MAX_MESSAGE_BYTES + 8192;
const MAX_STATE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PENDING_MESSAGES: usize = 10_000;
const MAX_ACKNOWLEDGED_RECEIPTS: usize = 1_000;
const MAX_CLAIM_MESSAGES: usize = 1_000;
const DEFAULT_VISIBILITY_TIMEOUT_MS: u64 = 30_000;
const MIN_VISIBILITY_TIMEOUT_MS: u64 = 100;
const MAX_VISIBILITY_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS: u32 = 3;
const MAX_ATTEMPTS: u32 = 100;
const MAX_DELAY_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const MAX_DEAD_LETTERS: usize = 1_000;
const DEFAULT_READ_BUDGET_BYTES: usize = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 100_000;
const MAX_QUEUE_SCAN_BYTES: u64 = 64 * 1024 * 1024;
const DELIVERY_ENVELOPE_ALLOWANCE: u64 = 512;

/// Options applied while publishing one immutable message.
#[derive(Clone, Debug, Default)]
pub struct QueuePublishOptions {
    /// Do not make the message claimable before this delay elapses.
    pub delay_ms: u64,
    /// Optional producer key that makes retries return the original message.
    pub idempotency_key: Option<String>,
}

/// Result of a durable queue publication.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuePublishResult {
    /// Stable globally ordered message identifier.
    pub id: String,
    /// Whether an existing idempotent publication was returned.
    pub deduplicated: bool,
}

/// Claim behavior for one consumer group poll.
#[derive(Clone, Copy, Debug)]
pub struct QueueClaimOptions {
    /// Maximum messages returned by one call.
    pub max_messages: usize,
    /// Time during which another worker in the group cannot claim the message.
    pub visibility_timeout_ms: u64,
    /// Delivery attempts before the message enters this group's dead letter set.
    pub max_attempts: u32,
    /// Maximum aggregate encoded delivery bytes returned by one claim.
    pub max_bytes: usize,
}

impl Default for QueueClaimOptions {
    fn default() -> Self {
        Self {
            max_messages: 1,
            visibility_timeout_ms: DEFAULT_VISIBILITY_TIMEOUT_MS,
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            max_bytes: DEFAULT_READ_BUDGET_BYTES,
        }
    }
}

/// One leased delivery returned to a worker.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueDelivery {
    /// Message identifier.
    pub id: String,
    /// Topic supplied by the producer.
    pub topic: String,
    /// Original publication time in Unix milliseconds.
    pub published_at: u64,
    /// One-based delivery attempt for this consumer group.
    pub attempt: u32,
    /// Opaque receipt required by acknowledgement, rejection, and extension.
    pub receipt: String,
    /// Unix millisecond at which this claim becomes visible again.
    pub lease_expires_at: u64,
    /// Producer payload.
    pub payload: Value,
}

/// Acknowledgement result.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueAckResult {
    /// The message is durably retired for this group.
    pub acknowledged: bool,
    /// The same successful receipt was acknowledged recently.
    pub duplicate: bool,
}

/// Negative-acknowledgement result.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueNackResult {
    /// The message exhausted its attempts and entered the group DLQ.
    pub dead_lettered: bool,
    /// Earliest next claim time, absent after dead lettering.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_at: Option<u64>,
}

/// Durable group-specific dead-letter record.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueDeadLetter {
    format: String,
    /// Source message identifier.
    pub id: String,
    /// Consumer group that exhausted delivery.
    pub group: String,
    /// Source topic.
    pub topic: String,
    /// Total attempts made by this group.
    pub attempts: u32,
    /// Bounded diagnostic supplied by the worker.
    pub reason: String,
    /// Dead-letter time in Unix milliseconds.
    pub dead_lettered_at: u64,
    /// Original publication time.
    pub published_at: u64,
    /// Original payload.
    pub payload: Value,
}

/// Queue depth and consumer-group state.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStats {
    /// Immutable messages published to the topic.
    pub published: usize,
    /// Messages currently claimable by the selected group.
    pub available: usize,
    /// Messages waiting for their publication or retry delay.
    pub delayed: usize,
    /// Messages with active visibility leases.
    pub in_flight: usize,
    /// Messages durably acknowledged or dead-lettered for the group.
    pub retired: usize,
    /// Group-specific dead letters.
    pub dead_lettered: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueueManifest {
    format: String,
    next_sequence: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReceiptKey {
    format: String,
    key: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredMessage {
    format: String,
    id: String,
    topic: String,
    published_at: u64,
    available_at: u64,
    payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredMessageHeader {
    format: String,
    id: String,
    topic: String,
    published_at: u64,
    available_at: u64,
    #[serde(rename = "payload")]
    _payload: IgnoredAny,
}

#[derive(Clone, Copy, Debug)]
struct ScanBudget {
    remaining: u64,
}

impl ScanBudget {
    const fn new(bytes: u64) -> Self {
        Self { remaining: bytes }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DedupeRecord {
    format: String,
    topic: String,
    payload_hash: String,
    message: StoredMessage,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConsumerState {
    format: String,
    topic: String,
    group: String,
    cursor: Option<String>,
    scan_cursor: Option<String>,
    pending: BTreeMap<String, DeliveryState>,
    #[serde(default)]
    acknowledged: BTreeMap<String, String>,
    #[serde(default)]
    acknowledged_order: Vec<String>,
}

impl ConsumerState {
    fn new(topic: &str, group: &str) -> Self {
        Self {
            format: GROUP_FORMAT.into(),
            topic: topic.into(),
            group: group.into(),
            cursor: None,
            scan_cursor: None,
            pending: BTreeMap::new(),
            acknowledged: BTreeMap::new(),
            acknowledged_order: Vec::new(),
        }
    }

    fn validate(&self, topic: &str, group: &str) -> Result<(), NativeStorageError> {
        if self.format != GROUP_FORMAT || self.topic != topic || self.group != group {
            return Err(queue_error("queue consumer state has an invalid identity"));
        }
        if self.pending.len() > MAX_PENDING_MESSAGES {
            return Err(limit_error(
                "queue consumer state exceeds its pending-message limit",
            ));
        }
        if self.acknowledged.len() > MAX_ACKNOWLEDGED_RECEIPTS
            || self.acknowledged_order.len() != self.acknowledged.len()
            || self.acknowledged_order.len() > MAX_ACKNOWLEDGED_RECEIPTS
            || self
                .acknowledged
                .iter()
                .any(|(id, receipt)| !valid_message_id(id) || !valid_receipt(receipt))
            || self
                .acknowledged_order
                .iter()
                .any(|id| !self.acknowledged.contains_key(id))
            || self
                .acknowledged_order
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != self.acknowledged_order.len()
        {
            return Err(queue_error(
                "queue consumer state contains invalid acknowledged receipts",
            ));
        }
        if self
            .cursor
            .as_deref()
            .is_some_and(|id| !valid_message_id(id))
            || self
                .scan_cursor
                .as_deref()
                .is_some_and(|id| !valid_message_id(id))
            || self.cursor > self.scan_cursor
        {
            return Err(queue_error("queue consumer cursors are inconsistent"));
        }
        if self
            .pending
            .iter()
            .any(|(id, state)| !valid_message_id(id) || !valid_delivery_state(state))
        {
            return Err(queue_error(
                "queue consumer state contains an invalid delivery",
            ));
        }
        Ok(())
    }

    fn normalize_acknowledged_order(&mut self) {
        if self.acknowledged_order.is_empty() && !self.acknowledged.is_empty() {
            self.acknowledged_order
                .extend(self.acknowledged.keys().cloned());
        }
        while self.acknowledged_order.len() > MAX_ACKNOWLEDGED_RECEIPTS {
            let oldest = self.acknowledged_order.remove(0);
            self.acknowledged.remove(&oldest);
        }
    }

    fn compact(&mut self) {
        while let Some((id, state)) = self.pending.first_key_value() {
            if !matches!(state, DeliveryState::Completed) {
                break;
            }
            let id = id.clone();
            self.pending.remove(&id);
            self.cursor = Some(id);
        }
        if self.pending.is_empty() && self.scan_cursor > self.cursor {
            self.cursor.clone_from(&self.scan_cursor);
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum DeliveryState {
    Available {
        available_at: u64,
        attempt: u32,
    },
    InFlight {
        receipt: String,
        lease_expires_at: u64,
        attempt: u32,
        max_attempts: u32,
    },
    Completed,
}

/// Queue entry point bound to one canonical FYLO root.
#[derive(Clone, Debug)]
pub struct NativeQueue {
    root: NativeRoot,
    lease: RootLease,
}

impl NativeQueue {
    /// Open a queue without creating queue state.
    ///
    /// # Errors
    ///
    /// Returns an error when the FYLO root is missing, unsafe, or inaccessible.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, NativeStorageError> {
        let lease = RootLease::acquire(path)?;
        Self::open_with_lease(lease)
    }

    /// Open a queue under an exclusive root lease already held by the caller.
    ///
    /// The queue retains a clone of the lease, so public queue operations can
    /// never outlive exclusive ownership of their root.
    ///
    /// # Errors
    ///
    /// Returns an error when the lease generation was lost or the FYLO root
    /// is missing, unsafe, or inaccessible.
    pub fn open_with_lease(lease: RootLease) -> Result<Self, NativeStorageError> {
        lease.assert_owned()?;
        Ok(Self {
            root: NativeRoot::open(lease.root())?,
            lease,
        })
    }

    /// Durably publish one message.
    ///
    /// An idempotency key is scoped to the topic. Reusing it with a different
    /// payload fails rather than silently returning the wrong publication.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid names/options, oversized payloads, unsafe
    /// paths, corrupt queue metadata, or failed durability operations.
    pub fn publish(
        &self,
        topic: &str,
        payload: Value,
        options: &QueuePublishOptions,
    ) -> Result<QueuePublishResult, NativeStorageError> {
        validate_name(topic, "topic")?;
        validate_delay(options.delay_ms)?;
        if options
            .idempotency_key
            .as_ref()
            .is_some_and(|key| key.is_empty() || key.len() > MAX_IDEMPOTENCY_KEY_BYTES)
        {
            return Err(queue_error(
                "queue idempotency key must contain between 1 and 1024 bytes",
            ));
        }
        self.ensure_layout()?;
        let payload_hash = value_hash(&payload)?;
        if let Some(key) = options.idempotency_key.as_deref() {
            let dedupe_path = self.dedupe_path(topic, key);
            let parent = dedupe_path
                .parent()
                .ok_or_else(|| queue_error("queue dedupe path has no parent"))?;
            ensure_directory(&self.root, parent)?;
            if path_exists_no_follow(&dedupe_path)? {
                let record: DedupeRecord = self.read_json(&dedupe_path, MAX_DEDUPE_BYTES)?;
                if record.format != DEDUPE_FORMAT
                    || record.topic != topic
                    || record.payload_hash != payload_hash
                {
                    return Err(queue_error(
                        "queue idempotency key was reused with different content",
                    ));
                }
                self.write_message_if_missing(&record.message)?;
                return Ok(QueuePublishResult {
                    id: record.message.id,
                    deduplicated: true,
                });
            }
        }

        let now = unix_millis()?;
        let id = self.allocate_id()?;
        let message = StoredMessage {
            format: MESSAGE_FORMAT.into(),
            id: id.clone(),
            topic: topic.into(),
            published_at: now,
            available_at: now.saturating_add(options.delay_ms),
            payload,
        };
        validate_message_size(&message)?;
        if let Some(key) = options.idempotency_key.as_deref() {
            let path = self.dedupe_path(topic, key);
            let parent = path
                .parent()
                .ok_or_else(|| queue_error("queue dedupe path has no parent"))?;
            ensure_directory(&self.root, parent)?;
            self.write_json(
                &path,
                &DedupeRecord {
                    format: DEDUPE_FORMAT.into(),
                    topic: topic.into(),
                    payload_hash,
                    message: message.clone(),
                },
            )?;
        }
        self.write_message_if_missing(&message)?;
        Ok(QueuePublishResult {
            id,
            deduplicated: false,
        })
    }

    /// Claim available messages for one consumer group.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid options, corrupt state, unsafe paths, or a
    /// failed durable state transition.
    pub fn claim(
        &self,
        topic: &str,
        group: &str,
        options: QueueClaimOptions,
    ) -> Result<Vec<QueueDelivery>, NativeStorageError> {
        validate_name(topic, "topic")?;
        validate_name(group, "consumer group")?;
        validate_claim_options(options)?;
        self.ensure_layout()?;
        let now = unix_millis()?;
        let mut state = self.read_consumer(topic, group)?;
        self.expire_leases(&mut state, now)?;
        state.compact();
        let mut scan_budget = ScanBudget::new(MAX_QUEUE_SCAN_BYTES);
        self.load_pending(topic, &mut state, &mut scan_budget)?;

        let mut deliveries = Vec::new();
        let mut used_bytes = 0usize;
        for (id, status) in &mut state.pending {
            if deliveries.len() >= options.max_messages {
                break;
            }
            let DeliveryState::Available {
                available_at,
                attempt,
            } = status
            else {
                continue;
            };
            if *available_at > now {
                continue;
            }
            let remaining = options.max_bytes.saturating_sub(used_bytes);
            let message = match self.read_message_for_delivery(topic, id, remaining) {
                Ok(message) => message,
                Err(error)
                    if error.code() == NativeStorageErrorCode::QueueLimit
                        && !deliveries.is_empty() =>
                {
                    break;
                }
                Err(error) => return Err(error),
            };
            let due = (*available_at).max(message.available_at);
            if due > now {
                *available_at = due;
                continue;
            }
            let next_attempt = attempt.saturating_add(1);
            let receipt = self.receipt(topic, group, id, next_attempt)?;
            let lease_expires_at = now.saturating_add(options.visibility_timeout_ms);
            let delivery = QueueDelivery {
                id: message.id,
                topic: message.topic,
                published_at: message.published_at,
                attempt: next_attempt,
                receipt: receipt.clone(),
                lease_expires_at,
                payload: message.payload,
            };
            let delivery_bytes = serde_json::to_vec(&delivery)
                .map_err(|error| queue_error(format!("queue delivery cannot be encoded: {error}")))?
                .len();
            if delivery_bytes > options.max_bytes
                || used_bytes.saturating_add(delivery_bytes) > options.max_bytes
            {
                if deliveries.is_empty() {
                    return Err(limit_error(
                        "queue delivery exceeds the aggregate response budget",
                    ));
                }
                break;
            }
            *status = DeliveryState::InFlight {
                receipt: receipt.clone(),
                lease_expires_at,
                attempt: next_attempt,
                max_attempts: options.max_attempts,
            };
            used_bytes = used_bytes.saturating_add(delivery_bytes);
            deliveries.push(delivery);
        }
        self.write_consumer(&state)?;
        Ok(deliveries)
    }

    /// Acknowledge one delivery. Recent successful acknowledgements are
    /// idempotent only with the exact receipt that completed the delivery.
    ///
    /// # Errors
    ///
    /// Returns `EQUEUE_RECEIPT` for a stale or incorrect receipt.
    pub fn ack(
        &self,
        topic: &str,
        group: &str,
        id: &str,
        receipt: &str,
    ) -> Result<QueueAckResult, NativeStorageError> {
        validate_identity(topic, group, id, receipt)?;
        let mut state = self.read_consumer(topic, group)?;
        self.reject_expired_receipt(&mut state, id)?;
        if state.cursor.as_deref().is_some_and(|cursor| id <= cursor)
            || matches!(state.pending.get(id), Some(DeliveryState::Completed))
        {
            if state.acknowledged.get(id).map(String::as_str) != Some(receipt) {
                return Err(receipt_error());
            }
            return Ok(QueueAckResult {
                acknowledged: true,
                duplicate: true,
            });
        }
        require_receipt(&state, id, receipt)?;
        state.acknowledged.insert(id.into(), receipt.into());
        state
            .acknowledged_order
            .retain(|acknowledged| acknowledged != id);
        state.acknowledged_order.push(id.into());
        while state.acknowledged_order.len() > MAX_ACKNOWLEDGED_RECEIPTS {
            let oldest = state.acknowledged_order.remove(0);
            state.acknowledged.remove(&oldest);
        }
        state.pending.insert(id.into(), DeliveryState::Completed);
        state.compact();
        self.write_consumer(&state)?;
        Ok(QueueAckResult {
            acknowledged: true,
            duplicate: false,
        })
    }

    /// Release one delivery for retry, optionally after a delay. The final
    /// allowed attempt is dead-lettered immediately.
    ///
    /// # Errors
    ///
    /// Returns `EQUEUE_RECEIPT` for a stale or incorrect receipt.
    pub fn nack(
        &self,
        topic: &str,
        group: &str,
        id: &str,
        receipt: &str,
        delay_ms: u64,
        reason: &str,
    ) -> Result<QueueNackResult, NativeStorageError> {
        validate_identity(topic, group, id, receipt)?;
        validate_delay(delay_ms)?;
        let reason = bounded_reason(reason)?;
        let mut state = self.read_consumer(topic, group)?;
        self.reject_expired_receipt(&mut state, id)?;
        let (attempt, max_attempts) = require_receipt(&state, id, receipt)?;
        if attempt >= max_attempts {
            self.write_dead_letter(topic, group, id, attempt, &reason)?;
            state.pending.insert(id.into(), DeliveryState::Completed);
            state.compact();
            self.write_consumer(&state)?;
            return Ok(QueueNackResult {
                dead_lettered: true,
                available_at: None,
            });
        }
        let available_at = unix_millis()?.saturating_add(delay_ms);
        state.pending.insert(
            id.into(),
            DeliveryState::Available {
                available_at,
                attempt,
            },
        );
        self.write_consumer(&state)?;
        Ok(QueueNackResult {
            dead_lettered: false,
            available_at: Some(available_at),
        })
    }

    /// Extend an active visibility lease and return its new expiry.
    ///
    /// # Errors
    ///
    /// Returns `EQUEUE_RECEIPT` for a stale or incorrect receipt.
    pub fn extend(
        &self,
        topic: &str,
        group: &str,
        id: &str,
        receipt: &str,
        visibility_timeout_ms: u64,
    ) -> Result<u64, NativeStorageError> {
        validate_identity(topic, group, id, receipt)?;
        validate_visibility_timeout(visibility_timeout_ms)?;
        let mut state = self.read_consumer(topic, group)?;
        self.reject_expired_receipt(&mut state, id)?;
        require_receipt(&state, id, receipt)?;
        let requested = unix_millis()?.saturating_add(visibility_timeout_ms);
        let Some(DeliveryState::InFlight {
            lease_expires_at, ..
        }) = state.pending.get_mut(id)
        else {
            return Err(receipt_error());
        };
        let expires = requested.max(*lease_expires_at);
        *lease_expires_at = expires;
        self.write_consumer(&state)?;
        Ok(expires)
    }

    /// Inspect queue depth for a consumer group without changing delivery.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid names, corrupt records, or unsafe paths.
    pub fn stats(&self, topic: &str, group: &str) -> Result<QueueStats, NativeStorageError> {
        self.stats_with_scan_budget(topic, group, MAX_QUEUE_SCAN_BYTES)
    }

    fn stats_with_scan_budget(
        &self,
        topic: &str,
        group: &str,
        max_scan_bytes: u64,
    ) -> Result<QueueStats, NativeStorageError> {
        validate_name(topic, "topic")?;
        validate_name(group, "consumer group")?;
        self.ensure_layout()?;
        let now = unix_millis()?;
        let state = self.read_consumer(topic, group)?;
        let messages = self.message_ids(topic)?;
        let mut scan_budget = ScanBudget::new(max_scan_bytes);
        let mut metrics = QueueStats {
            published: messages.len(),
            ..QueueStats::default()
        };
        for id in messages {
            if state
                .cursor
                .as_deref()
                .is_some_and(|cursor| id.as_str() <= cursor)
            {
                metrics.retired += 1;
                continue;
            }
            match state.pending.get(&id) {
                Some(DeliveryState::Completed) => metrics.retired += 1,
                Some(DeliveryState::InFlight {
                    lease_expires_at, ..
                }) if *lease_expires_at > now => metrics.in_flight += 1,
                Some(DeliveryState::Available { available_at, .. }) if *available_at > now => {
                    metrics.delayed += 1;
                }
                _ => {
                    let Some(message) = self.read_message_header(topic, &id, &mut scan_budget)?
                    else {
                        return Err(limit_error(
                            "queue stats exceed the aggregate message scan budget",
                        ));
                    };
                    if message.available_at > now {
                        metrics.delayed += 1;
                    } else {
                        metrics.available += 1;
                    }
                }
            }
        }
        metrics.dead_lettered = self.dead_letter_ids(topic, group)?.len();
        Ok(metrics)
    }

    /// Read the newest group-specific dead letters, oldest first within the
    /// selected tail.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid limits, corrupt records, or unsafe paths.
    pub fn dead_letters(
        &self,
        topic: &str,
        group: &str,
        limit: usize,
    ) -> Result<Vec<QueueDeadLetter>, NativeStorageError> {
        self.dead_letters_bounded(topic, group, limit, DEFAULT_READ_BUDGET_BYTES)
    }

    /// Read dead letters within an aggregate encoded-byte budget.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid limits, corrupt records, unsafe paths, or
    /// a record that cannot fit within the supplied response budget.
    pub fn dead_letters_bounded(
        &self,
        topic: &str,
        group: &str,
        limit: usize,
        max_bytes: usize,
    ) -> Result<Vec<QueueDeadLetter>, NativeStorageError> {
        self.lease.assert_owned()?;
        validate_name(topic, "topic")?;
        validate_name(group, "consumer group")?;
        if limit == 0 || limit > MAX_DEAD_LETTERS {
            return Err(limit_error(
                "queue dead-letter limit must be between 1 and 1000",
            ));
        }
        validate_response_budget(max_bytes)?;
        let ids = self.dead_letter_ids(topic, group)?;
        let mut used = 0usize;
        ids.into_iter()
            .rev()
            .take(limit)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|id| {
                let record: QueueDeadLetter = self.read_json_with_budget(
                    &self.dead_letter_path(topic, group, &id),
                    MAX_DEAD_LETTER_BYTES,
                    max_bytes.saturating_sub(used),
                )?;
                validate_dead_letter(&record, topic, group, &id)?;
                let encoded = serde_json::to_vec(&record).map_err(|error| {
                    queue_error(format!("queue dead letter cannot be encoded: {error}"))
                })?;
                if encoded.len() > max_bytes || used.saturating_add(encoded.len()) > max_bytes {
                    return Err(limit_error(
                        "queue dead letters exceed the aggregate response budget",
                    ));
                }
                used = used.saturating_add(encoded.len());
                Ok(record)
            })
            .collect()
    }

    fn ensure_layout(&self) -> Result<(), NativeStorageError> {
        self.lease.assert_owned()?;
        let root = self.queue_root();
        ensure_directory(&self.root, &root)?;
        for child in ["topics", "consumers", "dedupe", "dead-letter"] {
            ensure_directory(&self.root, &root.join(child))?;
        }
        let manifest = self.manifest_path();
        if !path_exists_no_follow(&manifest)? {
            self.write_json(
                &manifest,
                &QueueManifest {
                    format: QUEUE_FORMAT.into(),
                    next_sequence: 1,
                },
            )?;
        }
        let stored: QueueManifest = self.read_json(&manifest, MAX_STATE_BYTES)?;
        if stored.format != QUEUE_FORMAT || stored.next_sequence == 0 {
            return Err(queue_error(
                "queue manifest is corrupt or has an unknown format",
            ));
        }
        let receipt_key = self.receipt_key_path();
        if !path_exists_no_follow(&receipt_key)? {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(|error| {
                queue_error(format!("queue receipt entropy is unavailable: {error}"))
            })?;
            self.write_json(
                &receipt_key,
                &ReceiptKey {
                    format: RECEIPT_KEY_FORMAT.into(),
                    key: sha256(&bytes),
                },
            )?;
        }
        self.read_receipt_key()?;
        Ok(())
    }

    fn allocate_id(&self) -> Result<String, NativeStorageError> {
        let path = self.manifest_path();
        let mut manifest: QueueManifest = self.read_json(&path, MAX_STATE_BYTES)?;
        if manifest.format != QUEUE_FORMAT || manifest.next_sequence == 0 {
            return Err(queue_error(
                "queue manifest is corrupt or has an unknown format",
            ));
        }
        let sequence = manifest.next_sequence;
        manifest.next_sequence = sequence
            .checked_add(1)
            .ok_or_else(|| limit_error("queue message sequence is exhausted"))?;
        self.write_json(&path, &manifest)?;
        Ok(format!("Q{sequence:020}"))
    }

    fn write_message_if_missing(&self, message: &StoredMessage) -> Result<(), NativeStorageError> {
        validate_stored_message(message)?;
        validate_message_size(message)?;
        let path = self.message_path(&message.topic, &message.id);
        ensure_directory(&self.root, path.parent().expect("message path has parent"))?;
        if path_exists_no_follow(&path)? {
            let existing: StoredMessage = self.read_json(&path, MAX_MESSAGE_BYTES)?;
            if existing != *message {
                return Err(queue_error(
                    "queue message id resolves to different content",
                ));
            }
            return Ok(());
        }
        self.write_json(&path, message)
    }

    fn read_message(&self, topic: &str, id: &str) -> Result<StoredMessage, NativeStorageError> {
        let message: StoredMessage = {
            let path = self.message_path(topic, id);
            let parent = path
                .parent()
                .ok_or_else(|| queue_error("queue message path has no parent"))?;
            ensure_directory(&self.root, parent)?;
            self.read_json(&path, MAX_MESSAGE_BYTES)?
        };
        validate_stored_message(&message)?;
        if message.topic != topic || message.id != id {
            return Err(queue_error("queue message has an invalid identity"));
        }
        Ok(message)
    }

    fn read_message_header(
        &self,
        topic: &str,
        id: &str,
        scan_budget: &mut ScanBudget,
    ) -> Result<Option<StoredMessageHeader>, NativeStorageError> {
        self.lease.assert_owned()?;
        let path = self.message_path(topic, id);
        let (file, metadata) = self.root.open_file(&path, MAX_MESSAGE_BYTES)?;
        if metadata.len() > scan_budget.remaining {
            return Ok(None);
        }
        let read_limit = scan_budget
            .remaining
            .min(MAX_MESSAGE_BYTES)
            .saturating_add(1);
        let mut bytes = Vec::with_capacity(
            usize::try_from(metadata.len())
                .map_err(|_| limit_error("queue message size does not fit this platform"))?,
        );
        file.take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(NativeStorageError::io)?;
        if bytes.len() as u64 > scan_budget.remaining {
            return Err(limit_error(
                "queue message scan exceeds its aggregate byte budget",
            ));
        }
        if bytes.len() as u64 > MAX_MESSAGE_BYTES {
            return Err(limit_error("queue message exceeds 1 MiB"));
        }
        scan_budget.remaining = scan_budget.remaining.saturating_sub(bytes.len() as u64);
        let header: StoredMessageHeader = serde_json::from_slice(&bytes)
            .map_err(|error| queue_error(format!("queue message is corrupt: {error}")))?;
        validate_stored_message_header(&header)?;
        if header.topic != topic || header.id != id {
            return Err(queue_error("queue message has an invalid identity"));
        }
        Ok(Some(header))
    }

    fn read_message_for_delivery(
        &self,
        topic: &str,
        id: &str,
        response_remaining: usize,
    ) -> Result<StoredMessage, NativeStorageError> {
        self.lease.assert_owned()?;
        let path = self.message_path(topic, id);
        let (file, metadata) = self.root.open_file(&path, MAX_MESSAGE_BYTES)?;
        let bytes = Self::read_opened_message_for_delivery(file, &metadata, response_remaining)?;
        let message: StoredMessage = serde_json::from_slice(&bytes)
            .map_err(|error| queue_error(format!("queue message is corrupt: {error}")))?;
        validate_stored_message(&message)?;
        if message.topic != topic || message.id != id {
            return Err(queue_error("queue message has an invalid identity"));
        }
        Ok(message)
    }

    fn read_opened_message_for_delivery(
        file: fs::File,
        metadata: &fs::Metadata,
        response_remaining: usize,
    ) -> Result<Vec<u8>, NativeStorageError> {
        let response_remaining = u64::try_from(response_remaining)
            .map_err(|_| limit_error("queue response budget does not fit this platform"))?;
        let message_allowance = response_remaining.saturating_sub(DELIVERY_ENVELOPE_ALLOWANCE);
        if metadata.len() > message_allowance {
            return Err(limit_error(
                "queue delivery exceeds the aggregate response budget",
            ));
        }
        let mut bytes = Vec::with_capacity(
            usize::try_from(metadata.len())
                .map_err(|_| limit_error("queue message size does not fit this platform"))?,
        );
        file.take(MAX_MESSAGE_BYTES.min(message_allowance).saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(NativeStorageError::io)?;
        if bytes.len() as u64 > message_allowance {
            return Err(limit_error(
                "queue delivery exceeds the aggregate response budget",
            ));
        }
        if bytes.len() as u64 > MAX_MESSAGE_BYTES {
            return Err(limit_error("queue message exceeds 1 MiB"));
        }
        Ok(bytes)
    }

    fn read_consumer(&self, topic: &str, group: &str) -> Result<ConsumerState, NativeStorageError> {
        let path = self.consumer_path(topic, group);
        let parent = path
            .parent()
            .ok_or_else(|| queue_error("queue consumer path has no parent"))?;
        ensure_directory(&self.root, parent)?;
        if !path_exists_no_follow(&path)? {
            return Ok(ConsumerState::new(topic, group));
        }
        let mut state: ConsumerState = self.read_json(&path, MAX_STATE_BYTES)?;
        state.normalize_acknowledged_order();
        state.validate(topic, group)?;
        Ok(state)
    }

    fn write_consumer(&self, state: &ConsumerState) -> Result<(), NativeStorageError> {
        state.validate(&state.topic, &state.group)?;
        let path = self.consumer_path(&state.topic, &state.group);
        ensure_directory(&self.root, path.parent().expect("consumer path has parent"))?;
        self.write_json(&path, state)
    }

    fn load_pending(
        &self,
        topic: &str,
        state: &mut ConsumerState,
        scan_budget: &mut ScanBudget,
    ) -> Result<(), NativeStorageError> {
        if state.pending.len() >= MAX_PENDING_MESSAGES {
            return Ok(());
        }
        for id in self.message_ids(topic)? {
            if state
                .scan_cursor
                .as_deref()
                .is_some_and(|cursor| id.as_str() <= cursor)
            {
                continue;
            }
            let Some(message) = self.read_message_header(topic, &id, scan_budget)? else {
                break;
            };
            state.pending.insert(
                id.clone(),
                DeliveryState::Available {
                    available_at: message.available_at,
                    attempt: 0,
                },
            );
            state.scan_cursor = Some(id);
            if state.pending.len() >= MAX_PENDING_MESSAGES {
                break;
            }
        }
        Ok(())
    }

    fn expire_leases(&self, state: &mut ConsumerState, now: u64) -> Result<(), NativeStorageError> {
        let topic = state.topic.clone();
        let group = state.group.clone();
        for (id, status) in &mut state.pending {
            let DeliveryState::InFlight {
                lease_expires_at,
                attempt,
                max_attempts,
                ..
            } = status
            else {
                continue;
            };
            if *lease_expires_at > now {
                continue;
            }
            if *attempt >= *max_attempts {
                self.write_dead_letter(&topic, &group, id, *attempt, "visibility lease expired")?;
                *status = DeliveryState::Completed;
            } else {
                *status = DeliveryState::Available {
                    available_at: now,
                    attempt: *attempt,
                };
            }
        }
        Ok(())
    }

    fn reject_expired_receipt(
        &self,
        state: &mut ConsumerState,
        id: &str,
    ) -> Result<(), NativeStorageError> {
        let now = unix_millis()?;
        let expired = matches!(
            state.pending.get(id),
            Some(DeliveryState::InFlight { lease_expires_at, .. }) if *lease_expires_at <= now
        );
        if !expired {
            return Ok(());
        }
        self.expire_leases(state, now)?;
        state.compact();
        self.write_consumer(state)?;
        Err(receipt_error())
    }

    fn write_dead_letter(
        &self,
        topic: &str,
        group: &str,
        id: &str,
        attempts: u32,
        reason: &str,
    ) -> Result<(), NativeStorageError> {
        let path = self.dead_letter_path(topic, group, id);
        let parent = path
            .parent()
            .ok_or_else(|| queue_error("queue dead-letter path has no parent"))?;
        ensure_directory(&self.root, parent)?;
        if path_exists_no_follow(&path)? {
            let existing: QueueDeadLetter = self.read_json(&path, MAX_DEAD_LETTER_BYTES)?;
            validate_dead_letter(&existing, topic, group, id)?;
            return Ok(());
        }
        let message = self.read_message(topic, id)?;
        self.write_json(
            &path,
            &QueueDeadLetter {
                format: DEAD_LETTER_FORMAT.into(),
                id: id.into(),
                group: group.into(),
                topic: topic.into(),
                attempts,
                reason: bounded_reason(reason)?,
                dead_lettered_at: unix_millis()?,
                published_at: message.published_at,
                payload: message.payload,
            },
        )
    }

    fn receipt(
        &self,
        topic: &str,
        group: &str,
        id: &str,
        attempt: u32,
    ) -> Result<String, NativeStorageError> {
        Ok(hex_bytes(&self.receipt_bytes(topic, group, id, attempt)?))
    }

    fn receipt_bytes(
        &self,
        topic: &str,
        group: &str,
        id: &str,
        attempt: u32,
    ) -> Result<[u8; 32], NativeStorageError> {
        let key = self.read_receipt_key()?;
        let mut mac = Hmac::<Sha256>::new_from_slice(&key)
            .map_err(|_| queue_error("queue receipt key is invalid"))?;
        mac.update(topic.as_bytes());
        mac.update(&[0]);
        mac.update(group.as_bytes());
        mac.update(&[0]);
        mac.update(id.as_bytes());
        mac.update(&attempt.to_be_bytes());
        let output = mac.finalize().into_bytes();
        let mut receipt = [0u8; 32];
        receipt.copy_from_slice(&output);
        Ok(receipt)
    }

    fn read_receipt_key(&self) -> Result<[u8; 32], NativeStorageError> {
        let record: ReceiptKey = self.read_json(&self.receipt_key_path(), 4096)?;
        if record.format != RECEIPT_KEY_FORMAT || record.key.len() != 64 {
            return Err(queue_error("queue receipt key is corrupt"));
        }
        decode_hex_32(&record.key).ok_or_else(|| queue_error("queue receipt key is corrupt"))
    }

    fn message_ids(&self, topic: &str) -> Result<Vec<String>, NativeStorageError> {
        self.lease.assert_owned()?;
        let root = self.topic_path(topic);
        if !path_exists_no_follow(&root)? {
            return Ok(Vec::new());
        }
        self.root.verify_path(&root, ExpectedType::Directory)?;
        read_ids(&self.root, &root, ".json")
    }

    fn dead_letter_ids(&self, topic: &str, group: &str) -> Result<Vec<String>, NativeStorageError> {
        self.lease.assert_owned()?;
        let root = self.dead_letter_root(topic, group);
        if !path_exists_no_follow(&root)? {
            return Ok(Vec::new());
        }
        self.root.verify_path(&root, ExpectedType::Directory)?;
        read_ids(&self.root, &root, ".json")
    }

    fn read_json<T: DeserializeOwned>(
        &self,
        path: &Path,
        max_bytes: u64,
    ) -> Result<T, NativeStorageError> {
        self.lease.assert_owned()?;
        let bytes = self.root.read_file(path, max_bytes)?;
        serde_json::from_slice(&bytes).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("bounded queue JSON is corrupt: {error}"),
            )
        })
    }

    fn read_json_with_budget<T: DeserializeOwned>(
        &self,
        path: &Path,
        max_record_bytes: u64,
        response_remaining: usize,
    ) -> Result<T, NativeStorageError> {
        self.lease.assert_owned()?;
        let (file, metadata) = self.root.open_file(path, max_record_bytes)?;
        if metadata.len() > response_remaining as u64 {
            return Err(limit_error(
                "queue record exceeds the aggregate response budget",
            ));
        }
        let mut bytes = Vec::with_capacity(
            usize::try_from(metadata.len())
                .map_err(|_| limit_error("queue record size does not fit this platform"))?,
        );
        file.take(max_record_bytes.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(NativeStorageError::io)?;
        if bytes.len() as u64 > max_record_bytes {
            return Err(limit_error("queue record exceeds its read limit"));
        }
        serde_json::from_slice(&bytes).map_err(|error| {
            NativeStorageError::new(
                NativeStorageErrorCode::CorruptMetadata,
                format!("bounded queue JSON is corrupt: {error}"),
            )
        })
    }

    fn write_json(&self, path: &Path, value: &impl Serialize) -> Result<(), NativeStorageError> {
        self.lease.assert_owned()?;
        let parent = path
            .parent()
            .ok_or_else(|| queue_error("queue write path has no parent"))?;
        self.root.verify_path(parent, ExpectedType::Directory)?;
        #[cfg(not(target_family = "wasm"))]
        let before = same_file::Handle::from_path(parent).map_err(NativeStorageError::io)?;
        let write_result = super::write::write_json_durable(path, value);
        let parent_result = self.root.verify_path(parent, ExpectedType::Directory);
        #[cfg(not(target_family = "wasm"))]
        {
            parent_result?;
            let after = same_file::Handle::from_path(parent).map_err(NativeStorageError::io)?;
            if before != after {
                return Err(NativeStorageError::new(
                    NativeStorageErrorCode::UnsafePath,
                    "queue parent directory changed during a durable write",
                ));
            }
        }
        #[cfg(target_family = "wasm")]
        parent_result?;
        write_result?;
        self.root.verify_path(path, ExpectedType::File)?;
        Ok(())
    }

    fn queue_root(&self) -> PathBuf {
        self.root.path().join(".fylo-queue").join("v1")
    }

    fn manifest_path(&self) -> PathBuf {
        self.queue_root().join("manifest.json")
    }

    fn receipt_key_path(&self) -> PathBuf {
        self.queue_root().join("receipt-key.json")
    }

    fn topic_path(&self, topic: &str) -> PathBuf {
        self.queue_root().join("topics").join(encode_name(topic))
    }

    fn message_path(&self, topic: &str, id: &str) -> PathBuf {
        self.topic_path(topic).join(format!("{id}.json"))
    }

    fn consumer_path(&self, topic: &str, group: &str) -> PathBuf {
        self.queue_root()
            .join("consumers")
            .join(encode_name(group))
            .join(format!("{}.json", encode_name(topic)))
    }

    fn dedupe_path(&self, topic: &str, key: &str) -> PathBuf {
        self.queue_root()
            .join("dedupe")
            .join(encode_name(topic))
            .join(format!("{}.json", sha256(key.as_bytes())))
    }

    fn dead_letter_root(&self, topic: &str, group: &str) -> PathBuf {
        self.queue_root()
            .join("dead-letter")
            .join(encode_name(group))
            .join(encode_name(topic))
    }

    fn dead_letter_path(&self, topic: &str, group: &str, id: &str) -> PathBuf {
        self.dead_letter_root(topic, group)
            .join(format!("{id}.json"))
    }
}

fn validate_name(value: &str, label: &str) -> Result<(), NativeStorageError> {
    if value.is_empty()
        || value.len() > MAX_NAME_BYTES
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\'))
    {
        return Err(queue_error(format!(
            "queue {label} must contain 1 to 127 non-control bytes without path separators"
        )));
    }
    Ok(())
}

fn validate_identity(
    topic: &str,
    group: &str,
    id: &str,
    receipt: &str,
) -> Result<(), NativeStorageError> {
    validate_name(topic, "topic")?;
    validate_name(group, "consumer group")?;
    if !valid_message_id(id) || receipt.is_empty() || receipt.len() > 256 {
        return Err(queue_error("queue message id or receipt is invalid"));
    }
    Ok(())
}

fn validate_claim_options(options: QueueClaimOptions) -> Result<(), NativeStorageError> {
    if options.max_messages == 0 || options.max_messages > MAX_CLAIM_MESSAGES {
        return Err(limit_error("queue claim limit must be between 1 and 1000"));
    }
    validate_visibility_timeout(options.visibility_timeout_ms)?;
    if options.max_attempts == 0 || options.max_attempts > MAX_ATTEMPTS {
        return Err(limit_error("queue max attempts must be between 1 and 100"));
    }
    validate_response_budget(options.max_bytes)
}

fn validate_response_budget(max_bytes: usize) -> Result<(), NativeStorageError> {
    if max_bytes == 0 || max_bytes > DEFAULT_READ_BUDGET_BYTES {
        return Err(limit_error(
            "queue response budget must be between 1 byte and 8 MiB",
        ));
    }
    Ok(())
}

fn validate_visibility_timeout(value: u64) -> Result<(), NativeStorageError> {
    if !(MIN_VISIBILITY_TIMEOUT_MS..=MAX_VISIBILITY_TIMEOUT_MS).contains(&value) {
        return Err(limit_error(
            "queue visibility timeout must be between 100 and 86400000 milliseconds",
        ));
    }
    Ok(())
}

fn validate_delay(value: u64) -> Result<(), NativeStorageError> {
    if value > MAX_DELAY_MS {
        return Err(limit_error(
            "queue delay cannot exceed 2592000000 milliseconds",
        ));
    }
    Ok(())
}

fn validate_stored_message(message: &StoredMessage) -> Result<(), NativeStorageError> {
    if message.format != MESSAGE_FORMAT
        || !valid_message_id(&message.id)
        || validate_name(&message.topic, "topic").is_err()
        || message.available_at < message.published_at
    {
        return Err(queue_error("queue message is corrupt"));
    }
    Ok(())
}

fn validate_stored_message_header(message: &StoredMessageHeader) -> Result<(), NativeStorageError> {
    if message.format != MESSAGE_FORMAT
        || !valid_message_id(&message.id)
        || validate_name(&message.topic, "topic").is_err()
        || message.available_at < message.published_at
    {
        return Err(queue_error("queue message is corrupt"));
    }
    Ok(())
}

fn validate_message_size(message: &StoredMessage) -> Result<(), NativeStorageError> {
    let size = serde_json::to_vec(message)
        .map_err(|error| queue_error(format!("queue message cannot be encoded: {error}")))?
        .len();
    if size as u64 > MAX_MESSAGE_BYTES {
        return Err(limit_error("queue message exceeds 1 MiB"));
    }
    Ok(())
}

fn valid_delivery_state(state: &DeliveryState) -> bool {
    match state {
        DeliveryState::Available { attempt, .. } => *attempt <= MAX_ATTEMPTS,
        DeliveryState::InFlight {
            receipt,
            attempt,
            max_attempts,
            ..
        } => {
            valid_receipt(receipt)
                && (1..=MAX_ATTEMPTS).contains(attempt)
                && (1..=MAX_ATTEMPTS).contains(max_attempts)
                && attempt <= max_attempts
        }
        DeliveryState::Completed => true,
    }
}

fn validate_dead_letter(
    record: &QueueDeadLetter,
    topic: &str,
    group: &str,
    id: &str,
) -> Result<(), NativeStorageError> {
    if record.format != DEAD_LETTER_FORMAT
        || record.id != id
        || record.topic != topic
        || record.group != group
        || !valid_message_id(&record.id)
        || validate_name(&record.topic, "topic").is_err()
        || validate_name(&record.group, "consumer group").is_err()
        || !(1..=MAX_ATTEMPTS).contains(&record.attempts)
        || record.reason.len() > 4096
    {
        return Err(queue_error("queue dead letter is corrupt"));
    }
    Ok(())
}

fn require_receipt(
    state: &ConsumerState,
    id: &str,
    receipt: &str,
) -> Result<(u32, u32), NativeStorageError> {
    match state.pending.get(id) {
        Some(DeliveryState::InFlight {
            receipt: expected,
            attempt,
            max_attempts,
            ..
        }) if expected == receipt => Ok((*attempt, *max_attempts)),
        _ => Err(receipt_error()),
    }
}

fn bounded_reason(reason: &str) -> Result<String, NativeStorageError> {
    if reason.len() > 4096 {
        return Err(limit_error("queue failure reason exceeds 4096 bytes"));
    }
    Ok(reason.into())
}

fn valid_message_id(id: &str) -> bool {
    id.len() == 21 && id.starts_with('Q') && id[1..].bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_receipt(receipt: &str) -> bool {
    decode_hex_32(receipt).is_some()
}

fn encode_name(value: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.as_bytes())
}

fn value_hash(value: &Value) -> Result<String, NativeStorageError> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| queue_error(format!("queue payload cannot be encoded: {error}")))?;
    Ok(sha256(&bytes))
}

fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

fn decode_hex_32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        let digits = std::str::from_utf8(chunk).ok()?;
        bytes[index] = u8::from_str_radix(digits, 16).ok()?;
    }
    Some(bytes)
}

fn read_ids(
    owner: &NativeRoot,
    root: &Path,
    suffix: &str,
) -> Result<Vec<String>, NativeStorageError> {
    owner.verify_path(root, ExpectedType::Directory)?;
    #[cfg(not(target_family = "wasm"))]
    let before = same_file::Handle::from_path(root).map_err(NativeStorageError::io)?;
    let mut ids = Vec::new();
    let mut scanned = 0usize;
    for entry in fs::read_dir(root).map_err(NativeStorageError::io)? {
        let entry = entry.map_err(NativeStorageError::io)?;
        scanned = scanned.saturating_add(1);
        if scanned > MAX_DIRECTORY_ENTRIES {
            return Err(limit_error("queue directory exceeds its entry scan limit"));
        }
        let metadata = entry.file_type().map_err(NativeStorageError::io)?;
        if metadata.is_symlink() || !metadata.is_file() {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "queue directory contains a link or non-file entry",
            ));
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if is_scratch_file(&name) {
            continue;
        }
        let Some(id) = name.strip_suffix(suffix) else {
            return Err(queue_error("queue directory contains an unknown file"));
        };
        if !valid_message_id(id) {
            return Err(queue_error(
                "queue directory contains an invalid message id",
            ));
        }
        ids.push(id.into());
    }
    owner.verify_path(root, ExpectedType::Directory)?;
    #[cfg(not(target_family = "wasm"))]
    {
        let after = same_file::Handle::from_path(root).map_err(NativeStorageError::io)?;
        if before != after {
            return Err(NativeStorageError::new(
                NativeStorageErrorCode::UnsafePath,
                "queue directory changed while it was being enumerated",
            ));
        }
    }
    ids.sort_unstable();
    Ok(ids)
}

fn queue_error(message: impl Into<String>) -> NativeStorageError {
    NativeStorageError::new(NativeStorageErrorCode::InvalidQueue, message)
}

fn receipt_error() -> NativeStorageError {
    NativeStorageError::new(
        NativeStorageErrorCode::QueueReceipt,
        "queue receipt is stale, incorrect, or no longer in flight",
    )
}

fn limit_error(message: impl Into<String>) -> NativeStorageError {
    NativeStorageError::new(NativeStorageErrorCode::QueueLimit, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::write::{read_bounded_json, unique_name};

    fn queue() -> (PathBuf, NativeQueue) {
        let root = std::env::temp_dir().join(unique_name("fylo-queue-test"));
        std::fs::create_dir_all(&root).unwrap();
        let queue = NativeQueue::open(&root).unwrap();
        (root, queue)
    }

    #[test]
    fn publish_claim_ack_is_durable_and_group_independent() {
        let (root, queue) = queue();
        let first = queue
            .publish(
                "mail",
                serde_json::json!({"to": "ada"}),
                &QueuePublishOptions::default(),
            )
            .unwrap();
        let second = queue
            .publish(
                "mail",
                serde_json::json!({"to": "grace"}),
                &QueuePublishOptions::default(),
            )
            .unwrap();
        assert!(first.id < second.id);

        let deliveries = queue
            .claim(
                "mail",
                "sender",
                QueueClaimOptions {
                    max_messages: 2,
                    ..QueueClaimOptions::default()
                },
            )
            .unwrap();
        assert_eq!(deliveries.len(), 2);
        queue
            .ack("mail", "sender", &deliveries[1].id, &deliveries[1].receipt)
            .unwrap();
        queue
            .ack("mail", "sender", &deliveries[0].id, &deliveries[0].receipt)
            .unwrap();
        assert!(
            queue
                .claim("mail", "sender", QueueClaimOptions::default())
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            queue
                .claim("mail", "audit", QueueClaimOptions::default())
                .unwrap()[0]
                .id,
            first.id
        );

        drop(queue);
        let reopened = NativeQueue::open(&root).unwrap();
        assert_eq!(reopened.stats("mail", "sender").unwrap().retired, 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn idempotency_key_recovers_the_same_publication() {
        let (root, queue) = queue();
        let options = QueuePublishOptions {
            idempotency_key: Some("order-7".into()),
            ..QueuePublishOptions::default()
        };
        let first = queue
            .publish("orders", serde_json::json!({"id": 7}), &options)
            .unwrap();
        let retry = queue
            .publish("orders", serde_json::json!({"id": 7}), &options)
            .unwrap();
        assert_eq!(first.id, retry.id);
        assert!(retry.deduplicated);
        assert!(
            queue
                .publish("orders", serde_json::json!({"id": 8}), &options)
                .is_err()
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn nack_retries_then_dead_letters_for_only_that_group() {
        let (root, queue) = queue();
        queue
            .publish(
                "jobs",
                serde_json::json!({"job": 1}),
                &QueuePublishOptions::default(),
            )
            .unwrap();
        let options = QueueClaimOptions {
            max_attempts: 2,
            ..QueueClaimOptions::default()
        };
        let first = queue.claim("jobs", "worker", options).unwrap().remove(0);
        let result = queue
            .nack("jobs", "worker", &first.id, &first.receipt, 0, "try again")
            .unwrap();
        assert!(!result.dead_lettered);
        let second = queue.claim("jobs", "worker", options).unwrap().remove(0);
        assert_eq!(second.attempt, 2);
        assert_ne!(first.receipt, second.receipt);
        assert_eq!(
            queue
                .ack("jobs", "worker", &second.id, &first.receipt)
                .unwrap_err()
                .code(),
            NativeStorageErrorCode::QueueReceipt
        );
        let result = queue
            .nack(
                "jobs",
                "worker",
                &second.id,
                &second.receipt,
                0,
                "permanent",
            )
            .unwrap();
        assert!(result.dead_lettered);
        assert_eq!(queue.dead_letters("jobs", "worker", 10).unwrap().len(), 1);
        assert_eq!(queue.claim("jobs", "other", options).unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn visibility_receipts_reject_stale_workers() {
        let (root, queue) = queue();
        queue
            .publish("jobs", Value::Null, &QueuePublishOptions::default())
            .unwrap();
        let delivery = queue
            .claim("jobs", "workers", QueueClaimOptions::default())
            .unwrap()
            .remove(0);
        assert!(queue.ack("jobs", "workers", &delivery.id, "wrong").is_err());
        let extended = queue
            .extend("jobs", "workers", &delivery.id, &delivery.receipt, 10_000)
            .unwrap();
        assert!(extended >= delivery.lease_expires_at);
        queue
            .ack("jobs", "workers", &delivery.id, &delivery.receipt)
            .unwrap();
        let duplicate = queue
            .ack("jobs", "workers", &delivery.id, &delivery.receipt)
            .unwrap();
        assert!(duplicate.duplicate);
        assert_eq!(
            queue
                .ack("jobs", "workers", &delivery.id, "wrong")
                .unwrap_err()
                .code(),
            NativeStorageErrorCode::QueueReceipt
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn duplicate_ack_requires_the_receipt_that_completed_the_delivery() {
        let (root, queue) = queue();
        queue
            .publish("jobs", Value::Null, &QueuePublishOptions::default())
            .unwrap();
        let options = QueueClaimOptions {
            max_attempts: 2,
            ..QueueClaimOptions::default()
        };
        let first = queue.claim("jobs", "workers", options).unwrap().remove(0);
        queue
            .nack("jobs", "workers", &first.id, &first.receipt, 0, "retry")
            .unwrap();
        let second = queue.claim("jobs", "workers", options).unwrap().remove(0);
        queue
            .ack("jobs", "workers", &second.id, &second.receipt)
            .unwrap();
        assert!(
            queue
                .ack("jobs", "workers", &second.id, &second.receipt)
                .unwrap()
                .duplicate
        );
        assert_eq!(
            queue
                .ack("jobs", "workers", &first.id, &first.receipt)
                .unwrap_err()
                .code(),
            NativeStorageErrorCode::QueueReceipt
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn expired_receipts_are_rejected_and_final_attempt_is_dead_lettered() {
        let (root, queue) = queue();
        for topic in ["ack-expiry", "nack-expiry", "extend-expiry"] {
            queue
                .publish(topic, Value::Null, &QueuePublishOptions::default())
                .unwrap();
        }
        let options = QueueClaimOptions {
            visibility_timeout_ms: MIN_VISIBILITY_TIMEOUT_MS,
            max_attempts: 1,
            ..QueueClaimOptions::default()
        };
        let acked = queue
            .claim("ack-expiry", "workers", options)
            .unwrap()
            .remove(0);
        let nacked = queue
            .claim("nack-expiry", "workers", options)
            .unwrap()
            .remove(0);
        let extended = queue
            .claim("extend-expiry", "workers", options)
            .unwrap()
            .remove(0);
        std::thread::sleep(std::time::Duration::from_millis(
            MIN_VISIBILITY_TIMEOUT_MS + 25,
        ));

        assert_eq!(
            queue
                .ack("ack-expiry", "workers", &acked.id, &acked.receipt)
                .unwrap_err()
                .code(),
            NativeStorageErrorCode::QueueReceipt
        );
        assert_eq!(
            queue
                .nack(
                    "nack-expiry",
                    "workers",
                    &nacked.id,
                    &nacked.receipt,
                    0,
                    "late",
                )
                .unwrap_err()
                .code(),
            NativeStorageErrorCode::QueueReceipt
        );
        assert_eq!(
            queue
                .extend(
                    "extend-expiry",
                    "workers",
                    &extended.id,
                    &extended.receipt,
                    1_000,
                )
                .unwrap_err()
                .code(),
            NativeStorageErrorCode::QueueReceipt
        );
        for topic in ["ack-expiry", "nack-expiry", "extend-expiry"] {
            assert_eq!(queue.dead_letters(topic, "workers", 1).unwrap().len(), 1);
            assert_eq!(queue.stats(topic, "workers").unwrap().in_flight, 0);
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn response_budget_is_checked_before_a_message_is_leased() {
        let (root, queue) = queue();
        queue
            .publish(
                "jobs",
                Value::String("x".repeat(4096)),
                &QueuePublishOptions::default(),
            )
            .unwrap();
        let error = queue
            .claim(
                "jobs",
                "workers",
                QueueClaimOptions {
                    max_bytes: 128,
                    ..QueueClaimOptions::default()
                },
            )
            .unwrap_err();
        assert_eq!(error.code(), NativeStorageErrorCode::QueueLimit);
        let stats = queue.stats("jobs", "workers").unwrap();
        assert_eq!(stats.available, 1);
        assert_eq!(stats.in_flight, 0);

        let delivery = queue
            .claim("jobs", "workers", QueueClaimOptions::default())
            .unwrap()
            .remove(0);
        queue
            .nack(
                "jobs",
                "workers",
                &delivery.id,
                &delivery.receipt,
                0,
                "failed",
            )
            .unwrap();
        let delivery = queue
            .claim(
                "jobs",
                "workers",
                QueueClaimOptions {
                    max_attempts: 2,
                    ..QueueClaimOptions::default()
                },
            )
            .unwrap()
            .remove(0);
        queue
            .nack(
                "jobs",
                "workers",
                &delivery.id,
                &delivery.receipt,
                0,
                "failed",
            )
            .unwrap();
        assert_eq!(
            queue
                .dead_letters_bounded("jobs", "workers", 1, 128)
                .unwrap_err()
                .code(),
            NativeStorageErrorCode::QueueLimit
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn delivery_read_rejects_growth_beyond_the_preflighted_response_budget() {
        use std::io::Write as _;

        let (root, queue) = queue();
        let published = queue
            .publish(
                "jobs",
                serde_json::json!({"ready": true}),
                &QueuePublishOptions::default(),
            )
            .unwrap();
        let path = queue.message_path("jobs", &published.id);
        let (file, metadata) = queue.root.open_file(&path, MAX_MESSAGE_BYTES).unwrap();
        let response_remaining =
            usize::try_from(metadata.len().saturating_add(DELIVERY_ENVELOPE_ALLOWANCE)).unwrap();

        let mut writer = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writer.write_all(b" ").unwrap();
        writer.sync_all().unwrap();

        let error =
            NativeQueue::read_opened_message_for_delivery(file, &metadata, response_remaining)
                .unwrap_err();
        assert_eq!(error.code(), NativeStorageErrorCode::QueueLimit);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn delayed_large_message_does_not_block_a_later_ready_delivery() {
        let (root, queue) = queue();
        let delayed = queue
            .publish(
                "jobs",
                Value::String("x".repeat(4096)),
                &QueuePublishOptions {
                    delay_ms: MAX_DELAY_MS,
                    ..QueuePublishOptions::default()
                },
            )
            .unwrap();
        let ready = queue
            .publish(
                "jobs",
                serde_json::json!({"ready": true}),
                &QueuePublishOptions::default(),
            )
            .unwrap();
        let deliveries = queue
            .claim(
                "jobs",
                "workers",
                QueueClaimOptions {
                    max_messages: 2,
                    max_bytes: 1024,
                    ..QueueClaimOptions::default()
                },
            )
            .unwrap();
        assert_eq!(deliveries.len(), 1);
        assert_eq!(deliveries[0].id, ready.id);
        assert_ne!(deliveries[0].id, delayed.id);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn pending_discovery_and_stats_obey_an_aggregate_scan_budget() {
        let (root, queue) = queue();
        let first = queue
            .publish(
                "jobs",
                Value::String("a".repeat(2048)),
                &QueuePublishOptions::default(),
            )
            .unwrap();
        let second = queue
            .publish(
                "jobs",
                Value::String("b".repeat(2048)),
                &QueuePublishOptions::default(),
            )
            .unwrap();
        let first_bytes = std::fs::metadata(queue.message_path("jobs", &first.id))
            .unwrap()
            .len();
        let second_bytes = std::fs::metadata(queue.message_path("jobs", &second.id))
            .unwrap()
            .len();
        let mut state = ConsumerState::new("jobs", "workers");
        queue
            .load_pending("jobs", &mut state, &mut ScanBudget::new(first_bytes))
            .unwrap();
        assert_eq!(state.pending.len(), 1);
        assert_eq!(state.scan_cursor.as_deref(), Some(first.id.as_str()));
        queue
            .load_pending("jobs", &mut state, &mut ScanBudget::new(second_bytes))
            .unwrap();
        assert_eq!(state.pending.len(), 2);
        assert_eq!(state.scan_cursor.as_deref(), Some(second.id.as_str()));
        assert_eq!(
            queue
                .stats_with_scan_budget("jobs", "fresh-group", first_bytes)
                .unwrap_err()
                .code(),
            NativeStorageErrorCode::QueueLimit
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn acknowledgement_retention_uses_ack_recency_not_message_id() {
        let (root, queue) = queue();
        queue.ensure_layout().unwrap();
        let mut state = ConsumerState::new("jobs", "workers");
        let retained_receipt = "a".repeat(64);
        for sequence in 2..=MAX_ACKNOWLEDGED_RECEIPTS + 1 {
            let id = format!("Q{sequence:020}");
            state
                .acknowledged
                .insert(id.clone(), retained_receipt.clone());
            state.acknowledged_order.push(id);
        }
        let late_id = "Q00000000000000000001";
        let late_receipt = "f".repeat(64);
        state.pending.insert(
            late_id.into(),
            DeliveryState::InFlight {
                receipt: late_receipt.clone(),
                lease_expires_at: u64::MAX,
                attempt: 1,
                max_attempts: 3,
            },
        );
        state.scan_cursor = Some(format!("Q{:020}", MAX_ACKNOWLEDGED_RECEIPTS + 1));
        queue.write_consumer(&state).unwrap();

        queue
            .ack("jobs", "workers", late_id, &late_receipt)
            .unwrap();
        assert!(
            queue
                .ack("jobs", "workers", late_id, &late_receipt)
                .unwrap()
                .duplicate
        );
        let stored = queue.read_consumer("jobs", "workers").unwrap();
        assert_eq!(stored.acknowledged.len(), MAX_ACKNOWLEDGED_RECEIPTS);
        assert_eq!(
            stored.acknowledged_order.last().map(String::as_str),
            Some(late_id)
        );
        assert!(stored.acknowledged.contains_key(late_id));
        assert!(!stored.acknowledged.contains_key("Q00000000000000000002"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn queue_holds_exclusive_root_ownership_for_public_callers() {
        let (root, queue) = queue();
        let contender_root = root.clone();
        let contender =
            std::thread::spawn(move || NativeQueue::open(&contender_root).unwrap_err().code());
        assert_eq!(
            contender.join().unwrap(),
            NativeStorageErrorCode::RootLocked
        );
        let shared = queue.clone();
        drop(queue);
        assert_eq!(
            NativeQueue::open(&root).unwrap_err().code(),
            NativeStorageErrorCode::RootLocked
        );
        drop(shared);
        NativeQueue::open(&root).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn queue_names_use_a_portable_raw_byte_limit() {
        let (root, queue) = queue();
        let topic = "t".repeat(MAX_NAME_BYTES);
        let group = "g".repeat(MAX_NAME_BYTES);
        queue
            .publish(&topic, Value::Null, &QueuePublishOptions::default())
            .unwrap();
        assert_eq!(
            queue
                .claim(&topic, &group, QueueClaimOptions::default())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(encode_name(&topic).len(), 170);
        assert_eq!(
            queue
                .publish(
                    &"t".repeat(MAX_NAME_BYTES + 1),
                    Value::Null,
                    &QueuePublishOptions::default(),
                )
                .unwrap_err()
                .code(),
            NativeStorageErrorCode::InvalidQueue
        );
        assert_eq!(
            queue
                .publish(
                    &"é".repeat(64),
                    Value::Null,
                    &QueuePublishOptions::default(),
                )
                .unwrap_err()
                .code(),
            NativeStorageErrorCode::InvalidQueue
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn large_payload_dedupe_and_dead_letter_envelopes_remain_readable() {
        let (root, queue) = queue();
        let payload = Value::String("x".repeat(1024 * 1024 - 256));
        let options = QueuePublishOptions {
            idempotency_key: Some("large-job".into()),
            ..QueuePublishOptions::default()
        };
        let published = queue.publish("jobs", payload.clone(), &options).unwrap();
        let retried = queue.publish("jobs", payload.clone(), &options).unwrap();
        assert_eq!(retried.id, published.id);
        assert!(retried.deduplicated);

        let delivery = queue
            .claim(
                "jobs",
                "worker",
                QueueClaimOptions {
                    max_attempts: 1,
                    ..QueueClaimOptions::default()
                },
            )
            .unwrap()
            .remove(0);
        queue
            .nack(
                "jobs",
                "worker",
                &delivery.id,
                &delivery.receipt,
                0,
                "large payload failed",
            )
            .unwrap();
        let dead_letters = queue.dead_letters("jobs", "worker", 1).unwrap();
        assert_eq!(dead_letters[0].payload, payload);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn consumer_state_uses_the_versioned_camel_case_envelope() {
        let mut state = ConsumerState::new("jobs", "worker");
        state.pending.insert(
            "Q00000000000000000001".into(),
            DeliveryState::InFlight {
                receipt: "a".repeat(64),
                lease_expires_at: 1000,
                attempt: 1,
                max_attempts: 3,
            },
        );
        state.scan_cursor = Some("Q00000000000000000001".into());
        let encoded = serde_json::to_value(state).unwrap();
        let pending = &encoded["pending"]["Q00000000000000000001"];
        assert_eq!(pending["state"], "inFlight");
        assert_eq!(pending["leaseExpiresAt"], 1000);
        assert_eq!(pending["maxAttempts"], 3);
        assert!(pending.get("lease_expires_at").is_none());
    }

    #[test]
    fn queue_enumeration_skips_scratch_files_and_rejects_unknown_entries() {
        let (root, queue) = queue();
        let published = queue
            .publish("jobs", Value::Null, &QueuePublishOptions::default())
            .unwrap();
        let delivery = queue
            .claim(
                "jobs",
                "workers",
                QueueClaimOptions {
                    max_attempts: 1,
                    ..QueueClaimOptions::default()
                },
            )
            .unwrap()
            .remove(0);
        queue
            .nack(
                "jobs",
                "workers",
                &delivery.id,
                &delivery.receipt,
                0,
                "failed",
            )
            .unwrap();

        std::fs::write(
            queue
                .topic_path("jobs")
                .join(format!("{}.json.rust-crash.tmp", published.id)),
            b"partial",
        )
        .unwrap();
        std::fs::write(
            queue
                .dead_letter_root("jobs", "workers")
                .join(format!("{}.json.rust-crash.tmp", published.id)),
            b"partial",
        )
        .unwrap();

        assert_eq!(queue.stats("jobs", "workers").unwrap().published, 1);
        assert_eq!(queue.dead_letters("jobs", "workers", 1).unwrap().len(), 1);

        std::fs::write(
            queue.topic_path("jobs").join("unexpected.backup"),
            b"unknown",
        )
        .unwrap();
        assert_eq!(
            queue.stats("jobs", "workers").unwrap_err().code(),
            NativeStorageErrorCode::InvalidQueue
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn consumer_state_rejects_records_outside_the_v1_invariants() {
        let (root, queue) = queue();
        queue
            .claim("jobs", "workers", QueueClaimOptions::default())
            .unwrap();
        let path = queue.consumer_path("jobs", "workers");
        let id = "Q00000000000000000001";
        let valid = serde_json::json!({
            "format": GROUP_FORMAT,
            "topic": "jobs",
            "group": "workers",
            "cursor": null,
            "scanCursor": id,
            "pending": {
                (id): {
                    "state": "inFlight",
                    "receipt": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "leaseExpiresAt": 1000,
                    "attempt": 1,
                    "maxAttempts": 3
                }
            }
        });
        let invalid_records = [
            {
                let mut value = valid.clone();
                value["scanCursor"] = Value::String("invalid".into());
                value
            },
            {
                let mut value = valid.clone();
                value["pending"][id]["receipt"] = Value::String(String::new());
                value
            },
            {
                let mut value = valid.clone();
                value["pending"][id]["attempt"] = Value::from(0);
                value
            },
            {
                let mut value = valid.clone();
                value["pending"][id]["maxAttempts"] = Value::from(MAX_ATTEMPTS + 1);
                value
            },
            {
                let mut value = valid.clone();
                value["acknowledged"] = serde_json::json!({ (id): "wrong" });
                value
            },
            {
                let mut value = valid.clone();
                value["acknowledged"] = serde_json::json!({
                    (id): "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                });
                value["acknowledgedOrder"] = serde_json::json!(["Q99999999999999999999"]);
                value
            },
        ];
        for record in invalid_records {
            crate::write::write_json_durable(&path, &record).unwrap();
            assert_eq!(
                queue.read_consumer("jobs", "workers").unwrap_err().code(),
                NativeStorageErrorCode::InvalidQueue
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn legacy_acknowledged_map_without_order_is_normalized() {
        let (root, queue) = queue();
        queue
            .claim("jobs", "workers", QueueClaimOptions::default())
            .unwrap();
        let path = queue.consumer_path("jobs", "workers");
        let id = "Q00000000000000000001";
        crate::write::write_json_durable(
            &path,
            &serde_json::json!({
                "format": GROUP_FORMAT,
                "topic": "jobs",
                "group": "workers",
                "cursor": id,
                "scanCursor": id,
                "pending": {},
                "acknowledged": {
                    (id): "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                }
            }),
        )
        .unwrap();
        let state = queue.read_consumer("jobs", "workers").unwrap();
        assert_eq!(state.acknowledged_order, vec![id]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn corrupt_receipt_key_fails_closed() {
        let (root, queue) = queue();
        queue
            .publish("jobs", Value::Null, &QueuePublishOptions::default())
            .unwrap();
        crate::write::write_json_durable(
            &queue.receipt_key_path(),
            &serde_json::json!({
                "format": RECEIPT_KEY_FORMAT,
                "key": "not-a-key"
            }),
        )
        .unwrap();
        assert_eq!(
            queue
                .claim("jobs", "workers", QueueClaimOptions::default())
                .unwrap_err()
                .code(),
            NativeStorageErrorCode::InvalidQueue
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn dead_letter_reads_reject_records_outside_the_v1_invariants() {
        let (root, queue) = queue();
        let published = queue
            .publish("jobs", Value::Null, &QueuePublishOptions::default())
            .unwrap();
        let delivery = queue
            .claim(
                "jobs",
                "workers",
                QueueClaimOptions {
                    max_attempts: 1,
                    ..QueueClaimOptions::default()
                },
            )
            .unwrap()
            .remove(0);
        queue
            .nack(
                "jobs",
                "workers",
                &delivery.id,
                &delivery.receipt,
                0,
                "failed",
            )
            .unwrap();
        let path = queue.dead_letter_path("jobs", "workers", &published.id);
        let valid: Value = read_bounded_json(&path, MAX_DEAD_LETTER_BYTES).unwrap();
        let invalid_records = [
            {
                let mut value = valid.clone();
                value["format"] = Value::String("unknown".into());
                value
            },
            {
                let mut value = valid.clone();
                value["attempts"] = Value::from(0);
                value
            },
            {
                let mut value = valid.clone();
                value["reason"] = Value::String("x".repeat(4097));
                value
            },
            {
                let mut value = valid.clone();
                value["topic"] = Value::String("other".into());
                value
            },
        ];
        for record in invalid_records {
            crate::write::write_json_durable(&path, &record).unwrap();
            assert_eq!(
                queue.dead_letters("jobs", "workers", 1).unwrap_err().code(),
                NativeStorageErrorCode::InvalidQueue
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn queue_rejects_a_linked_encoded_name_parent() {
        use std::os::unix::fs::symlink;

        let (root, queue) = queue();
        queue.ensure_layout().unwrap();
        let outside = root.with_extension("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let linked = queue.queue_root().join("dedupe").join(encode_name("jobs"));
        symlink(&outside, &linked).unwrap();
        let error = queue
            .publish(
                "jobs",
                Value::Null,
                &QueuePublishOptions {
                    idempotency_key: Some("job-1".into()),
                    ..QueuePublishOptions::default()
                },
            )
            .unwrap_err();
        assert_eq!(error.code(), NativeStorageErrorCode::UnsafePath);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }
}
