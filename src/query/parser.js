import { safeRecord } from './safe-record.js'

/** @enum {string} */
const TokenType = {
    CREATE: 'CREATE',
    DROP: 'DROP',
    SELECT: 'SELECT',
    FROM: 'FROM',
    WHERE: 'WHERE',
    INSERT: 'INSERT',
    INTO: 'INTO',
    VALUES: 'VALUES',
    UPDATE: 'UPDATE',
    SET: 'SET',
    DELETE: 'DELETE',
    JOIN: 'JOIN',
    INNER: 'INNER',
    LEFT: 'LEFT',
    RIGHT: 'RIGHT',
    OUTER: 'OUTER',
    ON: 'ON',
    GROUP: 'GROUP',
    BY: 'BY',
    ORDER: 'ORDER',
    LIMIT: 'LIMIT',
    AS: 'AS',
    AND: 'AND',
    OR: 'OR',
    EQUALS: '=',
    NOT_EQUALS: '!=',
    GREATER_THAN: '>',
    LESS_THAN: '<',
    GREATER_EQUAL: '>=',
    LESS_EQUAL: '<=',
    LIKE: 'LIKE',
    IDENTIFIER: 'IDENTIFIER',
    STRING: 'STRING',
    NUMBER: 'NUMBER',
    BOOLEAN: 'BOOLEAN',
    NULL: 'NULL',
    COMMA: ',',
    SEMICOLON: ';',
    LPAREN: '(',
    RPAREN: ')',
    ASTERISK: '*',
    EOF: 'EOF'
}

/**
 * @typedef {object} Token
 * @property {TokenType} type
 * @property {string} value
 * @property {number} position
 */

/**
 * @typedef {{ column: string, operator: string, value: string | number | boolean | null }} SqlCondition
 * @typedef {Record<string, Record<string, any>>} QueryOperation
 * @typedef {{ $eq?: string, $ne?: string, $gt?: string, $lt?: string, $gte?: string, $lte?: string }} JoinOperand
 * @typedef {{ $collection?: string, $select?: string[], $rename?: Record<string, string>, $ops?: QueryOperation[], $limit?: number, $onlyIds?: boolean, $groupby?: string }} StoreQuery
 * @typedef {{ $leftCollection: string, $rightCollection: string, $mode: 'inner' | 'left' | 'right' | 'outer', $on: Record<string, JoinOperand>, $select?: string[], $limit?: number, $onlyIds?: boolean, $groupby?: string, $rename?: Record<string, string> }} StoreJoin
 * @typedef {{ $collection?: string, $values: Record<string, any> }} StoreInsert
 * @typedef {{ $collection?: string, $where?: StoreQuery, $set: Record<string, any> }} StoreUpdate
 * @typedef {StoreQuery} StoreDelete
 */
/**
 * Tokenizes the supported FYLO SQL subset into parser tokens.
 */
/**
 * Punctuation and single-character operators, keyed by their character.
 * @type {Record<string, string>}
 */
const SINGLE_CHARACTER_TOKENS = {
    '=': TokenType.EQUALS,
    ',': TokenType.COMMA,
    ';': TokenType.SEMICOLON,
    '(': TokenType.LPAREN,
    ')': TokenType.RPAREN,
    '*': TokenType.ASTERISK
}

/**
 * Operators whose meaning depends on a following `=`. `alone: null` means the
 * bare character is not a token and is skipped.
 * @type {Record<string, { withEquals: string, alone: string | null }>}
 */
const COMPARISON_TOKENS = {
    '>': { withEquals: TokenType.GREATER_EQUAL, alone: TokenType.GREATER_THAN },
    '<': { withEquals: TokenType.LESS_EQUAL, alone: TokenType.LESS_THAN },
    '!': { withEquals: TokenType.NOT_EQUALS, alone: null }
}

class SQLLexer {
    /** @type {string} */
    input
    /** @type {number} */
    position = 0
    /** @type {string | null} */
    current = null
    /**
     * @param {string} input
     */
    constructor(input) {
        this.input = input.trim()
        this.current = this.input[0] || null
    }
    /** @returns {void} */
    advance() {
        this.position++
        this.current = this.position < this.input.length ? this.input[this.position] : null
    }
    /** @returns {string | null} */
    peek() {
        const nextPosition = this.position + 1
        return nextPosition < this.input.length ? this.input[nextPosition] : null
    }
    /** @returns {void} */
    skipWhitespace() {
        while (this.current && /\s/.test(this.current)) {
            this.advance()
        }
    }
    /** @returns {string} */
    readString() {
        let result = ''
        const quote = this.current
        this.advance() // Skip opening quote
        while (this.current && this.current !== quote) {
            result += this.current
            this.advance()
        }
        while (this.current === quote && this.peek() === quote) {
            result += quote
            this.advance()
            this.advance()
            while (this.current && this.current !== quote) {
                result += this.current
                this.advance()
            }
        }
        if (this.current === quote) {
            this.advance() // Skip closing quote
        }
        return result
    }
    /** @returns {string} */
    readNumber() {
        let result = ''
        while (this.current && /[\d.]/.test(this.current)) {
            result += this.current
            this.advance()
        }
        return result
    }
    /** @returns {string} */
    readIdentifier() {
        let result = ''
        while (this.current && /[a-zA-Z0-9_\-]/.test(this.current)) {
            result += this.current
            this.advance()
        }
        return result
    }
    /**
     * @param {string} word
     * @returns {TokenType}
     */
    getKeywordType(word) {
        /** @type {Record<string, TokenType>} */
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
        }
        return keywords[word.toUpperCase()] || TokenType.IDENTIFIER
    }
    /**
     * @returns {Token[]}
     */
    tokenize() {
        /** @type {Token[]} */
        const tokens = []
        while (this.current) {
            this.skipWhitespace()
            if (!this.current) break
            const position = this.position
            // String literals
            if (this.current === "'" || this.current === '"') {
                const value = this.readString()
                tokens.push({ type: TokenType.STRING, value, position })
                continue
            }
            // Numbers
            if (/\d/.test(this.current)) {
                const value = this.readNumber()
                tokens.push({ type: TokenType.NUMBER, value, position })
                continue
            }
            // Identifiers and keywords
            if (/[a-zA-Z_]/.test(this.current)) {
                tokens.push(this.readIdentifierToken(position))
                continue
            }
            // Operators and punctuation. An unrecognized character is consumed
            // and produces no token, as before.
            const operator = this.readOperatorToken(position)
            if (operator) tokens.push(operator)
        }
        tokens.push({ type: TokenType.EOF, value: '', position: this.position })
        return tokens
    }

    /**
     * Reads an identifier, folding dot notation for nested fields into FYLO's
     * slash paths (`address.city` → `address/city`).
     * @param {number} position
     * @returns {Token}
     */
    readIdentifierToken(position) {
        let value = this.readIdentifier()
        while (
            this.current === '.' &&
            this.position + 1 < this.input.length &&
            /[a-zA-Z_]/.test(this.input[this.position + 1])
        ) {
            this.advance() // skip '.'
            value += '/' + this.readIdentifier()
        }
        return { type: this.getKeywordType(value), value, position }
    }

    /**
     * Reads one operator or punctuation token, consuming its characters.
     * Returns null for an unrecognized character, which is skipped.
     * @param {number} position
     * @returns {Token | null}
     */
    readOperatorToken(position) {
        const character = this.current
        if (!character) return null
        const comparison = COMPARISON_TOKENS[character]
        if (comparison) {
            const { withEquals, alone } = comparison
            if (this.input[this.position + 1] === '=') {
                this.advance()
                this.advance()
                return { type: withEquals, value: `${character}=`, position }
            }
            this.advance()
            return alone ? { type: alone, value: character, position } : null
        }
        const single = SINGLE_CHARACTER_TOKENS[character]
        this.advance()
        return single ? { type: single, value: character, position } : null
    }
}
// SQL Parser
/**
 * Recursive-descent parser for FYLO's SQL subset.
 */
class SQLParser {
    /** @type {Token[]} */
    tokens
    /** @type {number} */
    position = 0
    /** @type {Token} */
    current
    /**
     * @param {Token[]} tokens
     */
    constructor(tokens) {
        this.tokens = tokens
        this.current = tokens[0]
    }
    /** @returns {void} */
    advance() {
        this.position++
        this.current = this.tokens[this.position] || {
            type: TokenType.EOF,
            value: '',
            position: -1
        }
    }
    /**
     * @param {TokenType} type
     * @returns {Token}
     */
    expect(type) {
        if (this.current.type !== type) {
            throw new Error('Invalid SQL syntax')
        }
        const token = this.current
        this.advance()
        return token
    }
    /**
     * @param {...TokenType} types
     * @returns {boolean}
     */
    match(...types) {
        return types.includes(this.current.type)
    }
    /** @returns {string | number | boolean | null} */
    parseValue() {
        if (this.current.type === TokenType.STRING) {
            const value = this.current.value
            this.advance()
            return value
        }
        if (this.current.type === TokenType.NUMBER) {
            const value = parseFloat(this.current.value)
            this.advance()
            return value
        }
        if (this.current.type === TokenType.BOOLEAN) {
            const value = this.current.value.toLowerCase() === 'true'
            this.advance()
            return value
        }
        if (this.current.type === TokenType.NULL) {
            this.advance()
            return null
        }
        throw new Error(`Unexpected value type: ${this.current.type}`)
    }
    /** @returns {string} */
    parseOperator() {
        const operatorMap = {
            [TokenType.EQUALS]: '$eq',
            [TokenType.NOT_EQUALS]: '$ne',
            [TokenType.GREATER_THAN]: '$gt',
            [TokenType.LESS_THAN]: '$lt',
            [TokenType.GREATER_EQUAL]: '$gte',
            [TokenType.LESS_EQUAL]: '$lte',
            [TokenType.LIKE]: '$like'
        }
        if (operatorMap[this.current.type]) {
            const operator = operatorMap[this.current.type]
            this.advance()
            return operator ?? ''
        }
        throw new Error(`Unknown operator: ${this.current.type}`)
    }
    /** @returns {SqlCondition} */
    parseCondition() {
        const column = this.expect(TokenType.IDENTIFIER).value
        const operator = this.parseOperator()
        const value = this.parseValue()
        return { column, operator, value }
    }
    /** @returns {QueryOperation[]} */
    parseWhereClause() {
        this.expect(TokenType.WHERE)
        /** @type {QueryOperation[]} */
        const conditions = []
        /** @type {QueryOperation} */
        let conjunction = safeRecord()
        while (true) {
            const condition = this.parseCondition()
            const operand = conjunction[condition.column] ?? safeRecord()
            operand[condition.operator] = condition.value
            conjunction[condition.column] = operand

            if (this.match(TokenType.AND)) {
                this.advance()
                continue
            }
            if (this.match(TokenType.OR)) {
                conditions.push(conjunction)
                conjunction = safeRecord()
                this.advance()
                continue
            }
            break
        }
        conditions.push(conjunction)
        return conditions
    }
    /** @returns {string[]} */
    parseSelectClause() {
        this.expect(TokenType.SELECT)
        /** @type {string[]} */
        const columns = []
        if (this.current.type === TokenType.ASTERISK) {
            this.advance()
            return ['*']
        }
        do {
            columns.push(this.expect(TokenType.IDENTIFIER).value)
            if (this.current.type === TokenType.COMMA) {
                this.advance()
            } else {
                break
            }
        } while (true)
        return columns
    }
    /** @returns {StoreQuery | StoreJoin} */
    parseSelect() {
        const select = this.parseSelectClause()
        this.expect(TokenType.FROM)
        const collection = this.expect(TokenType.IDENTIFIER).value
        // Check if this is a JOIN query
        if (
            this.match(
                TokenType.JOIN,
                TokenType.INNER,
                TokenType.LEFT,
                TokenType.RIGHT,
                TokenType.OUTER
            )
        ) {
            return this.parseJoinQuery(select, collection)
        }
        /** @type {StoreQuery} */
        const query = {
            $collection: collection,
            $select: select.includes('*') ? undefined : select,
            $onlyIds: select.includes('_id')
        }
        if (this.match(TokenType.WHERE)) {
            query.$ops = this.parseWhereClause()
        }
        if (this.match(TokenType.GROUP)) {
            this.advance()
            this.expect(TokenType.BY)
            query.$groupby = this.expect(TokenType.IDENTIFIER).value
        }
        if (this.match(TokenType.LIMIT)) {
            this.advance()
            query.$limit = parseInt(this.expect(TokenType.NUMBER).value)
        }
        return query
    }
    /**
     * @param {string[]} select
     * @param {string} leftCollection
     * @returns {StoreJoin}
     */
    parseJoinQuery(select, leftCollection) {
        // Parse join type
        /** @type {'inner' | 'left' | 'right' | 'outer'} */
        let joinMode = 'inner'
        if (this.match(TokenType.INNER)) {
            this.advance()
            joinMode = 'inner'
        } else if (this.match(TokenType.LEFT)) {
            this.advance()
            joinMode = 'left'
        } else if (this.match(TokenType.RIGHT)) {
            this.advance()
            joinMode = 'right'
        } else if (this.match(TokenType.OUTER)) {
            this.advance()
            joinMode = 'outer'
        }
        this.expect(TokenType.JOIN)
        const rightCollection = this.expect(TokenType.IDENTIFIER).value
        this.expect(TokenType.ON)
        // Parse join conditions
        const onConditions = this.parseJoinConditions()
        /** @type {StoreJoin} */
        const joinQuery = {
            $leftCollection: leftCollection,
            $rightCollection: rightCollection,
            $mode: joinMode,
            $on: onConditions,
            $select: select.includes('*') ? undefined : select
        }
        // Parse additional clauses
        if (this.match(TokenType.WHERE)) {
            // For joins, WHERE conditions would need to be handled differently
            // Skip for now as it's complex with joined tables
            this.parseWhereClause()
        }
        if (this.match(TokenType.GROUP)) {
            this.advance()
            this.expect(TokenType.BY)
            joinQuery.$groupby = this.expect(TokenType.IDENTIFIER).value
        }
        if (this.match(TokenType.LIMIT)) {
            this.advance()
            joinQuery.$limit = parseInt(this.expect(TokenType.NUMBER).value)
        }
        return joinQuery
    }
    /** @returns {Record<string, JoinOperand>} */
    parseJoinConditions() {
        /** @type {Record<string, JoinOperand>} */
        const conditions = safeRecord()
        do {
            // Parse: table1.column = table2.column
            const leftSide = this.parseJoinColumn()
            const operator = this.parseJoinOperator()
            const rightSide = this.parseJoinColumn()
            // Build the join condition
            const leftColumn = leftSide.column
            const rightColumn = rightSide.column
            if (!Object.hasOwn(conditions, leftColumn)) conditions[leftColumn] = safeRecord()
            conditions[leftColumn][operator] = rightColumn
            if (this.match(TokenType.AND)) {
                this.advance()
            } else {
                break
            }
        } while (true)
        return conditions
    }
    /** @returns {{ column: string }} */
    parseJoinColumn() {
        const identifier = this.expect(TokenType.IDENTIFIER).value
        // Check if it's table.column format
        if (this.current.type === TokenType.IDENTIFIER) {
            // This might be a qualified column name, but we'll treat it as simple for now
            return { column: identifier }
        }
        return { column: identifier }
    }
    /** @returns {keyof JoinOperand} */
    parseJoinOperator() {
        /** @type {Partial<Record<TokenType, keyof JoinOperand>>} */
        const operatorMap = {
            [TokenType.EQUALS]: '$eq',
            [TokenType.NOT_EQUALS]: '$ne',
            [TokenType.GREATER_THAN]: '$gt',
            [TokenType.LESS_THAN]: '$lt',
            [TokenType.GREATER_EQUAL]: '$gte',
            [TokenType.LESS_EQUAL]: '$lte'
        }
        if (operatorMap[this.current.type]) {
            const operator = operatorMap[this.current.type]
            this.advance()
            if (!operator) throw new Error(`Unknown join operator: ${this.current.type}`)
            return operator
        }
        throw new Error(`Unknown join operator: ${this.current.type}`)
    }
    /** @returns {StoreInsert} */
    parseInsert() {
        this.expect(TokenType.INSERT)
        this.expect(TokenType.INTO)
        const collection = this.expect(TokenType.IDENTIFIER).value
        // Parse column list
        /** @type {string[]} */
        let columns = []
        if (this.current.type === TokenType.LPAREN) {
            this.advance()
            do {
                columns.push(this.expect(TokenType.IDENTIFIER).value)
                if (this.current.type === TokenType.COMMA) {
                    this.advance()
                } else {
                    break
                }
            } while (true)
            this.expect(TokenType.RPAREN)
        }
        this.expect(TokenType.VALUES)
        this.expect(TokenType.LPAREN)
        /** @type {Record<string, string | number | boolean | null>} */
        const values = safeRecord()
        let valueIndex = 0
        do {
            const value = this.parseValue()
            const column = columns[valueIndex] || `col${valueIndex}`
            values[column] = value
            valueIndex++
            if (this.current.type === TokenType.COMMA) {
                this.advance()
            } else {
                break
            }
        } while (true)
        this.expect(TokenType.RPAREN)
        return {
            $collection: collection,
            $values: values
        }
    }
    /** @returns {StoreUpdate} */
    parseUpdate() {
        this.expect(TokenType.UPDATE)
        const collection = this.expect(TokenType.IDENTIFIER).value
        this.expect(TokenType.SET)
        /** @type {Record<string, string | number | boolean | null>} */
        const set = safeRecord()
        do {
            const column = this.expect(TokenType.IDENTIFIER).value
            this.expect(TokenType.EQUALS)
            const value = this.parseValue()
            set[column] = value
            if (this.current.type === TokenType.COMMA) {
                this.advance()
            } else {
                break
            }
        } while (true)
        /** @type {StoreUpdate} */
        const update = {
            $collection: collection,
            $set: set
        }
        if (this.match(TokenType.WHERE)) {
            const whereQuery = {
                $collection: collection,
                $ops: this.parseWhereClause()
            }
            update.$where = whereQuery
        }
        return update
    }
    /** @returns {StoreDelete} */
    parseDelete() {
        this.expect(TokenType.DELETE)
        this.expect(TokenType.FROM)
        const collection = this.expect(TokenType.IDENTIFIER).value
        /** @type {StoreDelete} */
        const deleteQuery = {
            $collection: collection
        }
        if (this.match(TokenType.WHERE)) {
            deleteQuery.$ops = this.parseWhereClause()
        }
        return deleteQuery
    }
}
/**
 * Converts supported SQL statements into FYLO's structured query objects and
 * exposes fluent builders for query construction.
 */
export class Parser {
    /**
     * Parses a SQL statement into FYLO's structured query AST.
     * @param {string} sql
     * @returns {StoreQuery | StoreJoin | StoreInsert | StoreUpdate | StoreDelete | { $collection: string }}
     */
    static parse(sql) {
        const lexer = new SQLLexer(sql)
        const tokens = lexer.tokenize()
        const parser = new SQLParser(tokens)
        // Determine query type based on first token
        const firstToken = tokens[0]
        switch (firstToken.value) {
            case TokenType.CREATE:
                return { $collection: tokens[2].value }
            case TokenType.SELECT:
                return parser.parseSelect()
            case TokenType.INSERT:
                return parser.parseInsert()
            case TokenType.UPDATE:
                return parser.parseUpdate()
            case TokenType.DELETE:
                return parser.parseDelete()
            case TokenType.DROP:
                return { $collection: tokens[2].value }
            default:
                throw new Error(`Unsupported SQL statement type: ${firstToken.value}`)
        }
    }
    // Bun SQL inspired query builder methods
    /**
     * @param {string} collection
     * @returns {QueryBuilder}
     */
    static query(collection) {
        return new QueryBuilder(collection)
    }
    // Join query builder
    /**
     * @param {string} leftCollection
     * @param {string} rightCollection
     * @returns {JoinBuilder}
     */
    static join(leftCollection, rightCollection) {
        return new JoinBuilder(leftCollection, rightCollection)
    }
}
/**
 * Fluent builder for FYLO SELECT-style query objects.
 */
export class QueryBuilder {
    /** @type {string} */
    collection
    /** @type {StoreQuery} */
    queryAst = {}
    /**
     * @param {string} collection
     */
    constructor(collection) {
        this.collection = collection
        this.queryAst.$collection = collection
    }
    /**
     * @param {...string} columns
     * @returns {this}
     */
    select(...columns) {
        this.queryAst.$select = columns
        return this
    }
    /**
     * @param {QueryOperation[]} conditions
     * @returns {this}
     */
    where(conditions) {
        this.queryAst.$ops = conditions
        return this
    }
    /**
     * @param {number} count
     * @returns {this}
     */
    limit(count) {
        this.queryAst.$limit = count
        return this
    }
    /**
     * @param {string} column
     * @returns {this}
     */
    groupBy(column) {
        this.queryAst.$groupby = column
        return this
    }
    /** @returns {this} */
    onlyIds() {
        this.queryAst.$onlyIds = true
        return this
    }
    /** @returns {StoreQuery} */
    build() {
        return this.queryAst
    }
    // Convert to SQL string (reverse operation)
    /** @returns {string} */
    toSQL() {
        let sql = 'SELECT '
        if (this.queryAst.$select) {
            sql += this.queryAst.$select.join(', ')
        } else {
            sql += '*'
        }
        sql += ` FROM ${this.collection}`
        if (this.queryAst.$ops && this.queryAst.$ops.length > 0) {
            sql += ' WHERE '
            const conditions = this.queryAst.$ops
                .map((op) => {
                    const entries = Object.entries(op)
                    return entries
                        .map(([column, operand]) => {
                            const opEntries = Object.entries(operand ?? {})
                            return opEntries
                                .map(([operator, value]) => {
                                    const sqlOp = this.operatorToSQL(operator)
                                    const sqlValue =
                                        typeof value === 'string' ? `'${value}'` : value
                                    return `${column} ${sqlOp} ${sqlValue}`
                                })
                                .join(' AND ')
                        })
                        .join(' AND ')
                })
                .join(' AND ')
            sql += conditions
        }
        if (this.queryAst.$groupby) {
            sql += ` GROUP BY ${String(this.queryAst.$groupby)}`
        }
        if (this.queryAst.$limit) {
            sql += ` LIMIT ${this.queryAst.$limit}`
        }
        return sql
    }
    /**
     * @param {string} operator
     * @returns {string}
     */
    operatorToSQL(operator) {
        /** @type {Record<string, string>} */
        const opMap = {
            $eq: '=',
            $ne: '!=',
            $gt: '>',
            $lt: '<',
            $gte: '>=',
            $lte: '<=',
            $like: 'LIKE'
        }
        return opMap[operator] || '='
    }
}
/**
 * Fluent builder for FYLO join query objects.
 */
export class JoinBuilder {
    /** @type {Partial<StoreJoin>} */
    joinAst = {}
    /**
     * @param {string} leftCollection
     * @param {string} rightCollection
     */
    constructor(leftCollection, rightCollection) {
        this.joinAst.$leftCollection = leftCollection
        this.joinAst.$rightCollection = rightCollection
        this.joinAst.$mode = 'inner' // default
    }
    /**
     * @param {...string} columns
     * @returns {this}
     */
    select(...columns) {
        this.joinAst.$select = columns
        return this
    }
    /** @returns {this} */
    innerJoin() {
        this.joinAst.$mode = 'inner'
        return this
    }
    /** @returns {this} */
    leftJoin() {
        this.joinAst.$mode = 'left'
        return this
    }
    /** @returns {this} */
    rightJoin() {
        this.joinAst.$mode = 'right'
        return this
    }
    /** @returns {this} */
    outerJoin() {
        this.joinAst.$mode = 'outer'
        return this
    }
    /**
     * @param {Record<string, JoinOperand>} conditions
     * @returns {this}
     */
    on(conditions) {
        this.joinAst.$on = conditions
        return this
    }
    /**
     * @param {number} count
     * @returns {this}
     */
    limit(count) {
        this.joinAst.$limit = count
        return this
    }
    /**
     * @param {string} column
     * @returns {this}
     */
    groupBy(column) {
        this.joinAst.$groupby = column
        return this
    }
    /** @returns {this} */
    onlyIds() {
        this.joinAst.$onlyIds = true
        return this
    }
    /**
     * @param {Record<string, string>} mapping
     * @returns {this}
     */
    rename(mapping) {
        this.joinAst.$rename = mapping
        return this
    }
    /** @returns {StoreJoin} */
    build() {
        if (!this.joinAst.$on) {
            throw new Error('JOIN query must have ON conditions')
        }
        return /** @type {StoreJoin} */ (this.joinAst)
    }
    // Convert to SQL string
    /** @returns {string} */
    toSQL() {
        let sql = 'SELECT '
        if (this.joinAst.$select) {
            sql += this.joinAst.$select.join(', ')
        } else {
            sql += '*'
        }
        sql += ` FROM ${this.joinAst.$leftCollection}`
        // Add join type
        const joinType = this.joinAst.$mode?.toUpperCase() || 'INNER'
        sql += ` ${joinType} JOIN ${this.joinAst.$rightCollection}`
        // Add ON conditions
        if (this.joinAst.$on) {
            sql += ' ON '
            const conditions = Object.entries(this.joinAst.$on)
                .map(([leftCol, operand]) => {
                    return Object.entries(operand ?? {})
                        .map(([operator, rightCol]) => {
                            const sqlOp = this.operatorToSQL(operator)
                            return `${this.joinAst.$leftCollection}.${leftCol} ${sqlOp} ${this.joinAst.$rightCollection}.${String(rightCol)}`
                        })
                        .join(' AND ')
                })
                .join(' AND ')
            sql += conditions
        }
        if (this.joinAst.$groupby) {
            sql += ` GROUP BY ${String(this.joinAst.$groupby)}`
        }
        if (this.joinAst.$limit) {
            sql += ` LIMIT ${this.joinAst.$limit}`
        }
        return sql
    }
    /**
     * @param {string} operator
     * @returns {string}
     */
    operatorToSQL(operator) {
        /** @type {Record<string, string>} */
        const opMap = {
            $eq: '=',
            $ne: '!=',
            $gt: '>',
            $lt: '<',
            $gte: '>=',
            $lte: '<='
        }
        return opMap[operator] || '='
    }
}
