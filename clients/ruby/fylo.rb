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
