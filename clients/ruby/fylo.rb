# Fylo client — drives the `fylo` binary's persistent NDJSON loop.
#
# No gems (json + open3 are stdlib). Requires the `fylo` binary on PATH
# (brew/scoop) or an explicit path. One long-lived subprocess keeps the engine
# warm across calls.
#
#   require_relative "fylo"
#
#   Fylo.open("/path/to/db") do |db|
#     db.create_collection("users")
#     id = db.put_data("users", { "name" => "Ada", "role" => "admin" })
#     doc = db.get_latest("users", id)
#     admins = db.find_docs("users", { "$ops" => [{ "role" => { "$eq" => "admin" } }] })
#   end
#
# Each operation method builds the request and returns the op's `result`
# (raising FyloError on failure). Method names follow Ruby's snake_case
# convention; object arguments are native Hashes. `request(op)` is the raw
# escape hatch returning the full response Hash.

require "json"
require "open3"

MAX_REQUEST_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024

class FyloError < StandardError; end

class Fylo
  def self.open(root, binary: "fylo")
    db = new(root, binary: binary)
    return db unless block_given?
    begin
      yield db
    ensure
      db.close
    end
  end

  def initialize(root, binary: "fylo")
    args = [
      binary, "exec", "--loop", "--root", root,
      "--max-request-bytes", MAX_REQUEST_BYTES.to_s,
      "--max-response-bytes", MAX_RESPONSE_BYTES.to_s
    ]
    @stdin, @stdout, @wait = Open3.popen2(*args)
    @mutex = Mutex.new
  end

  # Send one raw machine-protocol op; return the full response Hash.
  def request(op)
    payload = JSON.generate(op)
    raise FyloError, "FYLO request exceeds #{MAX_REQUEST_BYTES} bytes" if payload.bytesize > MAX_REQUEST_BYTES
    reply = @mutex.synchronize do
      raise FyloError, "fylo process has exited" unless @wait.alive?
      @stdin.puts(payload)
      @stdin.flush
      @stdout.gets(MAX_RESPONSE_BYTES + 2)
    end
    raise FyloError, "fylo closed the stream" if reply.nil?
    unless reply.end_with?("\n") && reply.bytesize - 1 <= MAX_RESPONSE_BYTES
      Process.kill("KILL", @wait.pid) rescue nil
      raise FyloError, "FYLO response exceeds #{MAX_RESPONSE_BYTES} bytes"
    end
    begin
      JSON.parse(reply)
    rescue JSON::ParserError, EncodingError => error
      Process.kill("KILL", @wait.pid) rescue nil
      raise FyloError, "fylo returned malformed UTF-8 or JSON: #{error.message}"
    end
  end

  # --- Collections ---
  def create_collection(collection, kind = "document")
    op("createCollection", "collection" => collection, "kind" => kind)
  end

  def drop_collection(collection)
    op("dropCollection", "collection" => collection)
  end

  def inspect_collection(collection)
    op("inspectCollection", "collection" => collection)
  end

  def rebuild_collection(collection)
    op("rebuildCollection", "collection" => collection)
  end

  # --- Durable serverless queue ---
  def queue_publish(topic, payload, delay_ms: nil, idempotency_key: nil)
    op("queuePublish", "topic" => topic, "payload" => payload, "delayMs" => delay_ms, "idempotencyKey" => idempotency_key)
  end

  def queue_claim(topic, group, max_messages: nil, visibility_timeout_ms: nil, max_attempts: nil)
    op("queueClaim", "topic" => topic, "group" => group, "maxMessages" => max_messages, "visibilityTimeoutMs" => visibility_timeout_ms, "maxAttempts" => max_attempts)
  end

  def queue_ack(topic, group, id, receipt)
    op("queueAck", "topic" => topic, "group" => group, "id" => id, "receipt" => receipt)
  end

  def queue_nack(topic, group, id, receipt, delay_ms: nil, reason: nil)
    op("queueNack", "topic" => topic, "group" => group, "id" => id, "receipt" => receipt, "delayMs" => delay_ms, "reason" => reason)
  end

  def queue_extend(topic, group, id, receipt, visibility_timeout_ms: nil)
    op("queueExtend", "topic" => topic, "group" => group, "id" => id, "receipt" => receipt, "visibilityTimeoutMs" => visibility_timeout_ms)
  end

  def queue_stats(topic, group)
    op("queueStats", "topic" => topic, "group" => group)
  end

  def queue_dead_letters(topic, group, limit: nil)
    op("queueDeadLetters", "topic" => topic, "group" => group, "limit" => limit)
  end

  # Process and settle one bounded batch. Ruby has no decorator syntax, so
  # queue_consumer returns an equivalent callable wrapper.
  def queue_process(topic, group, max_messages: 1, visibility_timeout_ms: 30_000,
                    max_attempts: 3, retry_delay_ms: 0, &handler)
    raise ArgumentError, "queue handler block is required" unless handler
    deliveries = queue_claim(topic, group, max_messages: max_messages,
                             visibility_timeout_ms: visibility_timeout_ms,
                             max_attempts: max_attempts)
    result = { "claimed" => deliveries.length, "acknowledged" => 0,
               "retried" => 0, "deadLettered" => 0 }
    deliveries.each do |delivery|
      failed = false
      begin
        handler.call(delivery)
      rescue StandardError
        failed = true
      end
      unless failed
        queue_ack(topic, group, delivery.fetch("id"), delivery.fetch("receipt"))
        result["acknowledged"] += 1
      else
        settled = queue_nack(topic, group, delivery.fetch("id"), delivery.fetch("receipt"),
                             delay_ms: retry_delay_ms,
                             reason: "queue handler failed")
        result[settled["deadLettered"] ? "deadLettered" : "retried"] += 1
      end
    end
    result
  end

  def queue_consumer(topic, group, **options, &handler)
    raise ArgumentError, "queue handler block is required" unless handler
    lambda { queue_process(topic, group, **options, &handler) }
  end

  # --- Documents ---
  def put_data(collection, data)
    op("putData", "collection" => collection, "data" => data)
  end

  def batch_put_data(collection, batch)
    op("batchPutData", "collection" => collection, "batch" => batch)
  end

  def get_doc(collection, id)
    op("getDoc", "collection" => collection, "id" => id)
  end

  def get_meta(collection, id)
    op("getMeta", "collection" => collection, "id" => id)
  end

  def set_meta(collection, id, meta)
    op("setMeta", "collection" => collection, "id" => id, "meta" => meta)
  end

  def get_latest(collection, id)
    op("getLatest", "collection" => collection, "id" => id)
  end

  def patch_doc(collection, id, new_doc)
    op("patchDoc", "collection" => collection, "id" => id, "newDoc" => new_doc)
  end

  def patch_docs(collection, update)
    op("patchDocs", "collection" => collection, "update" => update)
  end

  def del_doc(collection, id)
    op("delDoc", "collection" => collection, "id" => id)
  end

  def del_docs(collection, criteria)
    op("delDocs", "collection" => collection, "delete" => criteria)
  end

  def restore_doc(collection, id)
    op("restoreDoc", "collection" => collection, "id" => id)
  end

  # --- Query ---
  def find_docs(collection, query)
    op("findDocs", "collection" => collection, "query" => query)
  end

  def find_deleted_docs(collection, query = {})
    op("findDeletedDocs", "collection" => collection, "query" => query)
  end

  def find_docs_page(collection, query, page = {})
    op("findDocs", "collection" => collection, "query" => query, "page" => page)
  end

  def find_deleted_docs_page(collection, query = {}, page = {})
    op("findDeletedDocs", "collection" => collection, "query" => query, "page" => page)
  end

  def join_docs(join)
    op("joinDocs", "join" => join)
  end

  def execute_sql(sql, access = nil)
    op("executeSQL", "sql" => sql, "access" => access)
  end

  # Run raw SQL, built with native interpolation: db.sql("... #{x}").
  # Values are inlined verbatim — escape/validate untrusted input yourself.
  def sql(query, access = nil)
    execute_sql(query, access)
  end

  def import_bulk_data(collection, url)
    op("importBulkData", "collection" => collection, "url" => url)
  end

  def close
    return unless @wait.alive?
    @stdin.close # EOF ends the loop
    @wait.value
  end

  # Collection-scoped facade with short method names, so
  # `db.collection("users").put(data)` reads like the browser client.
  def collection(name)
    Collection.new(self, name)
  end

  CONVERSIONS = %i[to_ary to_hash to_str to_int to_a to_proc to_io].freeze
  private_constant :CONVERSIONS

  # Sugar: `db.users.put(...)` -> `db.collection("users").put(...)`.
  def method_missing(name, *args, &block)
    return super if block || !args.empty? || CONVERSIONS.include?(name) ||
                    name.to_s.end_with?("=", "?", "!")
    collection(name.to_s)
  end

  def respond_to_missing?(name, include_private = false)
    return super if CONVERSIONS.include?(name) || name.to_s.end_with?("=", "?", "!")
    true
  end

  private

  def op(name, fields)
    payload = { "op" => name }
    fields.each { |k, v| payload[k] = v unless v.nil? }
    resp = request(payload)
    raise FyloError, (resp.dig("error", "message") || "fylo error") unless resp["ok"]
    resp["result"]
  end
end

# A collection-scoped view; methods drop the leading collection argument.
class Fylo
  class Collection
    def initialize(db, name)
      @db = db
      @name = name
    end

    def create(kind = "document")
      @db.create_collection(@name, kind)
    end

    def drop
      @db.drop_collection(@name)
    end

    # NB: Object#inspect is used by irb/p, so it stays a safe repr here — call
    # `db.inspect_collection(name)` for the collection's metadata.
    def inspect
      "#<Fylo::Collection #{@name}>"
    end

    def rebuild
      @db.rebuild_collection(@name)
    end

    def put(data)
      @db.put_data(@name, data)
    end

    def get(id)
      @db.get_doc(@name, id)
    end

    def get_metadata(id)
      @db.get_meta(@name, id)
    end

    def set_metadata(id, meta)
      @db.set_meta(@name, id, meta)
    end

    def latest(id)
      @db.get_latest(@name, id)
    end

    def patch(id, new_doc)
      @db.patch_doc(@name, id, new_doc)
    end

    def delete(id)
      @db.del_doc(@name, id)
    end

    def restore(id)
      @db.restore_doc(@name, id)
    end

    def find(query)
      @db.find_docs(@name, query)
    end

    def find_page(query, page = {})
      @db.find_docs_page(@name, query, page)
    end
  end
end
