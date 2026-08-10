// Fylo client — drives the `fylo` binary's persistent NDJSON loop.
//
// No dependencies (java.lang.Process only). Requires the `fylo` binary on PATH
// (brew/scoop) or an explicit path. One long-lived subprocess keeps the engine
// warm across calls.
//
//   try (Fylo db = new Fylo("/path/to/db")) {
//       db.createCollection("users");
//       String put = db.putData("users", Map.of("name", "Ada", "role", "admin"));
//       String admins = db.findDocs("users",
//           Map.of("$ops", List.of(Map.of("role", Map.of("$eq", "admin")))));
//   }
//
// Each operation method builds the request, checks it succeeded, and returns the
// raw JSON response line (parse `result` with Jackson/Gson). Method names follow
// Java's camelCase convention; object arguments are native Maps/Lists, encoded
// to JSON by the built-in `toJson`. request(json) is the raw escape hatch.

import java.io.BufferedInputStream;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public final class Fylo implements AutoCloseable {
    private static final int MAX_REQUEST_BYTES = 1024 * 1024;
    private static final int MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
    private final Process proc;
    private final BufferedWriter in;
    private final InputStream out;
    private final byte[] responseBuffer = new byte[MAX_RESPONSE_BYTES + 1];

    @Retention(RetentionPolicy.RUNTIME)
    @Target(ElementType.METHOD)
    public @interface QueueConsumer {
        String topic();
        String group();
        int maxMessages() default 1;
        long visibilityTimeoutMs() default 30000;
        int maxAttempts() default 3;
        long retryDelayMs() default 0;
    }

    @FunctionalInterface
    public interface QueueHandler {
        void handle(String deliveryJson) throws Exception;
    }

    @FunctionalInterface
    public interface QueueRunner {
        QueueProcessResult run() throws Exception;
    }

    public static final class QueueProcessResult {
        public int claimed;
        public int acknowledged;
        public int retried;
        public int deadLettered;
    }

    public Fylo(String root) throws IOException {
        this(root, "fylo");
    }

    public Fylo(String root, String binary) throws IOException {
        List<String> args = new ArrayList<>(List.of(binary, "exec", "--loop", "--root", root));
        args.add("--max-request-bytes");
        args.add(Integer.toString(MAX_REQUEST_BYTES));
        args.add("--max-response-bytes");
        args.add(Integer.toString(MAX_RESPONSE_BYTES));
        this.proc = new ProcessBuilder(args)
                .redirectError(ProcessBuilder.Redirect.INHERIT)
                .start();
        this.in = new BufferedWriter(
                new OutputStreamWriter(proc.getOutputStream(), StandardCharsets.UTF_8));
        this.out = new BufferedInputStream(proc.getInputStream());
    }

    /** Send one raw machine-protocol op (JSON string); returns the response line. */
    public synchronized String request(String opJson) throws IOException {
        if (!proc.isAlive()) throw new IOException("fylo process has exited");
        String payload = opJson.stripTrailing();
        if (payload.getBytes(StandardCharsets.UTF_8).length > MAX_REQUEST_BYTES) {
            throw new IOException("FYLO request exceeds " + MAX_REQUEST_BYTES + " bytes");
        }
        in.write(payload);
        in.write('\n');
        in.flush();
        int length = 0;
        while (length <= MAX_RESPONSE_BYTES) {
            int next = out.read();
            if (next < 0) throw new IOException("fylo closed the stream");
            if (next == '\n') {
                try {
                    return StandardCharsets.UTF_8.newDecoder()
                            .onMalformedInput(CodingErrorAction.REPORT)
                            .onUnmappableCharacter(CodingErrorAction.REPORT)
                            .decode(ByteBuffer.wrap(responseBuffer, 0, length))
                            .toString();
                } catch (java.nio.charset.CharacterCodingException error) {
                    proc.destroyForcibly();
                    throw new IOException("fylo returned malformed UTF-8", error);
                }
            }
            responseBuffer[length++] = (byte) next;
        }
        proc.destroyForcibly();
        throw new IOException("FYLO response exceeds " + MAX_RESPONSE_BYTES + " bytes");
    }

    // Build an op from native fields, send it, and error on a failure response.
    // ponytail: checks for the always-present "ok":true field by substring.
    private String op(String name, Object... kv) throws IOException {
        StringBuilder sb = new StringBuilder("{\"op\":").append(toJson(name));
        for (int i = 0; i + 1 < kv.length; i += 2) {
            sb.append(',').append(toJson(kv[i].toString())).append(':').append(toJson(kv[i + 1]));
        }
        String resp = request(sb.append('}').toString());
        if (!resp.contains("\"ok\":true")) throw new IOException(resp.strip());
        return resp;
    }

    // Quote a string as a JSON string literal, escaping control characters so an
    // embedded newline/tab can't break the newline-delimited protocol.
    static String quote(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    // Minimal JSON encoder for String / Number / Boolean / Map / Iterable / null.
    static String toJson(Object v) {
        if (v == null) return "null";
        if (v instanceof String) {
            return quote((String) v);
        }
        if (v instanceof Boolean || v instanceof Number) return v.toString();
        if (v instanceof Map) {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(toJson(e.getKey().toString())).append(':').append(toJson(e.getValue()));
            }
            return sb.append('}').toString();
        }
        if (v instanceof Iterable) {
            StringBuilder sb = new StringBuilder("[");
            boolean first = true;
            for (Object x : (Iterable<?>) v) {
                if (!first) sb.append(',');
                first = false;
                sb.append(toJson(x));
            }
            return sb.append(']').toString();
        }
        throw new IllegalArgumentException("unsupported JSON value: " + v.getClass());
    }

    private static int skipJsonSpace(String json, int index) {
        while (index < json.length() && Character.isWhitespace(json.charAt(index))) index++;
        return index;
    }

    private static int jsonStringEnd(String json, int start) throws IOException {
        if (start >= json.length() || json.charAt(start) != '"') {
            throw new IOException("expected a JSON string");
        }
        for (int index = start + 1; index < json.length(); index++) {
            char c = json.charAt(index);
            if (c == '"') return index + 1;
            if (c == '\\') index++;
            else if (c < 0x20) throw new IOException("invalid JSON string control character");
        }
        throw new IOException("unterminated JSON string");
    }

    private static int jsonValueEnd(String json, int start) throws IOException {
        start = skipJsonSpace(json, start);
        if (start >= json.length()) throw new IOException("missing JSON value");
        char first = json.charAt(start);
        if (first == '"') return jsonStringEnd(json, start);
        if (first == '{' || first == '[') {
            List<Character> stack = new ArrayList<>();
            stack.add(first == '{' ? '}' : ']');
            int index = start + 1;
            while (index < json.length()) {
                char c = json.charAt(index);
                if (c == '"') {
                    index = jsonStringEnd(json, index);
                    continue;
                }
                if (c == '{' || c == '[') stack.add(c == '{' ? '}' : ']');
                else if (c == '}' || c == ']') {
                    if (stack.isEmpty() || stack.remove(stack.size() - 1) != c) {
                        throw new IOException("mismatched JSON container");
                    }
                    if (stack.isEmpty()) return index + 1;
                }
                index++;
            }
            throw new IOException("unterminated JSON container");
        }
        int index = start;
        while (index < json.length()) {
            char c = json.charAt(index);
            if (c == ',' || c == ']' || c == '}' || Character.isWhitespace(c)) break;
            index++;
        }
        if (index == start) throw new IOException("missing JSON value");
        return index;
    }

    private static String jsonField(String object, String wanted) throws IOException {
        int index = skipJsonSpace(object, 0);
        if (index >= object.length() || object.charAt(index) != '{') {
            throw new IOException("expected a JSON object");
        }
        index++;
        while (true) {
            index = skipJsonSpace(object, index);
            if (index < object.length() && object.charAt(index) == '}') break;
            int keyEnd = jsonStringEnd(object, index);
            String key = decodeJsonString(object.substring(index, keyEnd));
            index = skipJsonSpace(object, keyEnd);
            if (index >= object.length() || object.charAt(index) != ':') {
                throw new IOException("JSON object field lacks a colon");
            }
            int valueStart = skipJsonSpace(object, index + 1);
            int valueEnd = jsonValueEnd(object, valueStart);
            if (key.equals(wanted)) return object.substring(valueStart, valueEnd);
            index = skipJsonSpace(object, valueEnd);
            if (index < object.length() && object.charAt(index) == ',') index++;
            else if (index < object.length() && object.charAt(index) == '}') break;
            else throw new IOException("invalid JSON object separator");
        }
        throw new IOException("FYLO response lacks an expected JSON field: " + wanted);
    }

    private static List<String> jsonArrayValues(String array) throws IOException {
        int index = skipJsonSpace(array, 0);
        if (index >= array.length() || array.charAt(index) != '[') {
            throw new IOException("expected a JSON array");
        }
        index++;
        List<String> values = new ArrayList<>();
        while (true) {
            index = skipJsonSpace(array, index);
            if (index < array.length() && array.charAt(index) == ']') return values;
            int end = jsonValueEnd(array, index);
            values.add(array.substring(index, end));
            index = skipJsonSpace(array, end);
            if (index < array.length() && array.charAt(index) == ',') index++;
            else if (index < array.length() && array.charAt(index) == ']') return values;
            else throw new IOException("invalid JSON array separator");
        }
    }

    private static String decodeJsonString(String value) throws IOException {
        if (value.length() < 2 || value.charAt(0) != '"' || value.charAt(value.length() - 1) != '"') {
            throw new IOException("expected a JSON string field");
        }
        StringBuilder decoded = new StringBuilder();
        for (int index = 1; index < value.length() - 1; index++) {
            char c = value.charAt(index);
            if (c != '\\') {
                decoded.append(c);
                continue;
            }
            if (++index >= value.length() - 1) throw new IOException("incomplete JSON escape");
            c = value.charAt(index);
            switch (c) {
                case '"': decoded.append('"'); break;
                case '\\': decoded.append('\\'); break;
                case '/': decoded.append('/'); break;
                case 'b': decoded.append('\b'); break;
                case 'f': decoded.append('\f'); break;
                case 'n': decoded.append('\n'); break;
                case 'r': decoded.append('\r'); break;
                case 't': decoded.append('\t'); break;
                case 'u':
                    if (index + 4 >= value.length()) throw new IOException("invalid JSON unicode escape");
                    try {
                        decoded.append((char) Integer.parseInt(value.substring(index + 1, index + 5), 16));
                    } catch (NumberFormatException error) {
                        throw new IOException("invalid JSON unicode escape", error);
                    }
                    index += 4;
                    break;
                default: throw new IOException("unknown JSON escape");
            }
        }
        return decoded.toString();
    }

    // --- Collections ---
    public String createCollection(String collection) throws IOException {
        return createCollection(collection, "document");
    }
    public String createCollection(String collection, String kind) throws IOException {
        return op("createCollection", "collection", collection, "kind", kind);
    }
    public String dropCollection(String collection) throws IOException {
        return op("dropCollection", "collection", collection);
    }
    public String inspectCollection(String collection) throws IOException {
        return op("inspectCollection", "collection", collection);
    }
    public String rebuildCollection(String collection) throws IOException {
        return op("rebuildCollection", "collection", collection);
    }

    // --- Durable serverless queue ---
    public String queuePublish(String topic, Object payload) throws IOException {
        return op("queuePublish", "topic", topic, "payload", payload);
    }
    public String queuePublish(String topic, Object payload, long delayMs, String idempotencyKey) throws IOException {
        if (idempotencyKey == null) return op("queuePublish", "topic", topic, "payload", payload, "delayMs", delayMs);
        return op("queuePublish", "topic", topic, "payload", payload, "delayMs", delayMs, "idempotencyKey", idempotencyKey);
    }
    public String queueClaim(String topic, String group, int maxMessages, long visibilityTimeoutMs, int maxAttempts) throws IOException {
        return op("queueClaim", "topic", topic, "group", group, "maxMessages", maxMessages, "visibilityTimeoutMs", visibilityTimeoutMs, "maxAttempts", maxAttempts);
    }
    public String queueAck(String topic, String group, String id, String receipt) throws IOException {
        return op("queueAck", "topic", topic, "group", group, "id", id, "receipt", receipt);
    }
    public String queueNack(String topic, String group, String id, String receipt, long delayMs, String reason) throws IOException {
        return op("queueNack", "topic", topic, "group", group, "id", id, "receipt", receipt, "delayMs", delayMs, "reason", reason);
    }
    public String queueExtend(String topic, String group, String id, String receipt, long visibilityTimeoutMs) throws IOException {
        return op("queueExtend", "topic", topic, "group", group, "id", id, "receipt", receipt, "visibilityTimeoutMs", visibilityTimeoutMs);
    }
    public String queueStats(String topic, String group) throws IOException {
        return op("queueStats", "topic", topic, "group", group);
    }
    public String queueDeadLetters(String topic, String group, int limit) throws IOException {
        return op("queueDeadLetters", "topic", topic, "group", group, "limit", limit);
    }

    /** Process and settle one bounded batch; deliveryJson is one raw JSON object. */
    public QueueProcessResult queueProcess(
            String topic, String group, QueueHandler handler, int maxMessages,
            long visibilityTimeoutMs, int maxAttempts, long retryDelayMs) throws Exception {
        if (handler == null) throw new IllegalArgumentException("queue handler is required");
        String response = queueClaim(topic, group, maxMessages, visibilityTimeoutMs, maxAttempts);
        List<String> deliveries = jsonArrayValues(jsonField(response, "result"));
        QueueProcessResult result = new QueueProcessResult();
        result.claimed = deliveries.size();
        for (String delivery : deliveries) {
            String id = decodeJsonString(jsonField(delivery, "id"));
            String receipt = decodeJsonString(jsonField(delivery, "receipt"));
            try {
                handler.handle(delivery);
            } catch (Exception ignored) {
                String settled = queueNack(
                        topic, group, id, receipt, retryDelayMs, "queue handler failed");
                if (jsonField(jsonField(settled, "result"), "deadLettered").equals("true")) {
                    result.deadLettered++;
                } else {
                    result.retried++;
                }
                continue;
            }
            queueAck(topic, group, id, receipt);
            result.acknowledged++;
        }
        return result;
    }

    public QueueRunner queueConsumer(
            String topic, String group, QueueHandler handler, int maxMessages,
            long visibilityTimeoutMs, int maxAttempts, long retryDelayMs) {
        return () -> queueProcess(topic, group, handler, maxMessages,
                visibilityTimeoutMs, maxAttempts, retryDelayMs);
    }

    /** Run a method configured with {@link QueueConsumer}. */
    public QueueProcessResult runQueueConsumer(Object target, String methodName) throws Exception {
        Method selected = null;
        for (Method method : target.getClass().getDeclaredMethods()) {
            if (!method.getName().equals(methodName) || method.getAnnotation(QueueConsumer.class) == null) continue;
            if (selected != null) throw new IOException("queue consumer method name is ambiguous");
            selected = method;
        }
        if (selected == null) throw new IOException("queue consumer method is missing or unannotated");
        if (selected.getParameterCount() != 1 || selected.getParameterTypes()[0] != String.class) {
            throw new IOException("queue consumer method must accept one delivery JSON string");
        }
        selected.setAccessible(true);
        final Method method = selected;
        QueueConsumer consumer = method.getAnnotation(QueueConsumer.class);
        return queueProcess(
                consumer.topic(), consumer.group(), delivery -> {
                    try {
                        method.invoke(target, delivery);
                    } catch (InvocationTargetException error) {
                        Throwable cause = error.getCause();
                        if (cause instanceof Error) throw (Error) cause;
                        if (cause instanceof Exception) throw (Exception) cause;
                        throw new IOException("queue consumer failed", cause);
                    }
                },
                consumer.maxMessages(), consumer.visibilityTimeoutMs(),
                consumer.maxAttempts(), consumer.retryDelayMs());
    }

    // --- Documents (object args are native Maps/Lists) ---
    public String putData(String collection, Map<String, Object> data) throws IOException {
        return op("putData", "collection", collection, "data", data);
    }
    public String getDoc(String collection, String id) throws IOException {
        return op("getDoc", "collection", collection, "id", id);
    }
    public String getMeta(String collection, String id) throws IOException {
        return op("getMeta", "collection", collection, "id", id);
    }
    public String setMeta(String collection, String id, Map<String, Object> meta) throws IOException {
        return op("setMeta", "collection", collection, "id", id, "meta", meta);
    }
    public String getLatest(String collection, String id) throws IOException {
        return op("getLatest", "collection", collection, "id", id);
    }
    public String patchDoc(String collection, String id, Map<String, Object> newDoc)
            throws IOException {
        return op("patchDoc", "collection", collection, "id", id, "newDoc", newDoc);
    }
    public String delDoc(String collection, String id) throws IOException {
        return op("delDoc", "collection", collection, "id", id);
    }
    public String restoreDoc(String collection, String id) throws IOException {
        return op("restoreDoc", "collection", collection, "id", id);
    }

    // --- Query ---
    public String findDocs(String collection, Map<String, Object> query) throws IOException {
        return op("findDocs", "collection", collection, "query", query);
    }
    public String findDocsPage(String collection, Map<String, Object> query, Map<String, Object> page) throws IOException {
        return op("findDocs", "collection", collection, "query", query, "page", page);
    }
    public String findDeletedDocsPage(String collection, Map<String, Object> query, Map<String, Object> page) throws IOException {
        return op("findDeletedDocs", "collection", collection, "query", query, "page", page);
    }
    public String executeSQL(String sql) throws IOException {
        return op("executeSQL", "sql", sql);
    }
    public String executeSQL(String sql, Map<String, Object> access) throws IOException {
        return op("executeSQL", "sql", sql, "access", access);
    }

    // Run raw SQL, built with concatenation/String.format. Values are inlined
    // verbatim — escape/validate untrusted input yourself.
    public String sql(String query) throws IOException {
        return executeSQL(query);
    }
    public String sql(String query, Map<String, Object> access) throws IOException {
        return executeSQL(query, access);
    }

    /** Collection-scoped facade: db.collection("users").put(data). */
    public Collection collection(String name) {
        return new Collection(name);
    }

    /** A collection-scoped view; methods drop the leading collection argument. */
    public final class Collection {
        private final String name;

        private Collection(String name) {
            this.name = name;
        }

        public String create() throws IOException {
            return createCollection(name);
        }
        public String create(String kind) throws IOException {
            return createCollection(name, kind);
        }
        public String drop() throws IOException {
            return dropCollection(name);
        }
        public String inspect() throws IOException {
            return inspectCollection(name);
        }
        public String rebuild() throws IOException {
            return rebuildCollection(name);
        }
        public String put(Map<String, Object> data) throws IOException {
            return putData(name, data);
        }
        public String get(String id) throws IOException {
            return getDoc(name, id);
        }
        public String getMeta(String id) throws IOException { return Fylo.this.getMeta(name, id); }
        public String setMeta(String id, Map<String, Object> meta) throws IOException {
            return Fylo.this.setMeta(name, id, meta);
        }
        public String latest(String id) throws IOException {
            return getLatest(name, id);
        }
        public String patch(String id, Map<String, Object> newDoc) throws IOException {
            return patchDoc(name, id, newDoc);
        }
        public String delete(String id) throws IOException {
            return delDoc(name, id);
        }
        public String restore(String id) throws IOException {
            return restoreDoc(name, id);
        }
        public String find(Map<String, Object> query) throws IOException {
            return findDocs(name, query);
        }
        public String findPage(Map<String, Object> query, Map<String, Object> page) throws IOException {
            return findDocsPage(name, query, page);
        }
    }

    @Override
    public void close() throws IOException {
        if (proc.isAlive()) {
            in.close(); // EOF ends the loop
            try {
                proc.waitFor();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }
}
