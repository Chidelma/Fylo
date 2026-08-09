// src/browser/vendor/ttid.mjs
var PRECISION = 1e4;
var BASE = 36;
var PLACEHOLDER = "X";
var MIN_TIMESTAMP_MS = 1577836800000;
var MAX_TIMESTAMP_MS = 7258118400000;
var TTID_PATTERN = /^[A-Z0-9]{11}(-[A-Z0-9]{1,11}){0,2}$/i;
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function timeNow() {
  return (performance.now() + performance.timeOrigin) * PRECISION;
}
function decodeTime(_id) {
  if (!TTID_PATTERN.test(_id))
    throw new Error("Invalid Format!");
  const [created, updated, deleted] = _id.split("-");
  const convertToMilliseconds = (timeCode) => {
    const ms = Number((parseInt(timeCode, BASE) / PRECISION).toFixed(0));
    if (!isFinite(ms) || ms < MIN_TIMESTAMP_MS || ms > MAX_TIMESTAMP_MS) {
      throw new Error("Invalid timestamp encoding");
    }
    return ms;
  };
  const timestamps = { createdAt: convertToMilliseconds(created) };
  if (updated && updated !== PLACEHOLDER)
    timestamps.updatedAt = convertToMilliseconds(updated);
  if (deleted)
    timestamps.deletedAt = convertToMilliseconds(deleted);
  return timestamps;
}
function isTTID(_id) {
  if (!_id || _id.length > 36)
    return null;
  if (!TTID_PATTERN.test(_id))
    return null;
  try {
    const { createdAt } = decodeTime(_id);
    return new Date(createdAt);
  } catch {
    return null;
  }
}
function isUUID(_id) {
  return _id.match(UUID_PATTERN);
}
function generate(_id, del = false) {
  if (_id && isTTID(_id) && _id.split("-").length === 3) {
    throw new Error("This identifier can no longer be modified");
  }
  const time = timeNow();
  if (_id && isTTID(_id) && del) {
    const [created, updated] = _id.split("-");
    const deleted = time.toString(BASE);
    return `${created}-${updated ?? PLACEHOLDER}-${deleted}`.toUpperCase();
  }
  if (_id && isTTID(_id)) {
    const [created] = _id.split("-");
    const updated = time.toString(BASE);
    return `${created}-${updated}`.toUpperCase();
  }
  if (_id && !isTTID(_id))
    throw new Error("Invalid TTID!");
  return time.toString(BASE).toUpperCase();
}

class TTID {
  static generate = generate;
  static decodeTime = decodeTime;
  static isTTID = isTTID;
  static isUUID = isUUID;
}

// src/core/shard.js
var DEFAULT_SHARD_WIDTH = 1;
var MIN_SHARD_WIDTH = 1;
var MAX_SHARD_WIDTH = 4;
function shardOf(id, width = DEFAULT_SHARD_WIDTH) {
  const shard = assertShardWidth(width);
  return creationSegment(id).slice(-shard).padStart(shard, "0");
}
function legacyShardOf(id) {
  return creationSegment(id).slice(0, 2);
}
function assertShardWidth(width) {
  if (!Number.isInteger(width) || Number(width) < MIN_SHARD_WIDTH || Number(width) > MAX_SHARD_WIDTH) {
    throw new Error(`Shard width must be an integer from ${MIN_SHARD_WIDTH} to ${MAX_SHARD_WIDTH}: ${String(width)}`);
  }
  return Number(width);
}
function creationSegment(id) {
  const created = String(id).split("-")[0];
  if (created.length === 0 || !/^[0-9A-Za-z]+$/.test(created)) {
    throw new Error(`Cannot shard a non-identifier: ${String(id)}`);
  }
  return created;
}

// src/query/safe-record.js
function safeRecord() {
  return Object.create(null);
}
function copySafeRecord(source) {
  const target = safeRecord();
  for (const [key, value] of Object.entries(source))
    target[key] = value;
  return target;
}
function copySafeJson(value) {
  if (Array.isArray(value))
    return value.map(copySafeJson);
  if (typeof value !== "object" || value === null)
    return value;
  const target = safeRecord();
  for (const [key, nested] of Object.entries(value))
    target[key] = copySafeJson(nested);
  return target;
}

// src/core/collection.js
var RESERVED_NAMES = new Set([
  "sql",
  "as",
  "then",
  "db",
  "engine",
  "cache",
  "queue",
  "startup",
  "importBulkData",
  "join",
  "ready",
  "close",
  "_sql"
]);

class CollectionNotFoundError extends Error {
  collection;
  code = "FYLO_COLLECTION_NOT_FOUND";
  status = 404;
  constructor(collection) {
    super(`Collection not found: ${collection}`);
    this.name = "CollectionNotFoundError";
    this.collection = collection;
  }
}
function validateCollectionName(collection) {
  if (!/^[a-z0-9][a-z0-9\-]*[a-z0-9]$/.test(collection)) {
    throw new Error("Invalid collection name");
  }
  if (RESERVED_NAMES.has(collection)) {
    throw new Error(`'${collection}' is a reserved name and cannot be used as a collection name. ` + `Choose a different name.`);
  }
}

// src/query/parser.js
var TokenType = {
  CREATE: "CREATE",
  DROP: "DROP",
  SELECT: "SELECT",
  FROM: "FROM",
  WHERE: "WHERE",
  INSERT: "INSERT",
  INTO: "INTO",
  VALUES: "VALUES",
  UPDATE: "UPDATE",
  SET: "SET",
  DELETE: "DELETE",
  JOIN: "JOIN",
  INNER: "INNER",
  LEFT: "LEFT",
  RIGHT: "RIGHT",
  OUTER: "OUTER",
  ON: "ON",
  GROUP: "GROUP",
  BY: "BY",
  ORDER: "ORDER",
  LIMIT: "LIMIT",
  AS: "AS",
  AND: "AND",
  OR: "OR",
  EQUALS: "=",
  NOT_EQUALS: "!=",
  GREATER_THAN: ">",
  LESS_THAN: "<",
  GREATER_EQUAL: ">=",
  LESS_EQUAL: "<=",
  LIKE: "LIKE",
  IDENTIFIER: "IDENTIFIER",
  STRING: "STRING",
  NUMBER: "NUMBER",
  BOOLEAN: "BOOLEAN",
  NULL: "NULL",
  COMMA: ",",
  SEMICOLON: ";",
  LPAREN: "(",
  RPAREN: ")",
  ASTERISK: "*",
  EOF: "EOF"
};
var SINGLE_CHARACTER_TOKENS = {
  "=": TokenType.EQUALS,
  ",": TokenType.COMMA,
  ";": TokenType.SEMICOLON,
  "(": TokenType.LPAREN,
  ")": TokenType.RPAREN,
  "*": TokenType.ASTERISK
};
var COMPARISON_TOKENS = {
  ">": { withEquals: TokenType.GREATER_EQUAL, alone: TokenType.GREATER_THAN },
  "<": { withEquals: TokenType.LESS_EQUAL, alone: TokenType.LESS_THAN },
  "!": { withEquals: TokenType.NOT_EQUALS, alone: null }
};

class SQLLexer {
  input;
  position = 0;
  current = null;
  constructor(input) {
    this.input = input.trim();
    this.current = this.input[0] || null;
  }
  advance() {
    this.position++;
    this.current = this.position < this.input.length ? this.input[this.position] : null;
  }
  peek() {
    const nextPosition = this.position + 1;
    return nextPosition < this.input.length ? this.input[nextPosition] : null;
  }
  skipWhitespace() {
    while (this.current && /\s/.test(this.current)) {
      this.advance();
    }
  }
  readString() {
    let result = "";
    const quote = this.current;
    this.advance();
    while (this.current && this.current !== quote) {
      result += this.current;
      this.advance();
    }
    while (this.current === quote && this.peek() === quote) {
      result += quote;
      this.advance();
      this.advance();
      while (this.current && this.current !== quote) {
        result += this.current;
        this.advance();
      }
    }
    if (this.current === quote) {
      this.advance();
    }
    return result;
  }
  readNumber() {
    let result = "";
    while (this.current && /[\d.]/.test(this.current)) {
      result += this.current;
      this.advance();
    }
    return result;
  }
  readIdentifier() {
    let result = "";
    while (this.current && /[a-zA-Z0-9_\-]/.test(this.current)) {
      result += this.current;
      this.advance();
    }
    return result;
  }
  getKeywordType(word) {
    const keywords = {
      SELECT: TokenType.SELECT,
      FROM: TokenType.FROM,
      WHERE: TokenType.WHERE,
      INSERT: TokenType.INSERT,
      INTO: TokenType.INTO,
      VALUES: TokenType.VALUES,
      UPDATE: TokenType.UPDATE,
      SET: TokenType.SET,
      DELETE: TokenType.DELETE,
      JOIN: TokenType.JOIN,
      INNER: TokenType.INNER,
      LEFT: TokenType.LEFT,
      RIGHT: TokenType.RIGHT,
      OUTER: TokenType.OUTER,
      ON: TokenType.ON,
      GROUP: TokenType.GROUP,
      BY: TokenType.BY,
      ORDER: TokenType.ORDER,
      LIMIT: TokenType.LIMIT,
      AS: TokenType.AS,
      AND: TokenType.AND,
      OR: TokenType.OR,
      LIKE: TokenType.LIKE,
      TRUE: TokenType.BOOLEAN,
      FALSE: TokenType.BOOLEAN,
      NULL: TokenType.NULL
    };
    return keywords[word.toUpperCase()] || TokenType.IDENTIFIER;
  }
  tokenize() {
    const tokens = [];
    while (this.current) {
      this.skipWhitespace();
      if (!this.current)
        break;
      const position = this.position;
      if (this.current === "'" || this.current === '"') {
        const value = this.readString();
        tokens.push({ type: TokenType.STRING, value, position });
        continue;
      }
      if (/\d/.test(this.current)) {
        const value = this.readNumber();
        tokens.push({ type: TokenType.NUMBER, value, position });
        continue;
      }
      if (/[a-zA-Z_]/.test(this.current)) {
        tokens.push(this.readIdentifierToken(position));
        continue;
      }
      const operator = this.readOperatorToken(position);
      if (operator)
        tokens.push(operator);
    }
    tokens.push({ type: TokenType.EOF, value: "", position: this.position });
    return tokens;
  }
  readIdentifierToken(position) {
    let value = this.readIdentifier();
    while (this.current === "." && this.position + 1 < this.input.length && /[a-zA-Z_]/.test(this.input[this.position + 1])) {
      this.advance();
      value += "/" + this.readIdentifier();
    }
    return { type: this.getKeywordType(value), value, position };
  }
  readOperatorToken(position) {
    const character = this.current;
    if (!character)
      return null;
    const comparison = COMPARISON_TOKENS[character];
    if (comparison) {
      const { withEquals, alone } = comparison;
      if (this.input[this.position + 1] === "=") {
        this.advance();
        this.advance();
        return { type: withEquals, value: `${character}=`, position };
      }
      this.advance();
      return alone ? { type: alone, value: character, position } : null;
    }
    const single = SINGLE_CHARACTER_TOKENS[character];
    this.advance();
    return single ? { type: single, value: character, position } : null;
  }
}

class SQLParser {
  tokens;
  position = 0;
  current;
  constructor(tokens) {
    this.tokens = tokens;
    this.current = tokens[0];
  }
  advance() {
    this.position++;
    this.current = this.tokens[this.position] || {
      type: TokenType.EOF,
      value: "",
      position: -1
    };
  }
  expect(type) {
    if (this.current.type !== type) {
      throw new Error("Invalid SQL syntax");
    }
    const token = this.current;
    this.advance();
    return token;
  }
  match(...types) {
    return types.includes(this.current.type);
  }
  parseValue() {
    if (this.current.type === TokenType.STRING) {
      const value = this.current.value;
      this.advance();
      return value;
    }
    if (this.current.type === TokenType.NUMBER) {
      const value = parseFloat(this.current.value);
      this.advance();
      return value;
    }
    if (this.current.type === TokenType.BOOLEAN) {
      const value = this.current.value.toLowerCase() === "true";
      this.advance();
      return value;
    }
    if (this.current.type === TokenType.NULL) {
      this.advance();
      return null;
    }
    throw new Error(`Unexpected value type: ${this.current.type}`);
  }
  parseOperator() {
    const operatorMap = {
      [TokenType.EQUALS]: "$eq",
      [TokenType.NOT_EQUALS]: "$ne",
      [TokenType.GREATER_THAN]: "$gt",
      [TokenType.LESS_THAN]: "$lt",
      [TokenType.GREATER_EQUAL]: "$gte",
      [TokenType.LESS_EQUAL]: "$lte",
      [TokenType.LIKE]: "$like"
    };
    if (operatorMap[this.current.type]) {
      const operator = operatorMap[this.current.type];
      this.advance();
      return operator ?? "";
    }
    throw new Error(`Unknown operator: ${this.current.type}`);
  }
  parseCondition() {
    const column = this.expect(TokenType.IDENTIFIER).value;
    const operator = this.parseOperator();
    const value = this.parseValue();
    return { column, operator, value };
  }
  parseWhereClause() {
    this.expect(TokenType.WHERE);
    const conditions = [];
    let conjunction = safeRecord();
    while (true) {
      const condition = this.parseCondition();
      const operand = conjunction[condition.column] ?? safeRecord();
      operand[condition.operator] = condition.value;
      conjunction[condition.column] = operand;
      if (this.match(TokenType.AND)) {
        this.advance();
        continue;
      }
      if (this.match(TokenType.OR)) {
        conditions.push(conjunction);
        conjunction = safeRecord();
        this.advance();
        continue;
      }
      break;
    }
    conditions.push(conjunction);
    return conditions;
  }
  parseSelectClause() {
    this.expect(TokenType.SELECT);
    const columns = [];
    if (this.current.type === TokenType.ASTERISK) {
      this.advance();
      return ["*"];
    }
    do {
      columns.push(this.expect(TokenType.IDENTIFIER).value);
      if (this.current.type === TokenType.COMMA) {
        this.advance();
      } else {
        break;
      }
    } while (true);
    return columns;
  }
  parseSelect() {
    const select = this.parseSelectClause();
    this.expect(TokenType.FROM);
    const collection = this.expect(TokenType.IDENTIFIER).value;
    if (this.match(TokenType.JOIN, TokenType.INNER, TokenType.LEFT, TokenType.RIGHT, TokenType.OUTER)) {
      return this.parseJoinQuery(select, collection);
    }
    const query = {
      $collection: collection,
      $select: select.includes("*") ? undefined : select,
      $onlyIds: select.includes("_id")
    };
    if (this.match(TokenType.WHERE)) {
      query.$ops = this.parseWhereClause();
    }
    if (this.match(TokenType.GROUP)) {
      this.advance();
      this.expect(TokenType.BY);
      query.$groupby = this.expect(TokenType.IDENTIFIER).value;
    }
    if (this.match(TokenType.LIMIT)) {
      this.advance();
      query.$limit = parseInt(this.expect(TokenType.NUMBER).value);
    }
    return query;
  }
  parseJoinQuery(select, leftCollection) {
    let joinMode = "inner";
    if (this.match(TokenType.INNER)) {
      this.advance();
      joinMode = "inner";
    } else if (this.match(TokenType.LEFT)) {
      this.advance();
      joinMode = "left";
    } else if (this.match(TokenType.RIGHT)) {
      this.advance();
      joinMode = "right";
    } else if (this.match(TokenType.OUTER)) {
      this.advance();
      joinMode = "outer";
    }
    this.expect(TokenType.JOIN);
    const rightCollection = this.expect(TokenType.IDENTIFIER).value;
    this.expect(TokenType.ON);
    const onConditions = this.parseJoinConditions();
    const joinQuery = {
      $leftCollection: leftCollection,
      $rightCollection: rightCollection,
      $mode: joinMode,
      $on: onConditions,
      $select: select.includes("*") ? undefined : select
    };
    if (this.match(TokenType.WHERE)) {
      this.parseWhereClause();
    }
    if (this.match(TokenType.GROUP)) {
      this.advance();
      this.expect(TokenType.BY);
      joinQuery.$groupby = this.expect(TokenType.IDENTIFIER).value;
    }
    if (this.match(TokenType.LIMIT)) {
      this.advance();
      joinQuery.$limit = parseInt(this.expect(TokenType.NUMBER).value);
    }
    return joinQuery;
  }
  parseJoinConditions() {
    const conditions = safeRecord();
    do {
      const leftSide = this.parseJoinColumn();
      const operator = this.parseJoinOperator();
      const rightSide = this.parseJoinColumn();
      const leftColumn = leftSide.column;
      const rightColumn = rightSide.column;
      if (!Object.hasOwn(conditions, leftColumn))
        conditions[leftColumn] = safeRecord();
      conditions[leftColumn][operator] = rightColumn;
      if (this.match(TokenType.AND)) {
        this.advance();
      } else {
        break;
      }
    } while (true);
    return conditions;
  }
  parseJoinColumn() {
    const identifier = this.expect(TokenType.IDENTIFIER).value;
    if (this.current.type === TokenType.IDENTIFIER) {
      return { column: identifier };
    }
    return { column: identifier };
  }
  parseJoinOperator() {
    const operatorMap = {
      [TokenType.EQUALS]: "$eq",
      [TokenType.NOT_EQUALS]: "$ne",
      [TokenType.GREATER_THAN]: "$gt",
      [TokenType.LESS_THAN]: "$lt",
      [TokenType.GREATER_EQUAL]: "$gte",
      [TokenType.LESS_EQUAL]: "$lte"
    };
    if (operatorMap[this.current.type]) {
      const operator = operatorMap[this.current.type];
      this.advance();
      if (!operator)
        throw new Error(`Unknown join operator: ${this.current.type}`);
      return operator;
    }
    throw new Error(`Unknown join operator: ${this.current.type}`);
  }
  parseInsert() {
    this.expect(TokenType.INSERT);
    this.expect(TokenType.INTO);
    const collection = this.expect(TokenType.IDENTIFIER).value;
    let columns = [];
    if (this.current.type === TokenType.LPAREN) {
      this.advance();
      do {
        columns.push(this.expect(TokenType.IDENTIFIER).value);
        if (this.current.type === TokenType.COMMA) {
          this.advance();
        } else {
          break;
        }
      } while (true);
      this.expect(TokenType.RPAREN);
    }
    this.expect(TokenType.VALUES);
    this.expect(TokenType.LPAREN);
    const values = safeRecord();
    let valueIndex = 0;
    do {
      const value = this.parseValue();
      const column = columns[valueIndex] || `col${valueIndex}`;
      values[column] = value;
      valueIndex++;
      if (this.current.type === TokenType.COMMA) {
        this.advance();
      } else {
        break;
      }
    } while (true);
    this.expect(TokenType.RPAREN);
    return {
      $collection: collection,
      $values: values
    };
  }
  parseUpdate() {
    this.expect(TokenType.UPDATE);
    const collection = this.expect(TokenType.IDENTIFIER).value;
    this.expect(TokenType.SET);
    const set = safeRecord();
    do {
      const column = this.expect(TokenType.IDENTIFIER).value;
      this.expect(TokenType.EQUALS);
      const value = this.parseValue();
      set[column] = value;
      if (this.current.type === TokenType.COMMA) {
        this.advance();
      } else {
        break;
      }
    } while (true);
    const update = {
      $collection: collection,
      $set: set
    };
    if (this.match(TokenType.WHERE)) {
      const whereQuery = {
        $collection: collection,
        $ops: this.parseWhereClause()
      };
      update.$where = whereQuery;
    }
    return update;
  }
  parseDelete() {
    this.expect(TokenType.DELETE);
    this.expect(TokenType.FROM);
    const collection = this.expect(TokenType.IDENTIFIER).value;
    const deleteQuery = {
      $collection: collection
    };
    if (this.match(TokenType.WHERE)) {
      deleteQuery.$ops = this.parseWhereClause();
    }
    return deleteQuery;
  }
}

class Parser {
  static parse(sql) {
    const lexer = new SQLLexer(sql);
    const tokens = lexer.tokenize();
    const parser = new SQLParser(tokens);
    const firstToken = tokens[0];
    switch (firstToken.value) {
      case TokenType.CREATE:
        return { $collection: tokens[2].value };
      case TokenType.SELECT:
        return parser.parseSelect();
      case TokenType.INSERT:
        return parser.parseInsert();
      case TokenType.UPDATE:
        return parser.parseUpdate();
      case TokenType.DELETE:
        return parser.parseDelete();
      case TokenType.DROP:
        return { $collection: tokens[2].value };
      default:
        throw new Error(`Unsupported SQL statement type: ${firstToken.value}`);
    }
  }
  static query(collection) {
    return new QueryBuilder(collection);
  }
  static join(leftCollection, rightCollection) {
    return new JoinBuilder(leftCollection, rightCollection);
  }
}

class QueryBuilder {
  collection;
  queryAst = {};
  constructor(collection) {
    this.collection = collection;
    this.queryAst.$collection = collection;
  }
  select(...columns) {
    this.queryAst.$select = columns;
    return this;
  }
  where(conditions) {
    this.queryAst.$ops = conditions;
    return this;
  }
  limit(count) {
    this.queryAst.$limit = count;
    return this;
  }
  groupBy(column) {
    this.queryAst.$groupby = column;
    return this;
  }
  onlyIds() {
    this.queryAst.$onlyIds = true;
    return this;
  }
  build() {
    return this.queryAst;
  }
  toSQL() {
    let sql = "SELECT ";
    if (this.queryAst.$select) {
      sql += this.queryAst.$select.join(", ");
    } else {
      sql += "*";
    }
    sql += ` FROM ${this.collection}`;
    if (this.queryAst.$ops && this.queryAst.$ops.length > 0) {
      sql += " WHERE ";
      const conditions = this.queryAst.$ops.map((op) => {
        const entries = Object.entries(op);
        return entries.map(([column, operand]) => {
          const opEntries = Object.entries(operand ?? {});
          return opEntries.map(([operator, value]) => {
            const sqlOp = this.operatorToSQL(operator);
            const sqlValue = typeof value === "string" ? `'${value}'` : value;
            return `${column} ${sqlOp} ${sqlValue}`;
          }).join(" AND ");
        }).join(" AND ");
      }).join(" AND ");
      sql += conditions;
    }
    if (this.queryAst.$groupby) {
      sql += ` GROUP BY ${String(this.queryAst.$groupby)}`;
    }
    if (this.queryAst.$limit) {
      sql += ` LIMIT ${this.queryAst.$limit}`;
    }
    return sql;
  }
  operatorToSQL(operator) {
    const opMap = {
      $eq: "=",
      $ne: "!=",
      $gt: ">",
      $lt: "<",
      $gte: ">=",
      $lte: "<=",
      $like: "LIKE"
    };
    return opMap[operator] || "=";
  }
}

class JoinBuilder {
  joinAst = {};
  constructor(leftCollection, rightCollection) {
    this.joinAst.$leftCollection = leftCollection;
    this.joinAst.$rightCollection = rightCollection;
    this.joinAst.$mode = "inner";
  }
  select(...columns) {
    this.joinAst.$select = columns;
    return this;
  }
  innerJoin() {
    this.joinAst.$mode = "inner";
    return this;
  }
  leftJoin() {
    this.joinAst.$mode = "left";
    return this;
  }
  rightJoin() {
    this.joinAst.$mode = "right";
    return this;
  }
  outerJoin() {
    this.joinAst.$mode = "outer";
    return this;
  }
  on(conditions) {
    this.joinAst.$on = conditions;
    return this;
  }
  limit(count) {
    this.joinAst.$limit = count;
    return this;
  }
  groupBy(column) {
    this.joinAst.$groupby = column;
    return this;
  }
  onlyIds() {
    this.joinAst.$onlyIds = true;
    return this;
  }
  rename(mapping) {
    this.joinAst.$rename = mapping;
    return this;
  }
  build() {
    if (!this.joinAst.$on) {
      throw new Error("JOIN query must have ON conditions");
    }
    return this.joinAst;
  }
  toSQL() {
    let sql = "SELECT ";
    if (this.joinAst.$select) {
      sql += this.joinAst.$select.join(", ");
    } else {
      sql += "*";
    }
    sql += ` FROM ${this.joinAst.$leftCollection}`;
    const joinType = this.joinAst.$mode?.toUpperCase() || "INNER";
    sql += ` ${joinType} JOIN ${this.joinAst.$rightCollection}`;
    if (this.joinAst.$on) {
      sql += " ON ";
      const conditions = Object.entries(this.joinAst.$on).map(([leftCol, operand]) => {
        return Object.entries(operand ?? {}).map(([operator, rightCol]) => {
          const sqlOp = this.operatorToSQL(operator);
          return `${this.joinAst.$leftCollection}.${leftCol} ${sqlOp} ${this.joinAst.$rightCollection}.${String(rightCol)}`;
        }).join(" AND ");
      }).join(" AND ");
      sql += conditions;
    }
    if (this.joinAst.$groupby) {
      sql += ` GROUP BY ${String(this.joinAst.$groupby)}`;
    }
    if (this.joinAst.$limit) {
      sql += ` LIMIT ${this.joinAst.$limit}`;
    }
    return sql;
  }
  operatorToSQL(operator) {
    const opMap = {
      $eq: "=",
      $ne: "!=",
      $gt: ">",
      $lt: "<",
      $gte: ">=",
      $lte: "<="
    };
    return opMap[operator] || "=";
  }
}

// src/query/planner.js
function deepFreeze(value, seen = new WeakSet) {
  if (!value || typeof value !== "object" || seen.has(value))
    return value;
  seen.add(value);
  for (const child of Object.values(value))
    deepFreeze(child, seen);
  return Object.freeze(value);
}
function accessPaths(query) {
  if (!query?.$ops?.length)
    return [{ kind: "document-scan" }];
  const access = [];
  for (const operation of query.$ops) {
    for (const [field, operand] of Object.entries(operation)) {
      if (!operand || typeof operand !== "object")
        continue;
      const operators = Object.keys(operand);
      const indexable = operators.some((operator) => ["$eq", "$gt", "$gte", "$lt", "$lte", "$like", "$contains"].includes(operator));
      access.push(indexable ? { kind: "prefix-index", field, operators } : { kind: "document-filter", field, operators });
    }
  }
  return access.length > 0 ? access : [{ kind: "document-scan" }];
}

class FyloQueryPlanner {
  prepare(input) {
    if (typeof input !== "string" || input.trim().length === 0) {
      throw new Error("SQL statement must be a non-empty string");
    }
    let sql = input.trim();
    let explain = false;
    let analyze = false;
    const explainMatch = sql.match(/^EXPLAIN(?:\s+(ANALYZE))?\s+/i);
    if (explainMatch) {
      explain = true;
      analyze = Boolean(explainMatch[1]);
      sql = sql.slice(explainMatch[0].length).trim();
    }
    const operation = sql.match(/^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP)\b/i)?.[1];
    if (!operation)
      throw new Error("Missing SQL Operation");
    const ast = deepFreeze(Parser.parse(sql));
    const collection = String(ast.$collection ?? ast.$leftCollection ?? "");
    const query = operation.toUpperCase() === "UPDATE" ? ast.$where : ast;
    return deepFreeze({
      sql,
      operation: operation.toUpperCase(),
      collection,
      ast,
      explain,
      analyze,
      access: accessPaths(query)
    });
  }
  describe(plan) {
    return {
      operation: plan.operation,
      collection: plan.collection,
      access: plan.access.map((step) => ({ ...step })),
      executed: false
    };
  }
}

// src/browser/core/filesystem.js
function runInLane(lanes, key, body) {
  const previous = lanes.get(key) ?? Promise.resolve();
  const next = previous.then(() => body(), () => body());
  lanes.set(key, next.then(() => {
    return;
  }, () => {
    return;
  }));
  return next;
}

// src/browser/core/path.js
var SEPARATOR = "/";
function isMeaningful(segment) {
  return segment.length > 0 && segment !== ".";
}
function normalize(value) {
  if (typeof value !== "string")
    return "";
  const isAbsolute = value.startsWith(SEPARATOR);
  const out = [];
  for (const segment of value.split(SEPARATOR)) {
    if (!isMeaningful(segment))
      continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbsolute) {
        out.push("..");
      }
      continue;
    }
    out.push(segment);
  }
  const joined = out.join(SEPARATOR);
  if (isAbsolute)
    return SEPARATOR + joined;
  return joined || ".";
}
function join(...segments) {
  const parts = [];
  for (const segment of segments) {
    if (typeof segment !== "string")
      continue;
    if (segment.length === 0)
      continue;
    parts.push(segment);
  }
  if (parts.length === 0)
    return ".";
  return normalize(parts.join(SEPARATOR));
}
function dirname(value) {
  const normalised = normalize(value);
  if (normalised === SEPARATOR)
    return SEPARATOR;
  const index = normalised.lastIndexOf(SEPARATOR);
  if (index < 0)
    return ".";
  if (index === 0)
    return SEPARATOR;
  return normalised.slice(0, index);
}
function basename(value) {
  const normalised = normalize(value);
  if (normalised === SEPARATOR)
    return "";
  const index = normalised.lastIndexOf(SEPARATOR);
  if (index < 0)
    return normalised;
  return normalised.slice(index + 1);
}
function relative(from, to) {
  const fromSegments = normalize(from).split(SEPARATOR).filter((segment) => segment.length > 0);
  const toSegments = normalize(to).split(SEPARATOR).filter((segment) => segment.length > 0);
  let common = 0;
  while (common < fromSegments.length && common < toSegments.length && fromSegments[common] === toSegments[common]) {
    common++;
  }
  const out = [];
  for (let index = common;index < fromSegments.length; index++)
    out.push("..");
  for (let index = common;index < toSegments.length; index++)
    out.push(toSegments[index]);
  return out.join(SEPARATOR);
}
function assertPathInside(parent, target) {
  const resolvedParent = normalize(parent);
  const resolvedTarget = normalize(target);
  if (resolvedTarget === resolvedParent)
    return;
  const offset = relative(resolvedParent, resolvedTarget);
  if (offset.startsWith("..") || offset.startsWith(SEPARATOR)) {
    throw new Error(`Unsafe document path: ${target}`);
  }
}

// src/browser/core/documents.js
class BrowserDocuments {
  constructor(fs, docsRoot, docPath, deletedRoot, deletedPath, ensureCollection) {
    this.fs = fs;
    this.docsRoot = docsRoot;
    this.docPath = docPath;
    this.deletedRoot = deletedRoot;
    this.deletedPath = deletedPath;
    this.ensureCollection = ensureCollection;
  }
  validateDocId(docId) {
    if (!TTID.isTTID(docId))
      throw new Error(`Invalid document ID: ${docId}`);
  }
  async readStoredDoc(collection, docId) {
    this.validateDocId(docId);
    const root = this.docsRoot(collection);
    const target = await this.existingPath(root, this.docPath(collection, docId), docId);
    assertPathInside(root, target);
    if (!await this.fs.exists(target))
      return null;
    const text = await this.fs.readText(target);
    const raw = this.parseJsonDocumentText(text);
    const { createdAt } = TTID.decodeTime(docId);
    return {
      id: docId,
      createdAt,
      updatedAt: await this.fs.mtimeMs(target),
      data: stripInternalFields(raw)
    };
  }
  async readDeletedDoc(collection, docId) {
    this.validateDocId(docId);
    const root = this.deletedRoot(collection);
    const target = await this.existingPath(root, this.deletedPath(collection, docId), docId);
    assertPathInside(root, target);
    if (!await this.fs.exists(target))
      return null;
    const text = await this.fs.readText(target);
    const raw = this.parseJsonDocumentText(text);
    const { createdAt } = TTID.decodeTime(docId);
    return {
      id: docId,
      createdAt,
      deletedAt: typeof raw._deletedAt === "number" ? raw._deletedAt : createdAt,
      data: stripInternalFields(raw)
    };
  }
  async writeStoredDoc(collection, docId, data) {
    this.validateDocId(docId);
    await this.ensureCollection(collection);
    const target = this.docPath(collection, docId);
    assertPathInside(this.docsRoot(collection), target);
    const text = JSON.stringify(data);
    this.assertJsonDocumentText(text);
    await this.fs.writeText(target, text);
    await this.removeLegacyCopy(this.docsRoot(collection), target, docId);
    const tombstone = this.deletedPath(collection, docId);
    if (await this.fs.exists(tombstone))
      await this.fs.remove(tombstone);
    await this.removeLegacyCopy(this.deletedRoot(collection), tombstone, docId);
  }
  async removeStoredDoc(collection, docId) {
    this.validateDocId(docId);
    const root = this.docsRoot(collection);
    const target = await this.existingPath(root, this.docPath(collection, docId), docId);
    assertPathInside(root, target);
    if (await this.fs.exists(target))
      await this.fs.remove(target);
  }
  async softDeleteStoredDoc(collection, docId, deletedAt) {
    this.validateDocId(docId);
    const source = await this.existingPath(this.docsRoot(collection), this.docPath(collection, docId), docId);
    const target = this.deletedPath(collection, docId);
    assertPathInside(this.docsRoot(collection), source);
    assertPathInside(this.deletedRoot(collection), target);
    if (!await this.fs.exists(source)) {
      throw new Error(`Document not found: ${docId}`);
    }
    const sourceText = await this.fs.readText(source);
    const raw = this.parseJsonDocumentText(sourceText);
    const stamped = { ...raw, _deletedAt: deletedAt };
    const tombstoneText = JSON.stringify(stamped);
    this.assertJsonDocumentText(tombstoneText);
    await this.fs.writeText(target, tombstoneText);
    await this.fs.remove(source);
    return target;
  }
  async restoreStoredDoc(collection, docId, _restoredAt) {
    this.validateDocId(docId);
    const source = await this.existingPath(this.deletedRoot(collection), this.deletedPath(collection, docId), docId);
    const target = this.docPath(collection, docId);
    assertPathInside(this.deletedRoot(collection), source);
    assertPathInside(this.docsRoot(collection), target);
    if (!await this.fs.exists(source)) {
      throw new Error(`No tombstone to restore: ${docId}`);
    }
    const sourceText = await this.fs.readText(source);
    const raw = this.parseJsonDocumentText(sourceText);
    const restoredText = JSON.stringify(stripInternalFields(raw));
    this.assertJsonDocumentText(restoredText);
    await this.fs.writeText(target, restoredText);
    await this.fs.remove(source);
    return target;
  }
  async makeStoredDocReadOnly(_collection, _docId) {}
  async existingPath(root, canonical, docId) {
    if (await this.fs.exists(canonical))
      return canonical;
    const legacy = join(root, legacyShardOf(docId), `${docId}.json`);
    assertPathInside(root, legacy);
    return legacy !== canonical && await this.fs.exists(legacy) ? legacy : canonical;
  }
  async removeLegacyCopy(root, canonical, docId) {
    const legacy = join(root, legacyShardOf(docId), `${docId}.json`);
    assertPathInside(root, legacy);
    if (legacy !== canonical && await this.fs.exists(legacy))
      await this.fs.remove(legacy);
  }
  assertJsonDocumentText(text) {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("FYLO document body must be a JSON object");
    }
  }
  parseJsonDocumentText(text) {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("FYLO document body must be a JSON object");
    }
    return raw;
  }
  async listDocIds(collection) {
    return await listBucketedDocIds(this.fs, this.docsRoot(collection));
  }
  async listDeletedDocIds(collection) {
    return await listBucketedDocIds(this.fs, this.deletedRoot(collection));
  }
}
function stripInternalFields(raw) {
  const out = { ...raw };
  delete out._updatedAt;
  delete out._deletedAt;
  return out;
}
async function listBucketedDocIds(fs, root) {
  if (!await fs.exists(root))
    return [];
  const ids = [];
  const buckets = await fs.list(root);
  for (const bucket of buckets) {
    const bucketPath = join(root, bucket);
    if (!await fs.isDirectory(bucketPath))
      continue;
    const files = await fs.list(bucketPath);
    for (const file of files) {
      if (!file.endsWith(".json"))
        continue;
      const id = basename(file).slice(0, -".json".length);
      if (TTID.isTTID(id))
        ids.push(id);
    }
  }
  return ids;
}

// src/browser/core/metadata.js
var META_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var MAX_META_VALUE_BYTES = 60 * 1024;
function validateMetadataRecord(record) {
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    throw new Error("Metadata must be a plain object of name/value pairs");
  }
  for (const [name, value] of Object.entries(record)) {
    if (!META_NAME.test(name)) {
      throw new Error('Metadata name must be 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit');
    }
    if (value !== null) {
      const encoded = JSON.stringify(value);
      if (encoded === undefined)
        throw new Error("Metadata values must be JSON-serializable");
      if (new TextEncoder().encode(encoded).byteLength > MAX_META_VALUE_BYTES) {
        throw new Error("Metadata values must be at most 60 KiB when JSON-encoded");
      }
    }
  }
}

class BrowserMetadataStore {
  constructor(fs, collectionRoot) {
    this.fs = fs;
    this.collectionRoot = collectionRoot;
  }
  root(collection) {
    return join(this.collectionRoot(collection), ".metadata");
  }
  path(collection, id) {
    if (!TTID.isTTID(id))
      throw new Error(`Invalid document ID: ${id}`);
    const root = this.root(collection);
    const target = join(root, shardOf(id), `${id}.json`);
    assertPathInside(root, target);
    return target;
  }
  async read(collection, id) {
    const target = await this.existingPath(collection, id);
    if (!await this.fs.exists(target))
      return { values: safeRecord(), updatedAt: 0 };
    const parsed = JSON.parse(await this.fs.readText(target));
    return {
      values: parsed && typeof parsed.values === "object" && !Array.isArray(parsed.values) ? copySafeJson(parsed.values) : safeRecord(),
      updatedAt: typeof parsed?.updatedAt === "number" ? parsed.updatedAt : 0
    };
  }
  async mutate(collection, id, mutations) {
    validateMetadataRecord(mutations);
    const current = await this.read(collection, id);
    const values = copySafeJson(current.values);
    for (const [name, value] of Object.entries(mutations)) {
      if (value === null)
        delete values[name];
      else
        values[name] = copySafeJson(value);
    }
    return await this.write(collection, id, values, Math.max(Date.now(), current.updatedAt + 1));
  }
  async write(collection, id, values, updatedAt) {
    const target = this.path(collection, id);
    await this.fs.mkdir(join(this.root(collection), shardOf(id)), { recursive: true });
    await this.fs.writeText(target, JSON.stringify({ values, updatedAt }));
    const legacy = this.legacyPath(collection, id);
    if (legacy !== target && await this.fs.exists(legacy))
      await this.fs.remove(legacy);
    return { values, updatedAt };
  }
  legacyPath(collection, id) {
    const root = this.root(collection);
    const target = join(root, legacyShardOf(id), `${id}.json`);
    assertPathInside(root, target);
    return target;
  }
  async existingPath(collection, id) {
    const canonical = this.path(collection, id);
    if (await this.fs.exists(canonical))
      return canonical;
    const legacy = this.legacyPath(collection, id);
    return legacy !== canonical && await this.fs.exists(legacy) ? legacy : canonical;
  }
}

// src/browser/core/event-bus.js
class BrowserEventBus {
  constructor(fs, rootForCollection) {
    this.fs = fs;
    this.rootForCollection = rootForCollection;
    this.target = new EventTarget;
  }
  journalPath(collection) {
    return join(this.rootForCollection(collection), "events", `${collection}.ndjson`);
  }
  async publish(collection, event) {
    await this.fs.appendText(this.journalPath(collection), `${JSON.stringify(event)}
`);
    this.target.dispatchEvent(new CustomEvent(collection, { detail: event }));
  }
  subscribe(collection, listener) {
    const handler = (event) => {
      listener(event.detail);
    };
    this.target.addEventListener(collection, handler);
    return () => this.target.removeEventListener(collection, handler);
  }
  async* listen(collection) {
    const queue = [];
    let wake = () => {};
    const unsubscribe = this.subscribe(collection, (event) => {
      queue.push(event);
      wake();
    });
    try {
      while (true) {
        if (queue.length === 0) {
          await new Promise((resolve) => {
            wake = () => resolve(undefined);
          });
        }
        while (queue.length > 0)
          yield queue.shift();
      }
    } finally {
      unsubscribe();
    }
  }
}

// src/storage/value-codec.js
function stringifyStoredValue(value) {
  return String(value).replaceAll("/", "%2F");
}

// src/browser/core/prefix-index.js
var LOCAL_FS_FORMAT = "fylo.local-fs.index.v1";
var LOCAL_FS_MANIFEST = "manifest.json";
var LOCAL_FS_SNAPSHOT = "keys.snapshot";
var LOCAL_FS_WAL = "keys.wal";
var LOCAL_FS_WAL_COMPACT_BYTES = 1048576;
var MAX_STRING_PREFIX_BYTES = 180;
var MAX_NGRAM_SOURCE_CHARS = 512;
var NGRAM_SIZE = 3;
var UINT64_MAX = (1n << 64n) - 1n;
var SIGN_MASK = 1n << 63n;
var ENCODER = new TextEncoder;
var DECODER = new TextDecoder;
function encodeSegment(value) {
  return encodeURIComponent(value);
}
function decodeSegment(value) {
  return decodeURIComponent(value);
}
function bytesToHex(bytes) {
  let hex = "";
  for (const byte of bytes)
    hex += byte.toString(16).padStart(2, "0");
  return hex;
}
async function sha256Hex(value) {
  const buffer = await crypto.subtle.digest("SHA-256", ENCODER.encode(value));
  return bytesToHex(new Uint8Array(buffer));
}
async function lookupToken(value) {
  const encoded = encodeSegment(value);
  if (ENCODER.encode(encoded).byteLength <= MAX_STRING_PREFIX_BYTES)
    return encoded;
  return `h_${await sha256Hex(value)}`;
}
function sortableFloat64(value) {
  if (!Number.isFinite(value))
    return "";
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const sortable = bits & SIGN_MASK ? ~bits & UINT64_MAX : bits ^ SIGN_MASK;
  return sortable.toString(16).padStart(16, "0");
}
function reverseSortable(sortable) {
  const value = BigInt(`0x${sortable}`);
  return (UINT64_MAX - value).toString(16).padStart(16, "0");
}
function numericValue(value) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}
function reverseString(value) {
  return Array.from(value).reverse().join("");
}
function trigrams(value) {
  const source = value.slice(0, MAX_NGRAM_SOURCE_CHARS);
  const chars = Array.from(source);
  if (chars.length < NGRAM_SIZE)
    return [];
  const grams = new Set;
  for (let i = 0;i <= chars.length - NGRAM_SIZE; i++) {
    grams.add(chars.slice(i, i + NGRAM_SIZE).join(""));
  }
  return [...grams];
}
function encodeFieldPath(fieldPath) {
  return fieldPath.split("/").map(encodeSegment).join("/");
}
function docIdFromKey(prefix, key) {
  const suffix = key.slice(prefix.length);
  const segments = suffix.split("/");
  const docId = decodeSegment(segments.at(-1) ?? "");
  if (!TTID.isTTID(docId))
    throw new Error(`Invalid document ID: ${docId}`);
  return docId;
}
async function queryLookupValue(collection, fieldPath, value) {
  const stored = stringifyStoredValue(value);
  return lookupToken(stored);
}
async function likeQueryPrefixes(collection, fieldPath, pattern) {
  if (pattern.includes("_"))
    return null;
  const wildcards = (pattern.match(/%/g) ?? []).length;
  if (wildcards === 0) {
    return [
      {
        kind: "eq",
        valuePrefix: `${await queryLookupValue(collection, fieldPath, pattern)}/`
      }
    ];
  }
  if (wildcards === 1 && pattern.endsWith("%")) {
    return [{ kind: "f", valuePrefix: encodeSegment(pattern.slice(0, -1)) }];
  }
  if (wildcards === 1 && pattern.startsWith("%")) {
    return [{ kind: "r", valuePrefix: encodeSegment(reverseString(pattern.slice(1))) }];
  }
  return containsQueryPrefixes(pattern, wildcards);
}
function containsQueryPrefixes(pattern, wildcards) {
  if (wildcards !== 2 || !pattern.startsWith("%") || !pattern.endsWith("%"))
    return null;
  if (pattern.length <= 2)
    return null;
  const needle = pattern.slice(1, -1);
  if (Array.from(needle).length < NGRAM_SIZE)
    return null;
  const planned = trigrams(needle)[0];
  return [{ kind: "g3", valuePrefix: `${encodeSegment(planned ?? needle.slice(0, 3))}/` }];
}
function rangeQueryPrefixes(operand) {
  const rangeEntries = [];
  for (const operator of ["$gt", "$gte", "$lt", "$lte"]) {
    const raw = operand[operator];
    if (raw === undefined)
      continue;
    const numeric = numericValue(raw);
    const sortable = numeric === null ? "" : sortableFloat64(numeric);
    if (!sortable)
      return null;
    const ascending = operator === "$gt" || operator === "$gte";
    rangeEntries.push({
      kind: ascending ? "n" : "nr",
      valuePrefix: "",
      range: { op: operator, value: ascending ? sortable : reverseSortable(sortable) }
    });
  }
  return rangeEntries.length ? rangeEntries : null;
}

class BrowserPrefixIndexCodec {
  static key(fieldPath, kind, value, docId) {
    if (!TTID.isTTID(docId))
      throw new Error(`Invalid document ID: ${docId}`);
    return [encodeFieldPath(fieldPath), kind, value, encodeSegment(docId)].join("/");
  }
  static prefix(fieldPath, kind, valuePrefix = "") {
    return [encodeFieldPath(fieldPath), kind, valuePrefix].join("/");
  }
  static async entriesForDocument(collection, docId, data) {
    const entries = [];
    const exactEntries = [];
    const addValue = async (fieldPath, raw) => {
      const value = stringifyStoredValue(raw);
      const planKey = (kind, plannedValue) => this.key(fieldPath, kind, plannedValue, docId);
      exactEntries.push(this.key(fieldPath, "eq", await lookupToken(value), docId));
      const numeric = numericValue(raw);
      const sortable = numeric === null ? "" : sortableFloat64(numeric);
      if (sortable) {
        entries.push(planKey("n", sortable));
        entries.push(planKey("nr", reverseSortable(sortable)));
      }
      if (typeof raw !== "string")
        return;
      const encoded = encodeSegment(value);
      if (ENCODER.encode(encoded).byteLength > MAX_STRING_PREFIX_BYTES)
        return;
      entries.push(planKey("f", encoded));
      entries.push(planKey("r", encodeSegment(reverseString(value))));
      for (const gram of trigrams(value)) {
        entries.push(planKey("g3", encodeSegment(gram)));
      }
    };
    const walk = async (target, parentField) => {
      for (const field of Object.keys(target)) {
        const fieldPath = parentField ? `${parentField}/${field}` : field;
        const value = target[field];
        if (value && typeof value === "object" && !Array.isArray(value)) {
          await walk(value, fieldPath);
          continue;
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item && typeof item === "object") {
              throw new Error("Cannot index an array of objects");
            }
            await addValue(fieldPath, item);
          }
          continue;
        }
        await addValue(fieldPath, value);
      }
    };
    await walk(data);
    entries.push(...exactEntries);
    return [...new Set(entries)];
  }
  static async queryPrefixes(collection, fieldPath, operand) {
    if (operand.$eq !== undefined) {
      return [
        {
          kind: "eq",
          valuePrefix: `${await queryLookupValue(collection, fieldPath, operand.$eq)}/`
        }
      ];
    }
    if (operand.$contains !== undefined) {
      return [
        {
          kind: "eq",
          valuePrefix: `${await queryLookupValue(collection, fieldPath, operand.$contains)}/`
        }
      ];
    }
    if (operand.$like !== undefined) {
      return await likeQueryPrefixes(collection, fieldPath, operand.$like);
    }
    return rangeQueryPrefixes(operand);
  }
  static rangeValueFromKey(key) {
    const segments = key.split("/");
    return segments.at(-2) ?? "";
  }
}
function completeLines(text) {
  if (!text)
    return [];
  const complete = text.endsWith(`
`) ? text : text.slice(0, text.lastIndexOf(`
`) + 1);
  return complete.split(`
`).map(stripTrailingCarriageReturn).filter(Boolean);
}
function stripTrailingCarriageReturn(line) {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
function serializeSnapshot(keys) {
  return keys.length ? `${keys.join(`
`)}
` : "";
}
function serializeWal(mutations) {
  return mutations.map((mutation) => `${mutation.op}	${mutation.key}
`).join("");
}
function parseWalMutation(line) {
  const operation = line[0];
  if (operation !== "+" && operation !== "-" || line[1] !== "\t")
    return null;
  const key = line.slice(2);
  return key ? { op: operation, key } : null;
}
async function readTextIfExists(fs, path) {
  if (!await fs.exists(path))
    return "";
  return await fs.readText(path);
}
async function writeIfMissing(fs, path, data) {
  if (await fs.exists(path))
    return;
  await fs.writeText(path, data);
}

class BrowserPrefixIndex {
  constructor(fs, rootForCollection, options = {}) {
    this.fs = fs;
    this.rootForCollection = rootForCollection;
    this.snapshotCache = new Map;
    this.indexScannerFactory = options.indexScannerFactory;
    this.scanners = new Map;
    this.scannerSnapshots = new Map;
    this.walOverlayCache = new Map;
    this.accelerationState = "loading";
    this.accelerationError = null;
    this.accelerationReasonCode = null;
    this.accelerationMetrics = {
      snapshotReads: 0,
      snapshotReadMs: 0,
      snapshotBytes: 0,
      walReads: 0,
      walReadMs: 0,
      walBytes: 0,
      snapshotLoads: 0,
      snapshotLoadMs: 0,
      scans: 0,
      scanMs: 0
    };
  }
  async ready() {
    if (!this.indexScannerFactory || this.accelerationState === "fallback")
      return;
    try {
      await this.indexScannerFactory.ready();
      this.accelerationState = "active";
    } catch (error) {
      await this.disableAcceleration(error, "EWASM_INSTANTIATE");
    }
  }
  async close() {
    const scanners = [...this.scanners.values()];
    this.scanners.clear();
    this.scannerSnapshots.clear();
    for (const pending of scanners) {
      try {
        const scanner = await pending;
        await scanner.close?.();
      } catch {}
    }
  }
  accelerationStatus() {
    if (!this.indexScannerFactory)
      return { mode: "javascript", state: "off" };
    const status = {
      mode: "wasm",
      state: this.accelerationState,
      metrics: { ...this.accelerationMetrics }
    };
    return this.accelerationError ? {
      ...status,
      reasonCode: this.accelerationReasonCode ?? "EWASM_INSTANTIATE",
      error: this.accelerationError
    } : status;
  }
  async disableAcceleration(error, defaultCode) {
    this.accelerationState = "fallback";
    this.accelerationError = error instanceof Error ? error.message : String(error);
    const code = error?.code;
    this.accelerationReasonCode = typeof code === "string" && code.startsWith("EWASM_") ? code : defaultCode;
    await this.close();
  }
  async scannerFor(collection) {
    if (!this.indexScannerFactory || this.accelerationState === "fallback")
      return null;
    if (this.accelerationState !== "active")
      await this.ready();
    if (this.accelerationState !== "active")
      return null;
    let scanner = this.scanners.get(collection);
    if (!scanner) {
      scanner = Promise.resolve(this.indexScannerFactory.create());
      this.scanners.set(collection, scanner);
    }
    try {
      return await scanner;
    } catch (error) {
      await this.disableAcceleration(error, "EWASM_INSTANTIATE");
      return null;
    }
  }
  async forgetCollection(collection) {
    this.snapshotCache.delete(collection);
    this.scannerSnapshots.delete(collection);
    this.walOverlayCache.delete(collection);
    const scanner = this.scanners.get(collection);
    this.scanners.delete(collection);
    if (!scanner)
      return;
    try {
      const instance = await scanner;
      await instance.close?.();
    } catch {}
  }
  root(collection) {
    return join(this.rootForCollection(collection), "index");
  }
  manifestPath(collection) {
    return join(this.root(collection), LOCAL_FS_MANIFEST);
  }
  snapshotPath(collection) {
    return join(this.root(collection), LOCAL_FS_SNAPSHOT);
  }
  walPath(collection) {
    return join(this.root(collection), LOCAL_FS_WAL);
  }
  async ensureCollection(collection) {
    await this.fs.mkdir(this.root(collection), { recursive: true });
    await writeIfMissing(this.fs, this.manifestPath(collection), `${JSON.stringify({ format: LOCAL_FS_FORMAT, createdAt: Date.now() })}
`);
    await writeIfMissing(this.fs, this.snapshotPath(collection), "");
    await writeIfMissing(this.fs, this.walPath(collection), "");
  }
  async resetCollection(collection) {
    await this.forgetCollection(collection);
    await this.fs.rmdir(this.root(collection), { recursive: true });
    await this.ensureCollection(collection);
  }
  async readSnapshotBytes(collection) {
    const cached = this.snapshotCache.get(collection);
    if (cached)
      return cached;
    const path = this.snapshotPath(collection);
    const startedAt = monotonicNow();
    const bytes = await this.fs.exists(path) ? await this.fs.readBytes(path) : new Uint8Array(0);
    this.accelerationMetrics.snapshotReads++;
    this.accelerationMetrics.snapshotReadMs += monotonicNow() - startedAt;
    this.accelerationMetrics.snapshotBytes += bytes.byteLength;
    this.snapshotCache.set(collection, bytes);
    return bytes;
  }
  findFirstKeyAtOrAfter(bytes, prefix) {
    if (bytes.length === 0)
      return 0;
    let lo = 0;
    let hi = bytes.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      let start = mid;
      while (start > 0 && bytes[start - 1] !== 10)
        start--;
      let end = mid;
      while (end < bytes.length && bytes[end] !== 10)
        end++;
      const key = DECODER.decode(bytes.subarray(start, end));
      if (key < prefix)
        lo = end + 1;
      else
        hi = start;
    }
    while (lo > 0 && lo < bytes.length && bytes[lo - 1] !== 10)
      lo--;
    return lo;
  }
  async loadKeySet(collection) {
    await this.ensureCollection(collection);
    const bytes = await this.readSnapshotBytes(collection);
    const keys = new Set(completeLines(DECODER.decode(bytes)));
    for (const line of completeLines(await readTextIfExists(this.fs, this.walPath(collection)))) {
      const mutation = parseWalMutation(line);
      if (!mutation)
        continue;
      if (mutation.op === "+")
        keys.add(mutation.key);
      else
        keys.delete(mutation.key);
    }
    return keys;
  }
  async appendMutations(collection, mutations) {
    if (mutations.length === 0)
      return;
    await this.ensureCollection(collection);
    await this.fs.appendText(this.walPath(collection), serializeWal(mutations));
    const overlay = this.walOverlayCache.get(collection);
    if (overlay) {
      for (const mutation of mutations) {
        if (mutation.op === "+") {
          overlay.added.add(mutation.key);
          overlay.removed.delete(mutation.key);
        } else {
          overlay.added.delete(mutation.key);
          overlay.removed.add(mutation.key);
        }
      }
    }
    await this.compactIfNeeded(collection);
  }
  async compactIfNeeded(collection) {
    if (!await this.fs.exists(this.walPath(collection)))
      return;
    const wal = await this.fs.readText(this.walPath(collection));
    if (ENCODER.encode(wal).byteLength < LOCAL_FS_WAL_COMPACT_BYTES)
      return;
    await this.compact(collection);
  }
  async compact(collection) {
    const keys = [...await this.loadKeySet(collection)].sort();
    await this.fs.writeText(this.snapshotPath(collection), serializeSnapshot(keys));
    await this.fs.writeText(this.walPath(collection), "");
    this.snapshotCache.delete(collection);
    this.scannerSnapshots.delete(collection);
    this.walOverlayCache.set(collection, { added: new Set, removed: new Set });
  }
  async putDocument(collection, docId, doc) {
    const keys = await BrowserPrefixIndexCodec.entriesForDocument(collection, docId, doc);
    await this.appendMutations(collection, keys.map((key) => ({ op: "+", key })));
  }
  async removeDocument(collection, docId, doc) {
    const keys = await BrowserPrefixIndexCodec.entriesForDocument(collection, docId, doc);
    await this.appendMutations(collection, keys.map((key) => ({ op: "-", key })));
  }
  async countDocuments(collection) {
    const docIds = new Set;
    for (const key of await this.loadKeySet(collection)) {
      const segments = key.split("/");
      if (segments.length < 2)
        continue;
      docIds.add(segments.at(-1));
    }
    return docIds.size;
  }
  async candidateDocIds(collection, fieldPath, operand) {
    const prefixes = await BrowserPrefixIndexCodec.queryPrefixes(collection, fieldPath, operand);
    if (!prefixes)
      return null;
    await this.ensureCollection(collection);
    const overlay = await this.loadWalOverlay(collection);
    const bytes = await this.readSnapshotBytes(collection);
    let candidates = null;
    for (const entry of prefixes) {
      const rootPrefix = BrowserPrefixIndexCodec.prefix(fieldPath, entry.kind);
      const fullPrefix = BrowserPrefixIndexCodec.prefix(fieldPath, entry.kind, entry.valuePrefix);
      const next = new Set;
      const scanner = await this.scannerFor(collection);
      if (scanner) {
        try {
          if (this.scannerSnapshots.get(collection) !== bytes) {
            const loadStartedAt = monotonicNow();
            await scanner.loadSnapshot(bytes);
            this.accelerationMetrics.snapshotLoads++;
            this.accelerationMetrics.snapshotLoadMs += monotonicNow() - loadStartedAt;
            this.scannerSnapshots.set(collection, bytes);
          }
          const scanStartedAt = monotonicNow();
          for (const encodedDocId of await scanner.scanQueries([
            { prefix: fullPrefix, range: entry.range }
          ])) {
            const docId = decodeSegment(encodedDocId);
            if (!TTID.isTTID(docId))
              throw new Error(`Invalid document ID: ${docId}`);
            next.add(docId);
          }
          this.accelerationMetrics.scans++;
          this.accelerationMetrics.scanMs += monotonicNow() - scanStartedAt;
        } catch (error) {
          await this.disableAcceleration(error, "EWASM_QUERY");
          next.clear();
          this.scanSnapshotWithJavaScript(bytes, fullPrefix, rootPrefix, entry.range, next);
        }
      } else {
        this.scanSnapshotWithJavaScript(bytes, fullPrefix, rootPrefix, entry.range, next);
      }
      for (const key of overlay.removed) {
        if (!key.startsWith(fullPrefix))
          continue;
        if (!includeKeyInRange(key, entry.range))
          continue;
        next.delete(docIdFromKey(rootPrefix, key));
      }
      for (const key of overlay.added) {
        if (!key.startsWith(fullPrefix))
          continue;
        if (!includeKeyInRange(key, entry.range))
          continue;
        next.add(docIdFromKey(rootPrefix, key));
      }
      candidates = intersect(candidates, next);
    }
    return candidates;
  }
  scanSnapshotWithJavaScript(bytes, fullPrefix, rootPrefix, range, target) {
    const offset = this.findFirstKeyAtOrAfter(bytes, fullPrefix);
    for (const key of streamKeysFrom(bytes, offset)) {
      if (!key.startsWith(fullPrefix))
        break;
      if (!includeKeyInRange(key, range))
        continue;
      target.add(docIdFromKey(rootPrefix, key));
    }
  }
  async loadWalOverlay(collection) {
    const cached = this.walOverlayCache.get(collection);
    if (cached)
      return cached;
    const added = new Set;
    const removed = new Set;
    const startedAt = monotonicNow();
    const wal = await readTextIfExists(this.fs, this.walPath(collection));
    this.accelerationMetrics.walReads++;
    this.accelerationMetrics.walReadMs += monotonicNow() - startedAt;
    this.accelerationMetrics.walBytes += ENCODER.encode(wal).byteLength;
    for (const line of completeLines(wal)) {
      const mutation = parseWalMutation(line);
      if (!mutation)
        continue;
      if (mutation.op === "+") {
        added.add(mutation.key);
        removed.delete(mutation.key);
      } else {
        added.delete(mutation.key);
        removed.add(mutation.key);
      }
    }
    const overlay = { added, removed };
    this.walOverlayCache.set(collection, overlay);
    return overlay;
  }
}
function monotonicNow() {
  return globalThis.performance?.now() ?? Date.now();
}
function* streamKeysFrom(bytes, offset) {
  let cursor = offset;
  while (cursor < bytes.length) {
    let end = cursor;
    while (end < bytes.length && bytes[end] !== 10)
      end++;
    const key = DECODER.decode(bytes.subarray(cursor, end));
    if (key.length > 0)
      yield key;
    cursor = end + 1;
  }
}
function intersect(current, next) {
  if (current === null)
    return next;
  const out = new Set;
  for (const value of next)
    if (current.has(value))
      out.add(value);
  return out;
}
function includeKeyInRange(key, range) {
  if (!range)
    return true;
  const value = BrowserPrefixIndexCodec.rangeValueFromKey(key);
  if (range.op === "$gt")
    return value > range.value;
  if (range.op === "$gte")
    return value >= range.value;
  if (range.op === "$lt")
    return value > range.value;
  if (range.op === "$lte")
    return value >= range.value;
  return true;
}

// src/query/like.js
function matchesLike(value, pattern, options = {}) {
  const singleCharacterWildcard = options.singleCharacterWildcard ?? true;
  let valueIndex = 0;
  let patternIndex = 0;
  let wildcardIndex = -1;
  let wildcardValueIndex = 0;
  while (valueIndex < value.length) {
    const token = pattern[patternIndex];
    if (singleCharacterWildcard && token === "_" || token === value[valueIndex]) {
      valueIndex++;
      patternIndex++;
      continue;
    }
    if (token === "%") {
      wildcardIndex = patternIndex++;
      wildcardValueIndex = valueIndex;
      continue;
    }
    if (wildcardIndex !== -1) {
      patternIndex = wildcardIndex + 1;
      valueIndex = ++wildcardValueIndex;
      continue;
    }
    return false;
  }
  while (pattern[patternIndex] === "%")
    patternIndex++;
  return patternIndex === pattern.length;
}

// src/browser/core/query.js
class BrowserQueryEngine {
  constructor(context) {
    this.context = context;
  }
  getValueByPath(target, fieldPath) {
    return fieldPath.replaceAll("/", ".").split(".").reduce((acc, key) => {
      if (acc === undefined || acc === null || typeof acc !== "object")
        return;
      return Object.hasOwn(acc, key) ? acc[key] : undefined;
    }, target);
  }
  normalizeFieldPath(fieldPath) {
    return fieldPath.replaceAll(".", "/");
  }
  matchesTimestamp(_docId, query, timestamps) {
    if (!query?.$created && !query?.$updated)
      return true;
    const match = (value, range) => {
      if (!range)
        return true;
      if (range.$gt !== undefined && !(value > range.$gt))
        return false;
      if (range.$gte !== undefined && !(value >= range.$gte))
        return false;
      if (range.$lt !== undefined && !(value < range.$lt))
        return false;
      if (range.$lte !== undefined && !(value <= range.$lte))
        return false;
      return true;
    };
    return match(timestamps.createdAt, query.$created) && match(timestamps.updatedAt, query.$updated);
  }
  matchesDeletedQuery(docId, doc, query, timestamps) {
    if (query?.$updated)
      throw new Error("Deleted document queries use $deleted instead of $updated");
    if (!this.matchesQuery(docId, doc, query, {
      ...timestamps,
      updatedAt: timestamps.deletedAt
    }))
      return false;
    const range = query?.$deleted;
    if (!range)
      return true;
    if (range.$gt !== undefined && !(timestamps.deletedAt > range.$gt))
      return false;
    if (range.$gte !== undefined && !(timestamps.deletedAt >= range.$gte))
      return false;
    if (range.$lt !== undefined && !(timestamps.deletedAt < range.$lt))
      return false;
    if (range.$lte !== undefined && !(timestamps.deletedAt <= range.$lte))
      return false;
    return true;
  }
  matchesOperand(value, operand) {
    const predicates = {
      $eq: (expected) => value == expected,
      $ne: (expected) => value != expected,
      $gt: (expected) => this.matchesNumber(value, "$gt", expected),
      $gte: (expected) => this.matchesNumber(value, "$gte", expected),
      $lt: (expected) => this.matchesNumber(value, "$lt", expected),
      $lte: (expected) => this.matchesNumber(value, "$lte", expected),
      $like: (expected) => typeof value === "string" && this.matchesLike(value, expected),
      $contains: (expected) => Array.isArray(value) && value.some((item) => item == expected)
    };
    const supplied = operand;
    for (const [operator, predicate] of Object.entries(predicates)) {
      if (supplied[operator] === undefined)
        continue;
      if (!predicate(supplied[operator]))
        return false;
    }
    return true;
  }
  matchesNumber(value, operator, expected) {
    const numeric = Number(value);
    if (operator === "$gt")
      return numeric > expected;
    if (operator === "$gte")
      return numeric >= expected;
    if (operator === "$lt")
      return numeric < expected;
    return numeric <= expected;
  }
  matchesLike(value, pattern) {
    return matchesLike(value, pattern);
  }
  intersectDocIds(current, next) {
    const nextSet = next instanceof Set ? next : new Set(next);
    if (current === null)
      return new Set(nextSet);
    const intersection = new Set;
    for (const docId of current) {
      if (nextSet.has(docId))
        intersection.add(docId);
    }
    return intersection;
  }
  async candidateDocIdsForOperand(collection, fieldPath, operand) {
    let candidateIds = null;
    if (operand.$eq !== undefined) {
      candidateIds = this.intersectDocIds(candidateIds, await this.context.index.candidateDocIds(collection, fieldPath, {
        $eq: operand.$eq
      }) ?? new Set);
    }
    if (operand.$gt !== undefined || operand.$gte !== undefined || operand.$lt !== undefined || operand.$lte !== undefined) {
      for (const key of ["$gt", "$gte", "$lt", "$lte"]) {
        if (operand[key] === undefined)
          continue;
        const rangeCandidates = await this.context.index.candidateDocIds(collection, fieldPath, { [key]: operand[key] });
        if (rangeCandidates === null)
          return null;
        candidateIds = this.intersectDocIds(candidateIds, rangeCandidates);
      }
    }
    if (operand.$like !== undefined) {
      const likeCandidates = await this.context.index.candidateDocIds(collection, fieldPath, {
        $like: operand.$like
      });
      if (likeCandidates === null)
        return null;
      candidateIds = this.intersectDocIds(candidateIds, likeCandidates);
    }
    if (operand.$contains !== undefined) {
      const containsCandidates = await this.context.index.candidateDocIds(collection, fieldPath, { $contains: operand.$contains });
      candidateIds = this.intersectDocIds(candidateIds, containsCandidates ?? new Set);
    }
    return candidateIds;
  }
  async candidateDocIdsForOperation(collection, operation) {
    let candidateIds = null;
    for (const [field, operand] of Object.entries(operation)) {
      if (!operand)
        continue;
      const fieldPath = this.normalizeFieldPath(String(field));
      const fieldCandidates = await this.candidateDocIdsForOperand(collection, fieldPath, operand);
      if (fieldCandidates === null)
        continue;
      candidateIds = this.intersectDocIds(candidateIds, fieldCandidates);
    }
    return candidateIds;
  }
  async candidateDocIdsForQuery(collection, query) {
    if (!query?.$ops || query.$ops.length === 0)
      return null;
    const union = new Set;
    let usedIndex = false;
    for (const operation of query.$ops) {
      const candidateIds = await this.candidateDocIdsForOperation(collection, operation);
      if (candidateIds === null)
        return null;
      usedIndex = true;
      for (const docId of candidateIds)
        union.add(docId);
    }
    return usedIndex ? union : null;
  }
  matchesQuery(docId, doc, query, timestamps) {
    if (!this.matchesTimestamp(docId, query, timestamps))
      return false;
    if (!query?.$ops || query.$ops.length === 0)
      return true;
    return query.$ops.some((operation) => {
      for (const field of Object.keys(operation)) {
        const value = this.getValueByPath(doc, field);
        const operand = operation[field];
        if (!operand || !this.matchesOperand(value, operand))
          return false;
      }
      return true;
    });
  }
  selectValues(selection, data) {
    const copy = copySafeRecord(data);
    for (const field of Object.keys(copy)) {
      if (!selection.includes(field))
        delete copy[field];
    }
    return copy;
  }
  renameFields(rename, data) {
    const copy = copySafeRecord(data);
    for (const field of Object.keys(copy)) {
      if (Object.hasOwn(rename, field) && typeof rename[field] === "string") {
        copy[rename[field]] = copy[field];
        delete copy[field];
      }
    }
    return copy;
  }
  processDoc(doc, query) {
    if (Object.keys(doc).length === 0)
      return;
    const next = copySafeRecord(doc);
    for (let [_id, data] of Object.entries(next)) {
      if (query?.$select?.length)
        data = this.selectValues(query.$select, data);
      if (query?.$rename)
        data = this.renameFields(query.$rename, data);
      next[_id] = data;
    }
    if (query?.$groupby) {
      const docGroup = safeRecord();
      for (const [id, data] of Object.entries(next)) {
        const groupValue = data[query.$groupby];
        if (groupValue !== undefined && groupValue !== null) {
          const groupData = copySafeRecord(data);
          delete groupData[query.$groupby];
          const group = safeRecord();
          group[id] = groupData;
          docGroup[String(groupValue)] = group;
        }
      }
      if (query.$onlyIds) {
        const groupedIds = safeRecord();
        for (const group of Object.keys(docGroup)) {
          groupedIds[group] = Object.keys(docGroup[group]);
        }
        return groupedIds;
      }
      return docGroup;
    }
    if (query?.$onlyIds)
      return Object.keys(next).shift();
    return next;
  }
}

// src/core/extensions.js
function appendGroup(target, source) {
  const result = copySafeRecord(target);
  for (const [sourceId, sourceGroup] of Object.entries(source)) {
    if (!Object.hasOwn(result, sourceId)) {
      result[sourceId] = sourceGroup && typeof sourceGroup === "object" && !Array.isArray(sourceGroup) ? copySafeRecord(sourceGroup) : sourceGroup;
      continue;
    }
    result[sourceId] = result[sourceId] && typeof result[sourceId] === "object" && !Array.isArray(result[sourceId]) ? copySafeRecord(result[sourceId]) : safeRecord();
    for (const [groupId, groupDoc] of Object.entries(sourceGroup)) {
      result[sourceId][groupId] = groupDoc;
    }
  }
  return result;
}
Object.assign(Object, { appendGroup });

// src/browser/core/engine.js
var JOIN_COMPARATORS = {
  $eq: (leftValue, rightValue) => leftValue === rightValue,
  $ne: (leftValue, rightValue) => leftValue !== rightValue,
  $gt: (leftValue, rightValue) => Number(leftValue) > Number(rightValue),
  $lt: (leftValue, rightValue) => Number(leftValue) < Number(rightValue),
  $gte: (leftValue, rightValue) => Number(leftValue) >= Number(rightValue),
  $lte: (leftValue, rightValue) => Number(leftValue) <= Number(rightValue)
};
var JOIN_MODES = {
  inner: (leftData, rightData) => Object.assign(safeRecord(), leftData, rightData),
  outer: (leftData, rightData) => Object.assign(safeRecord(), leftData, rightData),
  left: (leftData) => leftData,
  right: (leftData, rightData) => rightData
};
function groupJoinedDocs(join2, docs) {
  const groupedDocs = safeRecord();
  for (const ids of Object.keys(docs)) {
    const data = docs[ids];
    const key = String(data[join2.$groupby]);
    if (!Object.hasOwn(groupedDocs, key))
      groupedDocs[key] = safeRecord();
    groupedDocs[key][ids] = data;
  }
  if (!join2.$onlyIds)
    return groupedDocs;
  const groupedIds = safeRecord();
  for (const key of Object.keys(groupedDocs)) {
    groupedIds[key] = Object.keys(groupedDocs[key]).flat();
  }
  return groupedIds;
}
var BROWSER_OPERATION = Object.freeze({
  noop: 0,
  putInsert: 10,
  putUpdate: 11,
  delete: 20,
  restore: 30,
  errWormUpdate: 100,
  errWormDelete: 101,
  errWormRestore: 102,
  errSoftDeleted: 103,
  errRestoreActiveExists: 104,
  errRestoreMissingTombstone: 105
});
function clone(value) {
  return structuredClone(value);
}
function validateDocId(docId) {
  if (!TTID.isTTID(docId))
    throw new Error(`Invalid document ID: ${docId}`);
}
function explicitDocumentEntry(value) {
  const entries = Object.entries(value);
  if (entries.length !== 1)
    return null;
  const [candidate, doc] = entries[0];
  if (!TTID.isTTID(candidate))
    return null;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error("Explicit TTID document payload must be an object");
  }
  return [candidate, doc];
}

class BrowserCore {
  planner = new FyloQueryPlanner;
  constructor(options) {
    this.fs = options.fs;
    this.root = options.root ?? "/";
    this.wormMode = options.worm?.mode ?? "off";
    this.writeLanes = new Map;
    this.index = new BrowserPrefixIndex(this.fs, this.collectionRoot.bind(this), {
      indexScannerFactory: options.indexScannerFactory
    });
    this.events = new BrowserEventBus(this.fs, this.collectionRoot.bind(this));
    this.documents = new BrowserDocuments(this.fs, this.docsRoot.bind(this), this.docPath.bind(this), this.deletedRoot.bind(this), this.deletedPath.bind(this), this.ensureCollection.bind(this));
    this.metadata = new BrowserMetadataStore(this.fs, this.collectionRoot.bind(this));
    this.queryEngine = new BrowserQueryEngine({ index: this.index });
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol")
          return Reflect.get(target, prop, receiver);
        if (prop in target || typeof target[prop] === "function")
          return Reflect.get(target, prop, receiver);
        return new BrowserCollectionFacade(target, prop);
      }
    });
  }
  async ready() {
    await this.index.ready();
  }
  async close() {
    await this.index.close();
  }
  wormEnabled() {
    return this.wormMode === "strict";
  }
  assertCollectionName(collection) {
    validateCollectionName(collection);
  }
  collectionRoot(collection) {
    this.assertCollectionName(collection);
    return join(this.root, ".collections", collection);
  }
  docsRoot(collection) {
    return join(this.collectionRoot(collection), "docs");
  }
  deletedRoot(collection) {
    return join(this.collectionRoot(collection), ".deleted");
  }
  metaRoot(collection) {
    return this.collectionRoot(collection);
  }
  docPath(collection, docId) {
    validateDocId(docId);
    const root = this.docsRoot(collection);
    const target = join(root, shardOf(docId), `${docId}.json`);
    assertPathInside(root, target);
    return target;
  }
  deletedPath(collection, docId) {
    validateDocId(docId);
    const root = this.deletedRoot(collection);
    const target = join(root, shardOf(docId), `${docId}.json`);
    assertPathInside(root, target);
    return target;
  }
  async withCollectionWriteLane(collection, action) {
    return await runInLane(this.writeLanes, collection, action);
  }
  async ensureCollection(collection) {
    this.assertCollectionName(collection);
    await this.fs.mkdir(this.collectionRoot(collection), { recursive: true });
    await this.fs.mkdir(this.docsRoot(collection), { recursive: true });
    await this.fs.mkdir(this.deletedRoot(collection), { recursive: true });
    await this.fs.mkdir(this.metadata.root(collection), { recursive: true });
    await this.fs.mkdir(join(this.collectionRoot(collection), "events"), { recursive: true });
    await this.index.ensureCollection(collection);
  }
  async createCollection(collection) {
    await this.ensureCollection(collection);
  }
  async requireCollection(collection) {
    if (!await this.hasCollection(collection))
      throw new CollectionNotFoundError(collection);
  }
  async dropCollection(collection) {
    this.assertCollectionName(collection);
    await this.requireCollection(collection);
    if (this.wormEnabled() && (await this.documents.listDocIds(collection)).length > 0) {
      throw new Error("Drop is not allowed for a non-empty WORM collection");
    }
    await this.index.forgetCollection(collection);
    await this.fs.rmdir(this.collectionRoot(collection), { recursive: true });
  }
  async hasCollection(collection) {
    return await this.fs.exists(this.collectionRoot(collection));
  }
  async inspectCollection(collection) {
    const exists = await this.hasCollection(collection);
    if (!exists) {
      return {
        collection,
        exists: false,
        worm: false,
        docsStored: 0,
        deletedDocs: 0,
        indexedDocs: 0,
        indexAcceleration: this.index.accelerationStatus()
      };
    }
    const [docIds, deletedDocIds, indexedDocs] = await Promise.all([
      this.documents.listDocIds(collection),
      this.documents.listDeletedDocIds(collection),
      this.index.countDocuments(collection)
    ]);
    return {
      collection,
      exists: true,
      worm: this.wormEnabled(),
      docsStored: docIds.length,
      deletedDocs: deletedDocIds.length,
      indexedDocs,
      indexAcceleration: this.index.accelerationStatus()
    };
  }
  async rebuildCollection(collection) {
    await this.requireCollection(collection);
    return await this.withCollectionWriteLane(collection, async () => {
      await this.ensureCollection(collection);
      const docIds = await this.documents.listDocIds(collection);
      let indexedDocs = 0;
      await this.index.resetCollection(collection);
      for (const docId of docIds) {
        const stored = await this.documents.readStoredDoc(collection, docId);
        if (!stored)
          continue;
        await this.index.putDocument(collection, docId, stored.data);
        indexedDocs++;
      }
      return {
        collection,
        worm: this.wormEnabled(),
        docsScanned: docIds.length,
        indexedDocs
      };
    });
  }
  async putData(collection, data, meta) {
    if (meta !== undefined)
      validateMetadataRecord(meta);
    await this.requireCollection(collection);
    const explicit = explicitDocumentEntry(data);
    const id = explicit?.[0] ?? TTID.generate();
    const doc = clone(explicit?.[1] ?? data);
    validateDocId(id);
    return await this.withCollectionWriteLane(collection, async () => {
      await this.ensureCollection(collection);
      const [deleted, existing] = await Promise.all([
        this.documents.readDeletedDoc(collection, id),
        this.documents.readStoredDoc(collection, id)
      ]);
      const operation = planPutOperation({
        existing: Boolean(existing),
        worm: this.wormEnabled(),
        deleted: Boolean(deleted)
      });
      if (operation === BROWSER_OPERATION.errSoftDeleted) {
        throw new Error(`Document is soft-deleted; restore it before writing: ${id}`);
      }
      if (operation === BROWSER_OPERATION.errWormUpdate) {
        throw new Error("Update is not allowed in WORM mode");
      }
      if (operation === BROWSER_OPERATION.putUpdate && existing) {
        await this.index.removeDocument(collection, id, existing.data);
      }
      await this.documents.writeStoredDoc(collection, id, doc);
      try {
        if (meta !== undefined)
          await this.metadata.mutate(collection, id, meta);
      } catch (error) {
        if (existing) {
          await this.documents.writeStoredDoc(collection, id, existing.data);
          await this.index.putDocument(collection, id, existing.data);
        } else {
          await this.documents.removeStoredDoc(collection, id);
        }
        throw error;
      }
      await this.index.putDocument(collection, id, doc);
      if (this.wormEnabled())
        await this.documents.makeStoredDocReadOnly(collection, id);
      const stored = await this.documents.readStoredDoc(collection, id);
      await this.events.publish(collection, {
        ts: stored?.updatedAt ?? Date.now(),
        action: "insert",
        id,
        doc: clone(doc)
      });
      return id;
    });
  }
  async batchPutData(collection, batch) {
    const ids = [];
    for (const data of batch)
      ids.push(await this.putData(collection, data));
    return ids;
  }
  async getDocMeta(collection, id) {
    validateDocId(id);
    await this.requireCollection(collection);
    const stored = await this.documents.readStoredDoc(collection, id);
    if (!stored) {
      throw new Error(`Document not found: ${id}`);
    }
    const metadata = copySafeJson((await this.metadata.read(collection, id)).values);
    metadata.id = stored.id;
    metadata.mtime = stored.updatedAt;
    metadata.updatedAt = stored.updatedAt;
    metadata.createdAt = stored.createdAt;
    return metadata;
  }
  async setDocMetaRecord(collection, id, record) {
    validateDocId(id);
    await this.requireCollection(collection);
    return await this.withCollectionWriteLane(collection, async () => {
      if (!await this.documents.readStoredDoc(collection, id)) {
        throw new Error(`Document not found: ${id}`);
      }
      const result = await this.metadata.mutate(collection, id, record);
      await this.events.publish(collection, {
        ts: result.updatedAt,
        action: "meta",
        id,
        meta: copySafeJson(result.values)
      });
      return copySafeJson(result.values);
    });
  }
  async patchDoc(collection, newDoc, oldDoc = {}) {
    if (this.wormEnabled())
      throw new Error("Update is not allowed in WORM mode");
    await this.requireCollection(collection);
    const id = Object.keys(newDoc).shift();
    if (!id)
      throw new Error("this document does not contain an TTID");
    validateDocId(id);
    const stored = await this.documents.readStoredDoc(collection, id);
    const previous = oldDoc[id] ?? stored?.data;
    if (!stored || !previous)
      return id;
    return await this.putData(collection, { [id]: { ...previous, ...newDoc[id] } });
  }
  async patchDocs(collection, update) {
    let count = 0;
    for await (const value of this.findDocs(collection, update.$where ?? {}).collect()) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        continue;
      const [id, current] = Object.entries(value)[0] ?? [];
      if (!id || !current)
        continue;
      await this.patchDoc(collection, { [id]: update.$set }, { [id]: current });
      count++;
    }
    return count;
  }
  async delDoc(collection, id) {
    validateDocId(id);
    await this.requireCollection(collection);
    await this.withCollectionWriteLane(collection, async () => {
      const stored = await this.documents.readStoredDoc(collection, id);
      const operation = planDeleteOperation({
        existing: Boolean(stored),
        worm: this.wormEnabled()
      });
      if (operation === BROWSER_OPERATION.errWormDelete) {
        throw new Error("Delete is not allowed in WORM mode");
      }
      if (operation === BROWSER_OPERATION.noop || !stored)
        return;
      await this.index.removeDocument(collection, id, stored.data);
      const deletedAt = Date.now();
      await this.documents.softDeleteStoredDoc(collection, id, deletedAt);
      await this.events.publish(collection, {
        ts: deletedAt,
        action: "delete",
        id,
        doc: clone(stored.data),
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt
      });
    });
  }
  async restoreDoc(collection, id) {
    validateDocId(id);
    await this.requireCollection(collection);
    return await this.withCollectionWriteLane(collection, async () => {
      const [active, deleted] = await Promise.all([
        this.documents.readStoredDoc(collection, id),
        this.documents.readDeletedDoc(collection, id)
      ]);
      const operation = planRestoreOperation({
        activeExists: Boolean(active),
        deletedExists: Boolean(deleted),
        worm: this.wormEnabled()
      });
      if (operation === BROWSER_OPERATION.errWormRestore) {
        throw new Error("Restore is not allowed in WORM mode");
      }
      if (operation === BROWSER_OPERATION.errRestoreActiveExists) {
        throw new Error(`Cannot restore document because it already exists: ${id}`);
      }
      if (operation === BROWSER_OPERATION.errRestoreMissingTombstone || !deleted) {
        throw new Error(`Deleted document not found: ${id}`);
      }
      await this.documents.restoreStoredDoc(collection, id, Date.now());
      await this.index.putDocument(collection, id, deleted.data);
      const stored = await this.documents.readStoredDoc(collection, id);
      await this.events.publish(collection, {
        ts: stored?.updatedAt ?? Date.now(),
        action: "insert",
        id,
        doc: clone(deleted.data)
      });
      return id;
    });
  }
  async delDocs(collection, deleteSchema) {
    let count = 0;
    for await (const value of this.findDocs(collection, deleteSchema).collect()) {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        continue;
      const id = Object.keys(value).find((docId) => TTID.isTTID(docId));
      if (!id)
        continue;
      await this.delDoc(collection, id);
      count++;
    }
    return count;
  }
  async listQueryableDocIds(collection) {
    await this.requireCollection(collection);
    return await this.documents.listDocIds(collection);
  }
  async docResults(collection, query = {}) {
    await this.requireCollection(collection);
    const candidateIds = await this.queryEngine.candidateDocIdsForQuery(collection, query);
    const ids = candidateIds ? Array.from(candidateIds) : await this.listQueryableDocIds(collection);
    const limit = query.$limit;
    const results = [];
    for (const id of ids) {
      const stored = await this.documents.readStoredDoc(collection, id);
      if (!stored)
        continue;
      if (!this.queryEngine.matchesQuery(id, stored.data, query, stored))
        continue;
      results.push({ [id]: clone(stored.data) });
      if (limit && results.length >= limit)
        break;
    }
    return results;
  }
  async deletedDocResults(collection, query = {}) {
    await this.requireCollection(collection);
    const ids = await this.documents.listDeletedDocIds(collection);
    const limit = query.$limit;
    const results = [];
    for (const id of ids) {
      const deleted = await this.documents.readDeletedDoc(collection, id);
      if (!deleted)
        continue;
      if (!this.queryEngine.matchesDeletedQuery(id, deleted.data, query, deleted))
        continue;
      results.push({ [id]: clone(deleted.data) });
      if (limit && results.length >= limit)
        break;
    }
    return results;
  }
  getDoc(collection, id, onlyId = false) {
    validateDocId(id);
    const core = this;
    return {
      async* [Symbol.asyncIterator]() {
        const doc = await this.once();
        if (doc && (typeof doc === "string" || Object.keys(doc).length > 0))
          yield doc;
        for await (const event of core.events.listen(collection)) {
          if (event.action !== "insert" || event.id !== id || !event.doc)
            continue;
          yield onlyId ? event.id : { [event.id]: clone(event.doc) };
        }
      },
      async once() {
        await core.requireCollection(collection);
        const stored = await core.documents.readStoredDoc(collection, id);
        if (!stored)
          return onlyId ? null : {};
        return onlyId ? stored.id : { [stored.id]: clone(stored.data) };
      },
      async* onDelete() {
        await core.requireCollection(collection);
        for await (const event of core.events.listen(collection)) {
          if (event.action === "delete" && event.id === id)
            yield event.id;
        }
      }
    };
  }
  async getLatest(collection, id, onlyId = false) {
    validateDocId(id);
    await this.requireCollection(collection);
    const stored = await this.documents.readStoredDoc(collection, id);
    if (!stored)
      return onlyId ? null : {};
    return onlyId ? stored.id : { [stored.id]: clone(stored.data) };
  }
  findDocs(collection, query = {}) {
    const core = this;
    const collectDocs = async function* () {
      const docs = await core.docResults(collection, query);
      for (const doc of docs) {
        const result = core.queryEngine.processDoc(doc, query);
        if (result !== undefined)
          yield result;
      }
    };
    return {
      async* [Symbol.asyncIterator]() {
        yield* collectDocs();
        for await (const event of core.events.listen(collection)) {
          if (event.action !== "insert" || !event.doc)
            continue;
          const stored = await core.documents.readStoredDoc(collection, event.id);
          if (!stored || !core.queryEngine.matchesQuery(event.id, event.doc, query, stored))
            continue;
          const processed = core.queryEngine.processDoc({ [event.id]: event.doc }, query);
          if (processed !== undefined)
            yield processed;
        }
      },
      async* collect() {
        yield* collectDocs();
      },
      async* onDelete() {
        await core.requireCollection(collection);
        for await (const event of core.events.listen(collection)) {
          if (event.action !== "delete" || !event.doc)
            continue;
          if (!core.queryEngine.matchesQuery(event.id, event.doc, query, {
            createdAt: event.createdAt ?? event.ts,
            updatedAt: event.updatedAt ?? event.ts
          }))
            continue;
          yield event.id;
        }
      }
    };
  }
  findDeletedDocs(collection, query = {}) {
    const core = this;
    const collectDocs = async function* () {
      const docs = await core.deletedDocResults(collection, query);
      for (const doc of docs) {
        const result = core.queryEngine.processDoc(doc, query);
        if (result !== undefined)
          yield result;
      }
    };
    return {
      async* [Symbol.asyncIterator]() {
        yield* collectDocs();
      },
      async* collect() {
        yield* collectDocs();
      }
    };
  }
  subscribe(collection, listener) {
    this.assertCollectionName(collection);
    return this.events.subscribe(collection, listener);
  }
  async join(join2) {
    const leftDocs = await this.docResults(join2.$leftCollection);
    const rightDocs = await this.docResults(join2.$rightCollection);
    const docs = safeRecord();
    for (const leftEntry of leftDocs) {
      const [leftId, leftData] = Object.entries(leftEntry)[0];
      for (const rightEntry of rightDocs) {
        const [rightId, rightData] = Object.entries(rightEntry)[0];
        if (!this.joinRowMatches(join2, leftData, rightData))
          continue;
        docs[`${leftId}, ${rightId}`] = this.projectJoinRow(join2, leftData, rightData);
        if (join2.$limit && Object.keys(docs).length >= join2.$limit)
          break;
      }
      if (join2.$limit && Object.keys(docs).length >= join2.$limit)
        break;
    }
    if (join2.$groupby)
      return groupJoinedDocs(join2, docs);
    if (join2.$onlyIds)
      return Array.from(new Set(Object.keys(docs).flat()));
    return docs;
  }
  joinRowMatches(join2, leftData, rightData) {
    for (const [field, operand] of Object.entries(join2.$on)) {
      if (!operand)
        continue;
      for (const opKey of Object.keys(JOIN_COMPARATORS)) {
        const rightField = operand[opKey];
        if (!rightField)
          continue;
        const leftValue = this.queryEngine.getValueByPath(leftData, String(field));
        const rightValue = this.queryEngine.getValueByPath(rightData, String(rightField));
        if (JOIN_COMPARATORS[opKey](leftValue, rightValue))
          return true;
      }
    }
    return false;
  }
  projectJoinRow(join2, leftData, rightData) {
    const combine = JOIN_MODES[join2.$mode];
    let projected = combine ? combine(leftData, rightData) : undefined;
    if (join2.$select?.length)
      projected = this.queryEngine.selectValues(join2.$select, projected);
    if (join2.$rename)
      projected = this.queryEngine.renameFields(join2.$rename, projected);
    return projected;
  }
  async executeSQL(SQL) {
    const plan = this.planner.prepare(SQL);
    if (plan.explain && !plan.analyze)
      return this.planner.describe(plan);
    const startedAt = performance.now();
    const result = await this.executeSqlPlan(plan);
    if (!plan.explain)
      return result;
    return {
      ...this.planner.describe(plan),
      executed: true,
      elapsedMs: performance.now() - startedAt,
      result
    };
  }
  async executeSqlPlan(plan) {
    const operation = plan.operation;
    const parsed = structuredClone(plan.ast);
    switch (operation) {
      case "CREATE":
        return await this.createCollection(String(parsed.$collection));
      case "DROP":
        return await this.dropCollection(String(parsed.$collection));
      case "SELECT": {
        const query = parsed;
        if (plan.sql.includes("JOIN"))
          return await this.join(query);
        const selectedCollection = query.$collection;
        delete query.$collection;
        let docs = query.$onlyIds ? [] : {};
        for await (const data of this.findDocs(String(selectedCollection), query).collect()) {
          if (typeof data === "object" && data !== null) {
            docs = Object.appendGroup(docs, data);
          } else if (Array.isArray(docs))
            docs.push(String(data));
        }
        return docs;
      }
      case "INSERT": {
        const insert = parsed;
        const insertCollection = insert.$collection;
        delete insert.$collection;
        return await this.putData(String(insertCollection), insert.$values);
      }
      case "UPDATE": {
        const update = parsed;
        const updateCol = update.$collection;
        delete update.$collection;
        return await this.patchDocs(String(updateCol), update);
      }
      case "DELETE": {
        const del = parsed;
        const deleteCollection = del.$collection;
        delete del.$collection;
        return await this.delDocs(String(deleteCollection), del);
      }
      default:
        throw new Error("Invalid Operation");
    }
  }
}
function planPutOperation(options) {
  if (options.deleted)
    return BROWSER_OPERATION.errSoftDeleted;
  if (options.worm && options.existing)
    return BROWSER_OPERATION.errWormUpdate;
  return options.existing ? BROWSER_OPERATION.putUpdate : BROWSER_OPERATION.putInsert;
}
function planDeleteOperation(options) {
  if (options.worm)
    return BROWSER_OPERATION.errWormDelete;
  return options.existing ? BROWSER_OPERATION.delete : BROWSER_OPERATION.noop;
}
function planRestoreOperation(options) {
  if (options.worm)
    return BROWSER_OPERATION.errWormRestore;
  if (options.activeExists)
    return BROWSER_OPERATION.errRestoreActiveExists;
  if (!options.deletedExists)
    return BROWSER_OPERATION.errRestoreMissingTombstone;
  return BROWSER_OPERATION.restore;
}

class BrowserCollectionFacade {
  constructor(core, collection) {
    this.core = core;
    this.collection = collection;
  }
  async create() {
    await this.core.createCollection(this.collection);
  }
  async drop() {
    await this.core.dropCollection(this.collection);
  }
  async inspect() {
    return await this.core.inspectCollection(this.collection);
  }
  async rebuild() {
    return await this.core.rebuildCollection(this.collection);
  }
  async put(data) {
    return await this.core.putData(this.collection, data);
  }
  async batchPut(batch) {
    return await this.core.batchPutData(this.collection, batch);
  }
  async patch(id, patch, oldDoc) {
    return await this.core.patchDoc(this.collection, { [id]: patch }, oldDoc ?? {});
  }
  async patchMany(update) {
    return await this.core.patchDocs(this.collection, update);
  }
  async delete(id) {
    await this.core.delDoc(this.collection, id);
  }
  async deleteMany(query) {
    return await this.core.delDocs(this.collection, query);
  }
  async restore(id) {
    return await this.core.restoreDoc(this.collection, id);
  }
  get(id, onlyId) {
    return this.core.getDoc(this.collection, id, onlyId);
  }
  async latest(id, onlyId) {
    return await this.core.getLatest(this.collection, id, onlyId);
  }
  find(query) {
    return this.core.findDocs(this.collection, query ?? {});
  }
  findDeleted(query) {
    return this.core.deletedDocResults(this.collection, query ?? {});
  }
}

// src/browser/core/protocol.js
var FYLO_BROWSER_PROTOCOL_VERSION = 1;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(request, field) {
  const value = request[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`FYLO browser request field "${String(field)}" must be a non-empty string`);
  }
  return value;
}
function requireObject(request, field) {
  const value = request[field];
  if (!isRecord(value)) {
    throw new Error(`FYLO browser request field "${String(field)}" must be an object`);
  }
  return value;
}
function requireObjectArray(request, field) {
  const value = request[field];
  if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
    throw new Error(`FYLO browser request field "${String(field)}" must be an array of objects`);
  }
  return value;
}
function isBrowserRequest(value) {
  return isRecord(value) && typeof value.op === "string";
}
async function collectFindDocs(fylo, collection, query) {
  let docs = query.$onlyIds ? [] : safeRecord();
  for await (const value of fylo.findDocs(collection, query).collect()) {
    if (value === undefined)
      continue;
    if (typeof value === "object" && value !== null) {
      docs = Object.appendGroup(docs, value);
      continue;
    }
    if (Array.isArray(docs))
      docs.push(String(value));
  }
  return docs;
}
async function collectDeletedDocs(fylo, collection, query) {
  let docs = query.$onlyIds ? [] : safeRecord();
  for await (const value of fylo.findDeletedDocs(collection, query).collect()) {
    if (value === undefined)
      continue;
    if (typeof value === "object" && value !== null) {
      docs = Object.appendGroup(docs, value);
      continue;
    }
    if (Array.isArray(docs))
      docs.push(String(value));
  }
  return docs;
}
var BROWSER_OPERATIONS = {
  executeSQL: (fylo, request) => fylo.executeSQL(requireString(request, "sql")),
  createCollection: async (fylo, request) => {
    const collection = requireString(request, "collection");
    await fylo.createCollection(collection);
    return { collection };
  },
  dropCollection: async (fylo, request) => {
    const collection = requireString(request, "collection");
    await fylo.dropCollection(collection);
    return { collection };
  },
  inspectCollection: (fylo, request) => fylo.inspectCollection(requireString(request, "collection")),
  rebuildCollection: (fylo, request) => fylo.rebuildCollection(requireString(request, "collection")),
  getDoc: (fylo, request) => fylo.getDoc(requireString(request, "collection"), requireString(request, "id"), request.onlyId === true).once(),
  getLatest: (fylo, request) => fylo.getLatest(requireString(request, "collection"), requireString(request, "id"), request.onlyId === true),
  getMeta: (fylo, request) => fylo.getDocMeta(requireString(request, "collection"), requireString(request, "id")),
  setMeta: (fylo, request) => fylo.setDocMetaRecord(requireString(request, "collection"), requireString(request, "id"), requireObject(request, "meta")),
  findDocs: (fylo, request) => collectFindDocs(fylo, requireString(request, "collection"), isRecord(request.query) ? request.query : {}),
  findDeletedDocs: (fylo, request) => collectDeletedDocs(fylo, requireString(request, "collection"), isRecord(request.query) ? request.query : {}),
  joinDocs: (fylo, request) => fylo.join(requireObject(request, "join")),
  putData: (fylo, request) => {
    const hasMeta = Object.hasOwn(request, "meta");
    return fylo.putData(requireString(request, "collection"), requireObject(request, "data"), hasMeta ? requireObject(request, "meta") : undefined, hasMeta);
  },
  batchPutData: (fylo, request) => fylo.batchPutData(requireString(request, "collection"), requireObjectArray(request, "batch")),
  patchDoc: (fylo, request) => fylo.patchDoc(requireString(request, "collection"), requireObject(request, "newDoc"), isRecord(request.oldDoc) ? request.oldDoc : {}),
  patchDocs: (fylo, request) => fylo.patchDocs(requireString(request, "collection"), requireObject(request, "update")),
  delDoc: async (fylo, request) => {
    await fylo.delDoc(requireString(request, "collection"), requireString(request, "id"));
    return { deleted: true };
  },
  restoreDoc: async (fylo, request) => {
    const id = await fylo.restoreDoc(requireString(request, "collection"), requireString(request, "id"));
    return { restored: true, id };
  },
  delDocs: (fylo, request) => fylo.delDocs(requireString(request, "collection"), requireObject(request, "delete"))
};
async function executeBrowserOperation(fylo, request) {
  if (!isBrowserRequest(request))
    throw new Error("FYLO browser request body must be an object");
  const operation = BROWSER_OPERATIONS[request.op];
  if (!operation)
    throw new Error(`Unsupported FYLO browser operation: ${request.op}`);
  return await operation(fylo, request);
}
async function runBrowserRequest(fylo, request) {
  const startedAt = Date.now();
  const safeRequest = isRecord(request) ? request : {};
  try {
    const result = await executeBrowserOperation(fylo, request);
    return {
      protocolVersion: FYLO_BROWSER_PROTOCOL_VERSION,
      ok: true,
      op: safeRequest.op,
      requestId: typeof safeRequest.requestId === "string" ? safeRequest.requestId : null,
      durationMs: Date.now() - startedAt,
      result
    };
  } catch (error) {
    const failure = error;
    return {
      protocolVersion: FYLO_BROWSER_PROTOCOL_VERSION,
      ok: false,
      op: typeof safeRequest.op === "string" ? safeRequest.op : null,
      requestId: typeof safeRequest.requestId === "string" ? safeRequest.requestId : null,
      durationMs: Date.now() - startedAt,
      error: {
        name: failure.name || "Error",
        message: failure.message || "Unknown error",
        ...typeof failure.code === "string" ? { code: failure.code } : {}
      }
    };
  }
}

// src/browser/core/memory-filesystem.js
var ENCODER2 = new TextEncoder;
var DECODER2 = new TextDecoder;

class MemoryFilesystemError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "MemoryFilesystemError";
  }
}
function notFound(path) {
  return new MemoryFilesystemError("ENOENT", `No such file or directory: ${path}`);
}
function notDirectory(path) {
  return new MemoryFilesystemError("ENOTDIR", `Not a directory: ${path}`);
}

class MemoryFilesystem {
  constructor() {
    this.files = new Map;
    this.mtimes = new Map;
    this.dirs = new Set(["/"]);
    this.mtimes.set("/", Date.now());
  }
  key(path) {
    const normalised = normalize(path);
    if (!normalised.startsWith("/"))
      return `/${normalised === "." ? "" : normalised}`;
    return normalised;
  }
  async exists(path) {
    const key = this.key(path);
    return this.files.has(key) || this.dirs.has(key);
  }
  async isDirectory(path) {
    return this.dirs.has(this.key(path));
  }
  async mtimeMs(path) {
    const key = this.key(path);
    if (!this.files.has(key) && !this.dirs.has(key))
      throw notFound(path);
    return this.mtimes.get(key) ?? 0;
  }
  async mkdir(path, options = {}) {
    const key = this.key(path);
    if (this.files.has(key))
      throw notDirectory(path);
    if (this.dirs.has(key))
      return;
    if (options.recursive) {
      const segments = key.split("/").filter((segment) => segment.length > 0);
      let cursor = "";
      for (const segment of segments) {
        cursor += `/${segment}`;
        if (this.files.has(cursor))
          throw notDirectory(cursor);
        this.dirs.add(cursor);
        this.mtimes.set(cursor, Date.now());
      }
      return;
    }
    const parent = dirname(key);
    if (!this.dirs.has(parent))
      throw notFound(parent);
    this.dirs.add(key);
    this.mtimes.set(key, Date.now());
  }
  async list(path) {
    const key = this.key(path);
    if (!this.dirs.has(key))
      throw notFound(path);
    const prefix = key === "/" ? "/" : `${key}/`;
    const names = new Set;
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix))
        continue;
      const remainder = file.slice(prefix.length);
      const slash = remainder.indexOf("/");
      names.add(slash === -1 ? remainder : remainder.slice(0, slash));
    }
    for (const dir of this.dirs) {
      if (dir === key)
        continue;
      if (!dir.startsWith(prefix))
        continue;
      const remainder = dir.slice(prefix.length);
      const slash = remainder.indexOf("/");
      names.add(slash === -1 ? remainder : remainder.slice(0, slash));
    }
    return [...names].sort();
  }
  removeSubtree(key) {
    const prefix = key === "/" ? "/" : `${key}/`;
    const covered = (entry) => entry === key || entry.startsWith(prefix);
    for (const file of [...this.files.keys()]) {
      if (!covered(file))
        continue;
      this.files.delete(file);
      this.mtimes.delete(file);
    }
    for (const dir of [...this.dirs]) {
      if (!covered(dir))
        continue;
      this.dirs.delete(dir);
      this.mtimes.delete(dir);
    }
    this.dirs.add("/");
    this.mtimes.set("/", Date.now());
  }
  async rmdir(path, options = {}) {
    const key = this.key(path);
    if (!this.dirs.has(key)) {
      if (this.files.has(key))
        throw notDirectory(path);
      return;
    }
    if (options.recursive)
      return this.removeSubtree(key);
    const children = await this.list(path);
    if (children.length > 0) {
      throw new MemoryFilesystemError("ENOTEMPTY", `Directory not empty: ${path}`);
    }
    if (key !== "/") {
      this.dirs.delete(key);
      this.mtimes.delete(key);
    }
  }
  async readText(path) {
    return DECODER2.decode(await this.readBytes(path));
  }
  async readBytes(path) {
    const key = this.key(path);
    const bytes = this.files.get(key);
    if (!bytes)
      throw notFound(path);
    return new Uint8Array(bytes);
  }
  async size(path) {
    const key = this.key(path);
    const bytes = this.files.get(key);
    if (!bytes)
      throw notFound(path);
    return bytes.byteLength;
  }
  ensureParents(key) {
    const parent = dirname(key);
    if (this.files.has(parent))
      throw notDirectory(parent);
    if (this.dirs.has(parent))
      return;
    const segments = parent.split("/").filter((segment) => segment.length > 0);
    let cursor = "";
    for (const segment of segments) {
      cursor += `/${segment}`;
      if (this.files.has(cursor))
        throw notDirectory(cursor);
      this.dirs.add(cursor);
      this.mtimes.set(cursor, Date.now());
    }
  }
  async writeText(path, data) {
    await this.writeBytes(path, ENCODER2.encode(data));
  }
  async writeBytes(path, data) {
    const key = this.key(path);
    if (this.dirs.has(key))
      throw notDirectory(path);
    this.ensureParents(key);
    this.files.set(key, new Uint8Array(data));
    this.mtimes.set(key, Date.now());
  }
  async appendText(path, data) {
    const key = this.key(path);
    if (this.dirs.has(key))
      throw notDirectory(path);
    this.ensureParents(key);
    const existing = this.files.get(key) ?? new Uint8Array(0);
    const addition = ENCODER2.encode(data);
    const merged = new Uint8Array(existing.byteLength + addition.byteLength);
    merged.set(existing, 0);
    merged.set(addition, existing.byteLength);
    this.files.set(key, merged);
    this.mtimes.set(key, Date.now());
  }
  async remove(path) {
    const key = this.key(path);
    if (this.files.has(key)) {
      this.files.delete(key);
      this.mtimes.delete(key);
      return;
    }
    if (this.dirs.has(key))
      throw new MemoryFilesystemError("EISDIR", `Is a directory: ${path}`);
  }
  async move(source, target) {
    const sourceKey = this.key(source);
    const data = this.files.get(sourceKey);
    if (!data)
      throw notFound(source);
    const targetKey = this.key(target);
    if (this.dirs.has(targetKey))
      throw notDirectory(target);
    this.ensureParents(targetKey);
    this.files.set(targetKey, data);
    this.mtimes.set(targetKey, Date.now());
    this.files.delete(sourceKey);
    this.mtimes.delete(sourceKey);
  }
  async withSession(_path, body) {
    return await body();
  }
}
function createMemoryFilesystem(seed = {}) {
  const fs = new MemoryFilesystem;
  for (const [path, data] of Object.entries(seed)) {
    const key = fs.key(path);
    fs.ensureParents(key);
    fs.files.set(key, ENCODER2.encode(data));
    fs.mtimes.set(key, Date.now());
  }
  return fs;
}

// src/browser/opfs-filesystem.js
var ENCODER3 = new TextEncoder;
var DECODER3 = new TextDecoder;
function hasOpfs(navigatorLike) {
  return typeof navigatorLike === "object" && navigatorLike !== null && "storage" in navigatorLike && typeof navigatorLike.storage?.getDirectory === "function";
}
function isNotFound(error) {
  return error?.name === "NotFoundError";
}

class OpfsFilesystem {
  constructor(options = {}) {
    this.namespace = options.namespace ?? "fylo";
    this.rootPromise = null;
    this.dirCache = new Map;
  }
  key(path) {
    const normalised = normalize(path);
    return normalised.startsWith("/") ? normalised.slice(1) : normalised;
  }
  async root() {
    if (this.rootPromise)
      return await this.rootPromise;
    if (!hasOpfs(globalThis.navigator)) {
      throw new Error("OPFS is not available in this browser context");
    }
    this.rootPromise = globalThis.navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(this.namespace, { create: true }));
    return await this.rootPromise;
  }
  async directoryHandle(path, create = false) {
    const key = this.key(path);
    const cacheKey = key || "/";
    const cached = this.dirCache.get(cacheKey);
    if (cached)
      return cached;
    let handle = await this.root();
    if (!key || key === ".")
      return handle;
    for (const segment of key.split("/").filter(Boolean)) {
      handle = await handle.getDirectoryHandle(segment, { create });
    }
    this.dirCache.set(cacheKey, handle);
    return handle;
  }
  async fileHandle(path, create = false) {
    const dir = await this.directoryHandle(dirname(path), create);
    return await dir.getFileHandle(this.basename(path), { create });
  }
  basename(path) {
    const key = this.key(path);
    const index = key.lastIndexOf("/");
    return index === -1 ? key : key.slice(index + 1);
  }
  async exists(path) {
    try {
      await this.fileHandle(path, false);
      return true;
    } catch (err) {
      if (!isNotFound(err)) {
        try {
          await this.directoryHandle(path, false);
          return true;
        } catch (directoryErr) {
          if (!isNotFound(directoryErr))
            throw directoryErr;
        }
      }
      return false;
    }
  }
  async isDirectory(path) {
    try {
      await this.directoryHandle(path, false);
      return true;
    } catch (err) {
      if (isNotFound(err))
        return false;
      throw err;
    }
  }
  async mtimeMs(path) {
    const file = await (await this.fileHandle(path, false)).getFile();
    return file.lastModified;
  }
  async size(path) {
    const file = await (await this.fileHandle(path, false)).getFile();
    return file.size;
  }
  async mkdir(path, options = {}) {
    await this.directoryHandle(path, options.recursive === true);
  }
  async list(path) {
    const dir = await this.directoryHandle(path, false);
    const names = [];
    const keys = dir.keys();
    for await (const name of keys) {
      names.push(name);
    }
    return names.sort();
  }
  async rmdir(path, options = {}) {
    const parent = await this.directoryHandle(dirname(path), false);
    try {
      await parent.removeEntry(this.basename(path), { recursive: options.recursive === true });
    } catch (err) {
      if (!isNotFound(err))
        throw err;
    }
  }
  async readText(path) {
    return DECODER3.decode(await this.readBytes(path));
  }
  async readBytes(path) {
    const file = await (await this.fileHandle(path, false)).getFile();
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  }
  async writeText(path, data) {
    await this.writeBytes(path, ENCODER3.encode(data));
  }
  async writeBytes(path, data) {
    const handle = await this.fileHandle(path, true);
    const writable = await handle.createWritable();
    try {
      await writable.write(data.slice());
    } finally {
      await writable.close();
    }
  }
  async appendText(path, data) {
    const handle = await this.fileHandle(path, true);
    if (typeof globalThis.document === "undefined" && "createSyncAccessHandle" in handle) {
      const access = await handle.createSyncAccessHandle();
      try {
        access.write(ENCODER3.encode(data), { at: access.getSize() });
        access.flush();
      } finally {
        access.close();
      }
      return;
    }
    const existing = await this.exists(path) ? await this.readBytes(path) : new Uint8Array(0);
    const addition = ENCODER3.encode(data);
    const merged = new Uint8Array(existing.byteLength + addition.byteLength);
    merged.set(existing, 0);
    merged.set(addition, existing.byteLength);
    await this.writeBytes(path, merged);
  }
  async remove(path) {
    const parent = await this.directoryHandle(dirname(path), false);
    try {
      await parent.removeEntry(this.basename(path));
    } catch (err) {
      if (!isNotFound(err))
        throw err;
    }
  }
  async move(source, target) {
    const bytes = await this.readBytes(source);
    await this.writeBytes(target, bytes);
    await this.remove(source);
  }
  async withSession(_path, body) {
    return await body();
  }
}
function createOpfsFilesystem(options = {}) {
  return new OpfsFilesystem(options);
}

// src/browser/fsa-filesystem.js
class FsaFilesystem extends OpfsFilesystem {
  constructor(rootHandle) {
    super();
    this.rootHandle = rootHandle;
  }
  async root() {
    return this.rootHandle;
  }
}
function createOverlayFilesystem(base) {
  const layer = createMemoryFilesystem();
  const removed = new Set;
  const key = (path) => normalize(path);
  const inBase = async (path) => !removed.has(key(path)) && await base.exists(path);
  const copyUp = async (path) => {
    if (!await layer.exists(path) && await inBase(path)) {
      await layer.writeBytes(path, await base.readBytes(path));
    }
  };
  return {
    async exists(path) {
      return await layer.exists(path) || await inBase(path);
    },
    async isDirectory(path) {
      if (await layer.exists(path))
        return await layer.isDirectory(path);
      if (removed.has(key(path)))
        return false;
      return await base.isDirectory(path);
    },
    async mtimeMs(path) {
      if (await layer.exists(path))
        return await layer.mtimeMs(path);
      return await base.mtimeMs(path);
    },
    async size(path) {
      if (await layer.exists(path))
        return await layer.size(path);
      return await base.size(path);
    },
    async mkdir(path, options) {
      await layer.mkdir(path, options);
    },
    async list(path) {
      const names = new Set;
      if (!removed.has(key(path))) {
        try {
          for (const name of await base.list(path)) {
            if (!removed.has(key(`${path}/${name}`)))
              names.add(name);
          }
        } catch {}
      }
      try {
        for (const name of await layer.list(path))
          names.add(name);
      } catch {}
      return [...names].sort();
    },
    async rmdir(path, options) {
      removed.add(key(path));
      try {
        await layer.rmdir(path, options);
      } catch {}
    },
    async readText(path) {
      if (await layer.exists(path))
        return await layer.readText(path);
      return await base.readText(path);
    },
    async readBytes(path) {
      if (await layer.exists(path))
        return await layer.readBytes(path);
      return await base.readBytes(path);
    },
    async writeText(path, data) {
      removed.delete(key(path));
      await layer.writeText(path, data);
    },
    async writeBytes(path, data) {
      removed.delete(key(path));
      await layer.writeBytes(path, data);
    },
    async appendText(path, data) {
      await copyUp(path);
      removed.delete(key(path));
      await layer.appendText(path, data);
    },
    async remove(path) {
      removed.add(key(path));
      try {
        await layer.remove(path);
      } catch {}
    },
    async move(source, target) {
      await copyUp(source);
      await layer.move(source, target);
      removed.add(key(source));
      removed.delete(key(target));
    },
    async withSession(_path, body) {
      return await body();
    }
  };
}

// src/browser/storage.js
function normalizeBrowserStorage(storage) {
  const value = typeof storage === "string" ? { type: storage } : storage;
  if (!value || typeof value !== "object")
    throw new Error("Invalid browser storage configuration");
  if (value.type === "memory" || value.type === "opfs")
    return { type: value.type };
  if (value.type !== "fsa")
    throw new Error(`Unsupported browser storage type: ${value.type}`);
  if (!value.handle || value.handle.kind !== "directory") {
    throw new Error("File System Access storage requires a directory handle");
  }
  const access = value.access ?? "overlay";
  if (access !== "overlay" && access !== "readwrite") {
    throw new Error(`Unsupported File System Access mode: ${access}`);
  }
  return { type: "fsa", handle: value.handle, access };
}
function createBrowserFilesystem(storage, namespace) {
  if (storage.type === "memory")
    return createMemoryFilesystem();
  if (storage.type === "opfs")
    return createOpfsFilesystem({ namespace });
  const direct = new FsaFilesystem(storage.handle);
  return storage.access === "readwrite" ? direct : createOverlayFilesystem(direct);
}

// src/browser/wasm/index-scanner.js
var ENCODER4 = new TextEncoder;
var DECODER4 = new TextDecoder;
var WASM_ERROR = -1;
var WASM_ABI_VERSION = 1;
var INITIAL_OUTPUT_CAPACITY = 64 * 1024;
var MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
var MAX_QUERY_BYTES = 1024 * 1024;
var MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

class FyloWasmError extends Error {
  constructor(code, message, options = {}) {
    super(`[${code}] ${message}`, options);
    this.name = "FyloWasmError";
    this.code = code;
  }
}
var MODULE_CACHE = new Map;

class WasmIndexScannerFactory {
  constructor(options = {}) {
    this.module = options.module;
    this.url = options.url ? new URL(String(options.url), import.meta.url) : siblingAssetUrl("./fylo-index.wasm");
    this.modulePromise = null;
  }
  async ready() {
    await this.loadModule();
  }
  async loadModule() {
    if (this.module)
      return this.module;
    if (this.modulePromise)
      return await this.modulePromise;
    const key = this.url.href;
    let pending = MODULE_CACHE.get(key);
    if (!pending) {
      pending = (async () => {
        let response;
        try {
          response = await fetch(this.url);
        } catch (cause) {
          throw new FyloWasmError("EWASM_FETCH", `Unable to fetch FYLO Wasm index scanner from ${this.url.href}`, { cause });
        }
        if (!response.ok) {
          throw new FyloWasmError("EWASM_FETCH", `Unable to load FYLO Wasm index scanner: HTTP ${response.status}`);
        }
        try {
          return await WebAssembly.compile(await response.arrayBuffer());
        } catch (cause) {
          throw new FyloWasmError("EWASM_COMPILE", "Unable to compile FYLO Wasm index scanner", { cause });
        }
      })();
      MODULE_CACHE.set(key, pending);
      pending.catch(() => MODULE_CACHE.delete(key));
    }
    this.modulePromise = pending;
    return await pending;
  }
  async create() {
    try {
      const instance = await WebAssembly.instantiate(await this.loadModule(), {});
      return new WasmIndexScanner(instance);
    } catch (cause) {
      if (cause instanceof FyloWasmError)
        throw cause;
      throw new FyloWasmError("EWASM_INSTANTIATE", "Unable to instantiate FYLO Wasm index scanner", { cause });
    }
  }
}

class WasmIndexScanner {
  constructor(instance) {
    const exports = instance.exports;
    if (!(exports.memory instanceof WebAssembly.Memory)) {
      throw new FyloWasmError("EWASM_ABI", "FYLO Wasm index scanner did not export memory");
    }
    for (const name of [
      "abi_version",
      "allocate",
      "deallocate",
      "load_snapshot",
      "scan_queries"
    ]) {
      if (typeof exports[name] !== "function") {
        throw new FyloWasmError("EWASM_ABI", `FYLO Wasm index scanner did not export ${name}`);
      }
    }
    const actualVersion = exports.abi_version();
    if (actualVersion !== WASM_ABI_VERSION) {
      throw new FyloWasmError("EWASM_ABI", `Unsupported FYLO Wasm index ABI ${actualVersion}; expected ${WASM_ABI_VERSION}`);
    }
    this.memory = exports.memory;
    this.allocate = exports.allocate;
    this.deallocate = exports.deallocate;
    this.loadSnapshotExport = exports.load_snapshot;
    this.scanQueriesExport = exports.scan_queries;
    this.outputPointer = 0;
    this.outputCapacity = 0;
  }
  loadSnapshot(snapshot) {
    const bytes = snapshot instanceof Uint8Array ? snapshot : new Uint8Array(snapshot);
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new FyloWasmError("EWASM_SNAPSHOT", `FYLO Wasm snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
    }
    const pointer = this.allocateRegion(bytes.byteLength, "snapshot");
    try {
      if (bytes.byteLength > 0) {
        try {
          new Uint8Array(this.memory.buffer, pointer, bytes.byteLength).set(bytes);
        } catch (cause) {
          throw new FyloWasmError("EWASM_MEMORY", "Unable to copy the FYLO index snapshot into Wasm memory", { cause });
        }
      }
      if (this.loadSnapshotExport(pointer, bytes.byteLength) === WASM_ERROR) {
        throw new FyloWasmError("EWASM_SNAPSHOT", "FYLO Wasm index scanner rejected the snapshot");
      }
    } finally {
      this.deallocate(pointer, bytes.byteLength);
    }
  }
  scanQueries(queries) {
    let input;
    try {
      input = ENCODER4.encode(JSON.stringify(queries));
    } catch (cause) {
      throw new FyloWasmError("EWASM_QUERY", "Unable to encode the FYLO Wasm query", {
        cause
      });
    }
    if (input.byteLength > MAX_QUERY_BYTES) {
      throw new FyloWasmError("EWASM_QUERY", `FYLO Wasm query exceeds ${MAX_QUERY_BYTES} bytes`);
    }
    const inputPointer = this.allocateRegion(input.byteLength, "query");
    try {
      new Uint8Array(this.memory.buffer, inputPointer, input.byteLength).set(input);
    } catch (cause) {
      this.deallocate(inputPointer, input.byteLength);
      throw new FyloWasmError("EWASM_MEMORY", "Unable to copy the FYLO query into Wasm memory", { cause });
    }
    this.ensureOutput(Math.max(this.outputCapacity, INITIAL_OUTPUT_CAPACITY));
    try {
      let required = this.scanQueriesExport(inputPointer, input.byteLength, this.outputPointer, this.outputCapacity);
      if (required === WASM_ERROR)
        throw new FyloWasmError("EWASM_QUERY", "FYLO Wasm index scanner rejected the query");
      if (required > this.outputCapacity) {
        if (required > MAX_OUTPUT_BYTES) {
          throw new FyloWasmError("EWASM_MEMORY", `FYLO Wasm scan output exceeds ${MAX_OUTPUT_BYTES} bytes`);
        }
        this.ensureOutput(required);
        required = this.scanQueriesExport(inputPointer, input.byteLength, this.outputPointer, this.outputCapacity);
      }
      if (required === WASM_ERROR || required > this.outputCapacity) {
        throw new FyloWasmError("EWASM_MEMORY", "FYLO Wasm index scan failed after resizing its output buffer");
      }
      return DECODER4.decode(new Uint8Array(this.memory.buffer, this.outputPointer, required)).split(`
`).filter(Boolean);
    } finally {
      this.deallocate(inputPointer, input.byteLength);
    }
  }
  ensureOutput(capacity) {
    if (capacity <= this.outputCapacity)
      return;
    if (capacity > MAX_OUTPUT_BYTES) {
      throw new FyloWasmError("EWASM_MEMORY", `FYLO Wasm output allocation exceeds ${MAX_OUTPUT_BYTES} bytes`);
    }
    const pointer = this.allocateRegion(capacity, "output");
    if (this.outputPointer)
      this.deallocate(this.outputPointer, this.outputCapacity);
    this.outputCapacity = capacity;
    this.outputPointer = pointer;
  }
  allocateRegion(length, purpose) {
    try {
      const pointer = this.allocate(length);
      if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer + length > this.memory.buffer.byteLength) {
        throw new RangeError("allocator returned an invalid linear-memory region");
      }
      return pointer;
    } catch (cause) {
      if (cause instanceof FyloWasmError)
        throw cause;
      throw new FyloWasmError("EWASM_MEMORY", `Unable to allocate Wasm memory for the FYLO ${purpose}`, { cause });
    }
  }
  close() {
    if (this.outputPointer)
      this.deallocate(this.outputPointer, this.outputCapacity);
    this.outputPointer = 0;
    this.outputCapacity = 0;
  }
}
function createWasmIndexScannerFactory(options) {
  return new WasmIndexScannerFactory(options === true ? {} : options);
}
function siblingAssetUrl(path) {
  const base = new URL(import.meta.url);
  const asset = new URL(path, base);
  asset.search = base.search;
  return asset;
}

// src/browser/worker/runtime.js
class FyloWorkerRuntime {
  constructor() {
    this.cores = new Map;
    this.subscriptions = new Map;
    this.coreSubscriptions = new Map;
  }
  coreKey(envelope) {
    const namespace = envelope.namespace ?? "fylo";
    return envelope.instanceId ? `${namespace}:${envelope.instanceId}` : namespace;
  }
  core(envelope) {
    const namespace = envelope.namespace ?? "fylo";
    const key = this.coreKey(envelope);
    const existing = this.cores.get(key);
    if (existing)
      return existing;
    const storage = normalizeBrowserStorage(envelope.storage ?? "opfs");
    const fs = createBrowserFilesystem(storage, namespace);
    const core = new BrowserCore({
      fs,
      root: envelope.root ?? "/",
      worm: envelope.worm,
      indexScannerFactory: envelope.wasm ? createWasmIndexScannerFactory(envelope.wasm) : undefined
    });
    this.cores.set(key, core);
    return core;
  }
  async readyCore(envelope) {
    const core = this.core(envelope);
    await core.ready();
    return core;
  }
  async dispatch(port, envelope) {
    if (envelope.type === "close") {
      await this.closeCore(envelope);
      this.post(port, { id: envelope.id, ok: true, result: true });
      return;
    }
    if (envelope.type === "ready") {
      await this.readyCore(envelope);
      this.post(port, { id: envelope.id, ok: true, result: true });
      return;
    }
    if (envelope.type === "subscribe") {
      await this.subscribe(port, envelope);
      this.post(port, { id: envelope.id, ok: true, result: true });
      return;
    }
    if (envelope.type === "unsubscribe") {
      this.unsubscribe(port, envelope);
      this.post(port, { id: envelope.id, ok: true, result: true });
      return;
    }
    const request = envelope.request;
    if (!request)
      throw new Error("FYLO worker request envelope is missing request");
    const response = await runBrowserRequest(await this.readyCore(envelope), request);
    this.post(port, { id: envelope.id, ...response });
  }
  async closeCore(envelope) {
    if (!envelope.instanceId)
      return;
    const coreKey = this.coreKey(envelope);
    const core = this.cores.get(coreKey);
    this.cores.delete(coreKey);
    await core?.close();
    for (const key of [...this.subscriptions.keys()]) {
      if (!key.startsWith(`${coreKey}:`))
        continue;
      this.subscriptions.delete(key);
      this.coreSubscriptions.get(key)?.();
      this.coreSubscriptions.delete(key);
    }
  }
  async subscribe(port, envelope) {
    const collection = envelope.collection;
    if (!collection)
      throw new Error("FYLO worker subscribe requires collection");
    const key = `${this.coreKey(envelope)}:${collection}`;
    let ports = this.subscriptions.get(key);
    if (!ports) {
      ports = new Set;
      this.subscriptions.set(key, ports);
    }
    ports.add(port);
    if (!this.coreSubscriptions.has(key)) {
      const unsubscribe = (await this.readyCore(envelope)).subscribe(collection, (event) => {
        this.broadcast(key, envelope.namespace ?? "fylo", collection, event);
      });
      this.coreSubscriptions.set(key, unsubscribe);
    }
  }
  unsubscribe(port, envelope) {
    const collection = envelope.collection;
    if (!collection)
      return;
    const key = `${this.coreKey(envelope)}:${collection}`;
    const ports = this.subscriptions.get(key);
    ports?.delete(port);
    if (ports && ports.size === 0) {
      this.subscriptions.delete(key);
      this.coreSubscriptions.get(key)?.();
      this.coreSubscriptions.delete(key);
    }
  }
  broadcast(key, namespace, collection, event) {
    const ports = this.subscriptions.get(key);
    if (!ports)
      return;
    for (const port of ports) {
      this.post(port, {
        type: "event",
        namespace,
        collection,
        event
      });
    }
  }
  post(port, message) {
    port.postMessage(message);
  }
}
async function handleWorkerMessage(runtime, port, message) {
  try {
    await runtime.dispatch(port, message);
  } catch (error) {
    const failure = error;
    runtime.post(port, {
      id: message?.id,
      ok: false,
      error: {
        name: failure.name || "Error",
        message: failure.message || "Unknown error"
      }
    });
  }
}

// src/browser/worker/shared.js
var runtime = new FyloWorkerRuntime;
var sharedScope = globalThis;
sharedScope.onconnect = (event) => {
  const port = event.ports[0];
  port.onmessage = (message) => {
    handleWorkerMessage(runtime, port, message.data);
  };
  port.start();
};
