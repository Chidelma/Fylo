import { createHash } from 'node:crypto'
import { shardOf } from '../core/doc-id.js'
import { cp, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import TTID from '../vendor/ttid.js'
import { isDurableWriteScratchPath, writeDurable } from '../storage/durable.js'
import { FilesystemEngine } from '../storage/engine.js'
import { tryReleaseFileLock, waitAcquireFileLock } from '../storage/fs-lock.js'
import { rawFileId } from '../core/raw-file.js'
import { CHECKSUM_XATTR } from '../storage/files.js'
import { getXattr, listXattr, setXattr } from '../storage/xattr.js'
import { assertSafeStoragePath } from '../storage/safe-path.js'
import { readAccessDescriptor, restoreAccessDescriptor } from '../security/access.js'

const DEFAULT_BRANCH = 'main'
const METADATA_DIR = '.fylo-vcs'
const COLLECTIONS_DIR = '.collections'
const BUCKETS_DIR = '.buckets'
// Both on-disk namespaces version control walks: document collections and file
// buckets share an identical internal layout (docs/, .deleted/, index/, ...).
const DATA_DIRS = [COLLECTIONS_DIR, BUCKETS_DIR]
const OBJECTS_DIR = 'objects'
// Document metadata lives in `user.fylo.*` extended attributes on the files
// themselves. Commits still record it under the `.metadata` namespace as a
// derived canonical blob, so history stays byte-compatible with old commits
// (whose blobs were `{version:1,key}` sidecar files) and diffs detect
// metadata changes by hash like any other document change.
const FYLO_XATTR_PREFIX = 'user.fylo.'

/**
 * @typedef {'preparing' | 'staged' | 'swapping' | 'backup-moved' | 'installed' | 'ref-updated'} MaterializationPhase
 */

/**
 * @typedef {object} MaterializationTransaction
 * @property {1} version
 * @property {MaterializationPhase} phase
 * @property {string} targetRoot repository-relative working-tree root
 * @property {Array<{ relative: string, collection: string, hadCurrent: boolean, shouldInstall: boolean }>} targets
 * @property {{ prior: FyloBranchRef, target: FyloBranchRef } | null} ref
 */

/**
 * @typedef {object} FyloBranchRef
 * @property {string} name
 * @property {string | null} head
 * @property {string} root
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string | undefined} sourceBranch
 * @property {string | null | undefined} sourceCommit
 */

/**
 * @typedef {object} FyloCommitManifest
 * @property {string} id
 * @property {string} branch
 * @property {string[]} parents
 * @property {string} message
 * @property {string} createdAt
 * @property {string} root
 */

/**
 * @typedef {object} FyloCheckoutResult
 * @property {string} branch
 * @property {boolean} created
 * @property {string | null} head
 * @property {string} root
 */

/**
 * @typedef {object} FyloBranchListResult
 * @property {string} current
 * @property {FyloBranchRef[]} branches
 */

/**
 * @typedef {'active' | 'deleted' | 'metadata'} FyloVersionedDocumentKind
 */

/**
 * @typedef {'added' | 'modified' | 'deleted'} FyloTreeChangeStatus
 */

/**
 * @typedef {object} FyloTreeChange
 * @property {FyloTreeChangeStatus} status
 * @property {string} collection
 * @property {FyloVersionedDocumentKind} kind
 * @property {string} id
 * @property {string} path
 */

/**
 * @typedef {object} FyloDiffResult
 * @property {string} from
 * @property {string} to
 * @property {{ added: number, modified: number, deleted: number, total: number }} counts
 * @property {FyloTreeChange[]} changes
 */

/**
 * @typedef {object} FyloStatusResult
 * @property {string} branch
 * @property {string | null} head
 * @property {boolean} clean
 * @property {FyloDiffResult} diff
 */

/**
 * @typedef {object} FyloRestoreCommitResult
 * @property {string} branch
 * @property {string} head
 * @property {string} restored
 * @property {boolean} forced
 * @property {string} root
 */

/**
 * @typedef {'already-up-to-date' | 'fast-forward' | 'merge' | 'conflict'} FyloMergeMode
 */

/**
 * @typedef {object} FyloMergeConflict
 * @property {string} collection
 * @property {FyloVersionedDocumentKind} kind
 * @property {string} id
 * @property {string} path
 * @property {string | null} baseHash
 * @property {string | null} oursHash
 * @property {string | null} theirsHash
 */

/**
 * @typedef {object} FyloMergeResult
 * @property {string} branch
 * @property {string} source
 * @property {string | null} base
 * @property {string | null} head
 * @property {FyloMergeMode} mode
 * @property {boolean} merged
 * @property {string[]} parents
 * @property {string | undefined} commit
 * @property {number} applied
 * @property {FyloMergeConflict[]} conflicts
 */

/**
 * File-backed repository for FYLO document version control.
 *
 * Storage is content-addressed end to end. Every document version is written
 * once as a deduplicated blob under `objects/`, and a commit's snapshot is a
 * tree of content-addressed tree nodes mirroring the on-disk shard layout
 * (collection -> namespace -> bucket -> document). A commit's `tree.json` holds
 * only the root tree hash, so it is O(1); unchanged subtrees are shared by hash
 * across commits and branches.
 *
 * Single-document commits are incremental: auto-commit passes the ids it
 * changed, so only those documents are re-read and only the tree nodes on their
 * path to the root are rewritten — per-commit work is bounded by what changed,
 * not the collection size. Manual `commit` (no hints) does a full working-tree
 * scan and yields an identical root hash, and bulk operations coalesce into one
 * commit. The dirty check is an O(1) root-hash comparison.
 *
 * Documents are the source of truth; indexes are accelerators. Restores and
 * merges rematerialize documents from blobs and then rebuild the derived
 * indexes, so no index state is ever versioned.
 */
export class VersionRepository {
    /** @type {string} */
    root
    /** @type {((phase: MaterializationPhase, transactionRoot: string) => void | Promise<void>) | undefined} */
    onMaterializationPhase

    /**
     * @param {string} root
     * @param {{ onMaterializationPhase?: (phase: MaterializationPhase, transactionRoot: string) => void | Promise<void> }} [options]
     */
    constructor(root, options = {}) {
        this.root = root
        this.onMaterializationPhase = options.onMaterializationPhase
    }

    /** @returns {string} */
    metadataRoot() {
        return path.join(this.root, METADATA_DIR)
    }

    /** @returns {string} */
    stagingRoot() {
        return path.join(this.metadataRoot(), 'staging')
    }

    /** @returns {string} */
    materializationLockPath() {
        return path.join(this.metadataRoot(), 'locks', 'materialization.lock')
    }

    /** @param {string} collection @returns {string} */
    worktreeLockPath(collection) {
        validateBranchName(collection)
        const locksRoot = path.join(this.metadataRoot(), 'locks', 'worktree')
        const target = path.join(locksRoot, `${collection}.lock`)
        assertPathInside(locksRoot, target)
        return target
    }

    /**
     * Collections created with `{ versioned: false }` are excluded from
     * snapshots, diffs, and restores — their working files are the only copy.
     * @param {string} collection
     * @returns {Promise<boolean>}
     */
    async isVersionedCollection(collection) {
        try {
            const descriptor = await readFile(
                path.join(this.root, '.fylo-catalog', 'collections', `${collection}.json`),
                'utf8'
            )
            return (
                /** @type {{ versioned?: unknown }} */ (JSON.parse(descriptor)).versioned !== false
            )
        } catch {
            return true
        }
    }

    /**
     * On-disk namespace for a collection, from its (unversioned, persistent)
     * catalog descriptor: `.buckets` for file collections, else `.collections`.
     * Used on the restore side, where the committed tree doesn't record which.
     * @param {string} collection @returns {Promise<string>}
     */
    async collectionDataDir(collection) {
        try {
            const descriptor = await readFile(
                path.join(this.root, '.fylo-catalog', 'collections', `${collection}.json`),
                'utf8'
            )
            return /** @type {{ kind?: unknown }} */ (JSON.parse(descriptor)).kind === 'file'
                ? BUCKETS_DIR
                : COLLECTIONS_DIR
        } catch {
            return COLLECTIONS_DIR
        }
    }

    /** @returns {string} */
    refsRoot() {
        return path.join(this.metadataRoot(), 'refs', 'heads')
    }

    /** @returns {string} */
    commitsRoot() {
        return path.join(this.metadataRoot(), 'commits')
    }

    /** @returns {string} */
    hiddenBranchesRoot() {
        return path.join(this.metadataRoot(), 'branches')
    }

    /** @returns {string} */
    headPath() {
        return path.join(this.metadataRoot(), 'HEAD')
    }

    /**
     * @param {string} branch
     * @returns {string}
     */
    refPath(branch) {
        const target = path.join(this.refsRoot(), `${branch}.json`)
        assertPathInside(this.refsRoot(), target)
        return target
    }

    /**
     * @param {string} branch
     * @returns {string}
     */
    branchRoot(branch) {
        validateBranchName(branch)
        if (branch === DEFAULT_BRANCH) return this.root
        const target = path.join(this.hiddenBranchesRoot(), branch)
        assertPathInside(this.hiddenBranchesRoot(), target)
        return target
    }

    /**
     * @param {string} commitId
     * @returns {Promise<string>}
     */
    async commitRoot(commitId) {
        await validateCommitId(commitId)
        return path.join(this.commitsRoot(), commitId)
    }

    /**
     * @returns {Promise<void>}
     */
    async init() {
        await mkdir(this.refsRoot(), { recursive: true })
        await mkdir(this.commitsRoot(), { recursive: true })
        await mkdir(this.hiddenBranchesRoot(), { recursive: true })
        await mkdir(this.stagingRoot(), { recursive: true })
        if (!(await exists(this.refPath(DEFAULT_BRANCH)))) {
            await this.writeRef({
                name: DEFAULT_BRANCH,
                head: null,
                root: '.',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                sourceBranch: undefined,
                sourceCommit: undefined
            })
        }
        if (!(await exists(this.headPath()))) await this.writeHead(DEFAULT_BRANCH)
        await this.recoverMaterializationTransactions()
    }

    /**
     * Serializes repository materialization and protects every affected
     * collection against ordinary storage writes through stable locks outside
     * the directories being swapped.
     * @template T
     * @param {string[]} collections
     * @param {() => Promise<T>} action
     * @returns {Promise<T>}
     */
    async withMaterializationGuards(collections, action) {
        const owner = String(Bun.randomUUIDv7())
        const repositoryLock = this.materializationLockPath()
        await waitAcquireFileLock(repositoryLock, owner, {
            ttlMs: 300_000,
            waitTimeoutMs: 60_000,
            heartbeat: true
        })
        try {
            return await this.withWorktreeLocks(collections, owner, action)
        } finally {
            await tryReleaseFileLock(repositoryLock, owner)
        }
    }

    /** @template T @param {string[]} collections @param {string} owner @param {() => Promise<T>} action @returns {Promise<T>} */
    async withWorktreeLocks(collections, owner, action) {
        /** @type {string[]} */
        const acquired = []
        try {
            for (const collection of [...new Set(collections)].sort()) {
                const lockPath = this.worktreeLockPath(collection)
                await waitAcquireFileLock(lockPath, owner, {
                    ttlMs: 300_000,
                    waitTimeoutMs: 60_000,
                    heartbeat: true
                })
                acquired.push(lockPath)
            }
            return await action()
        } finally {
            for (const lockPath of acquired.reverse()) {
                await tryReleaseFileLock(lockPath, owner)
            }
        }
    }

    /**
     * Replays stranded materialization transactions at startup. Transactions
     * before `installed` roll back to their prior tree/ref; `installed` and
     * later roll forward to the target ref. Both decisions are idempotent and
     * inferred from the durable phase plus the current/backup/staged paths.
     * @returns {Promise<void>}
     */
    async recoverMaterializationTransactions() {
        const owner = String(Bun.randomUUIDv7())
        const repositoryLock = this.materializationLockPath()
        await waitAcquireFileLock(repositoryLock, owner, {
            ttlMs: 300_000,
            waitTimeoutMs: 60_000,
            heartbeat: true
        })
        try {
            // The staging parent is a permanent coordination directory. It may
            // be absent on first initialization (or after an older FYLO build
            // removed it), so recreate it while holding the repository lock
            // immediately before enumeration.
            await mkdir(this.stagingRoot(), { recursive: true })
            for (const entry of await readdir(this.stagingRoot(), { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.isSymbolicLink()) continue
                const transactionRoot = path.join(this.stagingRoot(), entry.name)
                let manifest
                try {
                    manifest = await this.readMaterializationManifest(transactionRoot)
                } catch (error) {
                    if (
                        /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' &&
                        !(await exists(path.join(transactionRoot, 'previous')))
                    ) {
                        // The process died while durably creating the first
                        // `preparing` manifest. No swap can precede that write,
                        // so this directory contains scratch/staged data only.
                        await this.cleanupMaterialization(transactionRoot)
                        continue
                    }
                    throw error
                }
                await this.withWorktreeLocks(
                    manifest.targets.map((target) => target.collection),
                    owner,
                    async () => {
                        if (manifest.phase === 'installed' || manifest.phase === 'ref-updated') {
                            await this.rollForwardMaterialization(transactionRoot, manifest)
                        } else {
                            await this.rollBackMaterialization(transactionRoot, manifest)
                        }
                    }
                )
            }
        } finally {
            await tryReleaseFileLock(repositoryLock, owner)
        }
    }

    /** @param {string} transactionRoot @returns {Promise<MaterializationTransaction>} */
    async readMaterializationManifest(transactionRoot) {
        const target = path.join(transactionRoot, 'transaction.json')
        assertPathInside(this.stagingRoot(), target)
        const parsed = /** @type {MaterializationTransaction} */ (
            JSON.parse(await readFile(target, 'utf8'))
        )
        validateMaterializationManifest(parsed)
        return parsed
    }

    /** @param {string} transactionRoot @param {MaterializationTransaction} manifest */
    async writeMaterializationManifest(transactionRoot, manifest) {
        await writeDurable(
            path.join(transactionRoot, 'transaction.json'),
            `${JSON.stringify(manifest, null, 2)}\n`
        )
        await this.onMaterializationPhase?.(manifest.phase, transactionRoot)
    }

    /** @param {MaterializationTransaction} manifest @returns {string} */
    materializationTargetRoot(manifest) {
        const target = path.resolve(this.root, manifest.targetRoot)
        assertPathInside(this.root, target)
        return target
    }

    /** @param {string} transactionRoot @param {MaterializationTransaction} manifest */
    async rollBackMaterialization(transactionRoot, manifest) {
        const targetRoot = this.materializationTargetRoot(manifest)
        for (const target of [...manifest.targets].reverse()) {
            const current = path.join(targetRoot, target.relative)
            const backup = path.join(transactionRoot, 'previous', target.relative)
            assertPathInside(targetRoot, current)
            assertPathInside(transactionRoot, backup)
            if (await exists(backup)) {
                await rm(current, { recursive: true, force: true })
                await renameDurable(backup, current)
            } else if (!target.hadCurrent) {
                await rm(current, { recursive: true, force: true })
                await syncDirectory(path.dirname(current))
            }
        }
        if (manifest.ref) await this.writeRef(manifest.ref.prior)
        await this.cleanupMaterialization(transactionRoot)
    }

    /** @param {string} transactionRoot @param {MaterializationTransaction} manifest */
    async rollForwardMaterialization(transactionRoot, manifest) {
        const targetRoot = this.materializationTargetRoot(manifest)
        for (const target of manifest.targets) {
            const current = path.join(targetRoot, target.relative)
            const staged = path.join(transactionRoot, 'next', target.relative)
            assertPathInside(targetRoot, current)
            assertPathInside(transactionRoot, staged)
            if (!target.shouldInstall) {
                await rm(current, { recursive: true, force: true })
                await syncDirectory(path.dirname(current))
            } else if (!(await exists(current))) {
                if (!(await exists(staged))) {
                    throw new Error(
                        `Cannot recover installed materialization target: ${target.relative}`
                    )
                }
                await mkdir(path.dirname(current), { recursive: true })
                await renameDurable(staged, current)
            }
        }
        if (manifest.ref) await this.writeRef(manifest.ref.target)
        await this.cleanupMaterialization(transactionRoot)
    }

    /** @param {string} transactionRoot */
    async cleanupMaterialization(transactionRoot) {
        await rm(transactionRoot, { recursive: true, force: true })
        await syncDirectory(this.stagingRoot())
    }

    /**
     * @param {string} branch
     * @param {{ create?: boolean }} [options]
     * @returns {Promise<FyloCheckoutResult>}
     */
    async checkout(branch, options = {}) {
        validateBranchName(branch)
        await this.init()
        const current = await this.currentBranch()
        if (options.create) {
            if (await exists(this.refPath(branch)))
                throw new Error(`Branch already exists: ${branch}`)
            const currentRef = await this.readRef(current)
            const branchRoot = this.branchRoot(branch)
            await mkdir(branchRoot, { recursive: true })
            await copyCollections(this.branchRoot(current), branchRoot)
            const now = new Date().toISOString()
            await this.writeRef({
                name: branch,
                head: currentRef.head,
                root: path.relative(this.root, branchRoot) || '.',
                createdAt: now,
                updatedAt: now,
                sourceBranch: current,
                sourceCommit: currentRef.head
            })
        } else if (!(await exists(this.refPath(branch)))) {
            throw new Error(`Branch not found: ${branch}`)
        }
        await this.writeHead(branch)
        const ref = await this.readRef(branch)
        return {
            branch,
            created: options.create === true,
            head: ref.head,
            root: this.branchRoot(branch)
        }
    }

    /**
     * @returns {Promise<string>}
     */
    async currentBranch() {
        await this.init()
        const head = (await readFile(this.headPath(), 'utf8')).trim()
        const match = head.match(/^ref: refs\/heads\/(.+)$/)
        if (!match) throw new Error('FYLO repository HEAD is corrupt')
        validateBranchName(match[1])
        return match[1]
    }

    /**
     * @returns {Promise<FyloBranchListResult>}
     */
    async listBranches() {
        await this.init()
        const branches = []
        for (const file of await listJsonFiles(this.refsRoot())) {
            const branch = file.slice(0, -'.json'.length)
            branches.push(await this.readRef(branch))
        }
        branches.sort((left, right) => left.name.localeCompare(right.name))
        return { current: await this.currentBranch(), branches }
    }

    /**
     * @param {string} message
     * @returns {Promise<FyloCommitManifest>}
     */
    async commit(message) {
        if (typeof message !== 'string' || message.trim().length === 0) {
            throw new Error('Commit message is required')
        }
        await this.init()
        const branch = await this.currentBranch()
        const ref = await this.readRef(branch)
        const tree = await this.snapshotWorkingTree(this.branchRoot(branch))
        return await this.createCommitFromTree(
            branch,
            ref,
            ref.head ? [ref.head] : [],
            message.trim(),
            tree
        )
    }

    /**
     * Commits the current branch only when document state differs from HEAD.
     * When the caller supplies the ids it changed (auto-commit always does), the
     * new tree is computed incrementally: only those documents are re-read and
     * only the tree nodes on their path are rewritten, so per-commit work is
     * independent of total collection size. Without hints — the manual CLI
     * `commit` — it falls back to a full working-tree scan. Either way the dirty
     * check is an O(1) root-hash comparison, so no-op writes create no commit.
     *
     * @param {string} message
     * @param {Array<{ collection: string, id: string }>} [changes]
     * @returns {Promise<FyloCommitManifest | null>}
     */
    async commitIfDirty(message, changes) {
        if (typeof message !== 'string' || message.trim().length === 0) {
            throw new Error('Commit message is required')
        }
        await this.init()
        const owner = Bun.randomUUIDv7()
        const lockPath = path.join(this.metadataRoot(), 'locks', 'autocommit.lock')
        await waitAcquireFileLock(lockPath, owner, {
            ttlMs: 300_000,
            waitTimeoutMs: 60_000,
            heartbeat: true
        })
        try {
            const branch = await this.currentBranch()
            const ref = await this.readRef(branch)
            const branchRoot = this.branchRoot(branch)
            const parentRoot = ref.head ? await this.readTreeRoot(ref.head) : null
            const rootHash =
                changes && changes.length > 0 && ref.head
                    ? await this.computeIncrementalRoot(parentRoot, branchRoot, changes)
                    : await this.writeTreeFromEntries(await this.snapshotWorkingTree(branchRoot))
            if (rootHash === parentRoot) return null
            return await this.writeCommit(
                branch,
                ref,
                ref.head ? [ref.head] : [],
                message.trim(),
                rootHash
            )
        } finally {
            await tryReleaseFileLock(lockPath, owner)
        }
    }

    /**
     * Snapshots the branch working tree, then writes the commit. Retained for
     * merge, which commits an already-materialized working tree.
     *
     * @param {string} branch
     * @param {FyloBranchRef} ref
     * @param {string[]} parents
     * @param {string} message
     * @returns {Promise<FyloCommitManifest>}
     */
    async createCommit(branch, ref, parents, message) {
        const tree = await this.snapshotWorkingTree(this.branchRoot(branch))
        return await this.createCommitFromTree(branch, ref, parents, message, tree)
    }

    /**
     * Writes a commit from a complete flat document tree, building the nested
     * content-addressed tree objects from scratch. Used by the full-scan paths
     * (manual `commit`, merge).
     *
     * @param {string} branch
     * @param {FyloBranchRef} ref
     * @param {string[]} parents
     * @param {string} message
     * @param {Map<string, DocumentTreeEntry>} tree
     * @returns {Promise<FyloCommitManifest>}
     */
    async createCommitFromTree(branch, ref, parents, message, tree) {
        return await this.writeCommit(
            branch,
            ref,
            parents,
            message,
            await this.writeTreeFromEntries(tree)
        )
    }

    /**
     * Persists an immutable commit object: a small `manifest.json` (history
     * metadata) plus a `tree.json` that references the content-addressed root
     * tree by hash. Document and tree-node bytes already live in the shared
     * object store, so commits share every unchanged subtree across history and
     * branches and never copy collection data. `tree.json` is O(1) regardless of
     * collection size.
     *
     * @param {string} branch
     * @param {FyloBranchRef} ref
     * @param {string[]} parents
     * @param {string} message
     * @param {string | null} rootHash
     * @param {{ updateRef?: boolean }} [options]
     * @returns {Promise<FyloCommitManifest>}
     */
    async writeCommit(branch, ref, parents, message, rootHash, options = {}) {
        const commitId = String(await TTID.generate())
        const commitRoot = await this.commitRoot(commitId)
        await mkdir(commitRoot, { recursive: true })
        const manifest = {
            id: commitId,
            branch,
            parents,
            message,
            createdAt: new Date().toISOString(),
            root: path.relative(this.root, commitRoot)
        }
        await writeDurable(
            path.join(commitRoot, 'tree.json'),
            `${JSON.stringify({ root: rootHash })}\n`
        )
        await writeDurable(
            path.join(commitRoot, 'manifest.json'),
            `${JSON.stringify(manifest, null, 2)}\n`
        )
        if (options.updateRef !== false) {
            await this.writeRef({ ...ref, head: commitId, updatedAt: manifest.createdAt })
        }
        return manifest
    }

    /**
     * @param {{ branch?: string, limit?: number }} [options]
     * @returns {Promise<FyloCommitManifest[]>}
     */
    async log(options = {}) {
        await this.init()
        const branch = options.branch ?? (await this.currentBranch())
        const ref = await this.readRef(branch)
        const commits = []
        let next = ref.head
        const limit = options.limit ?? 50
        while (next && commits.length < limit) {
            const manifest = await this.readCommit(next)
            commits.push(manifest)
            next = manifest.parents[0]
        }
        return commits
    }

    /**
     * @returns {Promise<FyloStatusResult>}
     */
    async status() {
        await this.init()
        const branch = await this.currentBranch()
        const ref = await this.readRef(branch)
        const diff = await this.diff('HEAD', 'WORKTREE')
        return { branch, head: ref.head, clean: diff.counts.total === 0, diff }
    }

    /**
     * @param {string} [from]
     * @param {string} [to]
     * @returns {Promise<FyloDiffResult>}
     */
    async diff(from = 'HEAD', to = 'WORKTREE') {
        await this.init()
        const [left, right] = await Promise.all([this.resolveTree(from), this.resolveTree(to)])
        const changes = diffTrees(left.tree, right.tree)
        return {
            from: left.label,
            to: right.label,
            counts: countChanges(changes),
            changes
        }
    }

    /**
     * Restores a commit snapshot into the current branch working tree. The
     * commit objects remain immutable; this only moves the branch head and
     * rematerializes the branch's documents from the snapshot, rebuilding
     * indexes afterward.
     *
     * @param {string} commitId
     * @param {{ force?: boolean }} [options]
     * @returns {Promise<FyloRestoreCommitResult>}
     */
    async restoreCommit(commitId, options = {}) {
        await validateCommitId(commitId)
        await this.init()
        await this.readCommit(commitId)
        const branch = await this.currentBranch()
        const ref = await this.readRef(branch)
        if (!options.force) {
            const status = await this.status()
            if (!status.clean) {
                throw new Error(
                    'Working tree has uncommitted changes; commit them first or pass --force'
                )
            }
        }
        const branchRoot = this.branchRoot(branch)
        const targetTree = await this.readCommitTree(commitId)
        const targetRef = {
            ...ref,
            head: commitId,
            updatedAt: new Date().toISOString()
        }
        await this.materializeTree(targetTree, branchRoot, {
            ref: { prior: ref, target: targetRef }
        })
        return {
            branch,
            head: commitId,
            restored: commitId,
            forced: options.force === true,
            root: branchRoot
        }
    }

    /**
     * Merges a committed source snapshot into the current branch. The current
     * working tree must be clean so conflict detection always compares two
     * committed parents and never overwrites local uncommitted writes.
     *
     * @param {string} source
     * @param {{ message?: string }} [options]
     * @returns {Promise<FyloMergeResult>}
     */
    async merge(source, options = {}) {
        await this.init()
        const status = await this.status()
        if (!status.clean) {
            throw new Error('Working tree has uncommitted changes; commit them before merging')
        }
        const branch = await this.currentBranch()
        const ref = await this.readRef(branch)
        const theirs = await this.resolveCommit(source)
        const oursHead = ref.head
        if (oursHead === theirs.id) {
            return mergeResult(branch, theirs.id, theirs.id, theirs.id, 'already-up-to-date', true)
        }
        if (await this.isAncestor(theirs.id, oursHead)) {
            return mergeResult(branch, theirs.id, theirs.id, oursHead, 'already-up-to-date', true)
        }
        if (!oursHead || (await this.isAncestor(oursHead, theirs.id))) {
            const branchRoot = this.branchRoot(branch)
            const targetTree = await this.readCommitTree(theirs.id)
            await this.materializeTree(targetTree, branchRoot, {
                ref: {
                    prior: ref,
                    target: {
                        ...ref,
                        head: theirs.id,
                        updatedAt: new Date().toISOString()
                    }
                }
            })
            return mergeResult(branch, theirs.id, oursHead, theirs.id, 'fast-forward', true)
        }
        const base = await this.commonAncestor(oursHead, theirs.id)
        const plan = await this.planThreeWayMerge(base, oursHead, theirs.id)
        if (plan.conflicts.length > 0) {
            return {
                branch,
                source: theirs.id,
                base,
                head: oursHead,
                mode: 'conflict',
                merged: false,
                parents: [oursHead, theirs.id],
                commit: undefined,
                applied: 0,
                conflicts: plan.conflicts
            }
        }
        // Verify every referenced object (including parsing metadata objects)
        // before the first working-tree mutation.
        for (const change of plan.apply) {
            if (change.deleted) continue
            const content = await this.readObject(change.hash)
            if (change.kind === 'metadata') parseXattrBlob(content)
        }
        const branchRoot = this.branchRoot(branch)
        const mergedTree = await this.readCommitTree(oursHead)
        for (const change of plan.apply) {
            const key = treeEntryKey(change)
            if (change.deleted) mergedTree.delete(key)
            else mergedTree.set(key, change)
        }
        const message = options.message?.trim() || `Merge ${source} into ${branch}`
        const commit = await this.writeCommit(
            branch,
            ref,
            [oursHead, theirs.id],
            message,
            await this.writeTreeFromEntries(mergedTree),
            { updateRef: false }
        )
        await this.materializeTree(mergedTree, branchRoot, {
            ref: {
                prior: ref,
                target: { ...ref, head: commit.id, updatedAt: commit.createdAt }
            }
        })
        return {
            branch,
            source: theirs.id,
            base,
            head: commit.id,
            mode: 'merge',
            merged: true,
            parents: commit.parents,
            commit: commit.id,
            applied: plan.apply.length,
            conflicts: []
        }
    }

    /**
     * @param {string} commitId
     * @returns {Promise<FyloCommitManifest>}
     */
    async readCommit(commitId) {
        await validateCommitId(commitId)
        const text = await readFile(
            path.join(await this.commitRoot(commitId), 'manifest.json'),
            'utf8'
        )
        return /** @type {FyloCommitManifest} */ (JSON.parse(text))
    }

    /**
     * @param {string} branch
     * @returns {Promise<FyloBranchRef>}
     */
    async readRef(branch) {
        validateBranchName(branch)
        return /** @type {FyloBranchRef} */ (
            JSON.parse(await readFile(this.refPath(branch), 'utf8'))
        )
    }

    /**
     * Resolves a ref to its document tree. Committed refs read the stored
     * snapshot directly; working refs (`WORKTREE` or a branch name) are scanned
     * and hashed live so a diff reflects uncommitted changes.
     *
     * @param {string} ref
     * @returns {Promise<{ label: string, tree: Map<string, DocumentTreeEntry> }>}
     */
    async resolveTree(ref) {
        const normalized = ref.trim()
        if (normalized === 'WORKTREE') {
            const branch = await this.currentBranch()
            return {
                label: `${branch}:WORKTREE`,
                tree: await readDocumentTree(this.branchRoot(branch), (c) =>
                    this.isVersionedCollection(c)
                )
            }
        }
        if (normalized === 'HEAD') {
            const branch = await this.currentBranch()
            const branchRef = await this.readRef(branch)
            if (!branchRef.head) return { label: `${branch}:HEAD`, tree: new Map() }
            return { label: `${branch}:HEAD`, tree: await this.readCommitTree(branchRef.head) }
        }
        if (await TTID.isTTID(normalized)) {
            await this.readCommit(normalized)
            return { label: normalized, tree: await this.readCommitTree(normalized) }
        }
        validateBranchName(normalized)
        const branchRef = await this.readRef(normalized)
        return {
            label: normalized,
            tree: await readDocumentTree(this.branchRoot(branchRef.name), (c) =>
                this.isVersionedCollection(c)
            )
        }
    }

    /**
     * @param {string} ref
     * @returns {Promise<FyloCommitManifest>}
     */
    async resolveCommit(ref) {
        const normalized = ref.trim()
        if (normalized === 'HEAD') {
            const branch = await this.currentBranch()
            const branchRef = await this.readRef(branch)
            if (!branchRef.head) throw new Error(`Branch has no commits: ${branch}`)
            return await this.readCommit(branchRef.head)
        }
        if (await TTID.isTTID(normalized)) return await this.readCommit(normalized)
        validateBranchName(normalized)
        const branchRef = await this.readRef(normalized)
        if (!branchRef.head) throw new Error(`Branch has no commits: ${normalized}`)
        return await this.readCommit(branchRef.head)
    }

    /**
     * @param {string} ancestor
     * @param {string | null} descendant
     * @returns {Promise<boolean>}
     */
    async isAncestor(ancestor, descendant) {
        if (!descendant) return false
        return (await this.ancestorDepths(descendant)).has(ancestor)
    }

    /**
     * @param {string} left
     * @param {string} right
     * @returns {Promise<string | null>}
     */
    async commonAncestor(left, right) {
        const [leftAncestors, rightAncestors] = await Promise.all([
            this.ancestorDepths(left),
            this.ancestorDepths(right)
        ])
        let best = null
        let bestDistance = Number.POSITIVE_INFINITY
        for (const [commitId, leftDepth] of leftAncestors) {
            const rightDepth = rightAncestors.get(commitId)
            if (rightDepth === undefined) continue
            const distance = leftDepth + rightDepth
            if (distance < bestDistance) {
                best = commitId
                bestDistance = distance
            }
        }
        return best
    }

    /**
     * @param {string} commitId
     * @returns {Promise<Map<string, number>>}
     */
    async ancestorDepths(commitId) {
        /** @type {Map<string, number>} */
        const ancestors = new Map()
        /** @type {{ id: string, depth: number }[]} */
        const queue = [{ id: commitId, depth: 0 }]
        while (queue.length > 0) {
            const next = /** @type {{ id: string, depth: number }} */ (queue.shift())
            if (ancestors.has(next.id)) continue
            ancestors.set(next.id, next.depth)
            const commit = await this.readCommit(next.id)
            for (const parent of commit.parents) queue.push({ id: parent, depth: next.depth + 1 })
        }
        return ancestors
    }

    /**
     * @param {FyloBranchRef} ref
     * @returns {Promise<void>}
     */
    async writeRef(ref) {
        validateBranchName(ref.name)
        await writeDurable(this.refPath(ref.name), `${JSON.stringify(ref, null, 2)}\n`)
    }

    /**
     * @param {string} branch
     * @returns {Promise<void>}
     */
    async writeHead(branch) {
        validateBranchName(branch)
        await writeDurable(this.headPath(), `ref: refs/heads/${branch}\n`)
    }

    /**
     * Resolves the storage root for regular FYLO operations. When no repository
     * metadata exists, the caller keeps using the original root unchanged.
     *
     * @param {string} root
     * @returns {string}
     */
    static resolveActiveRoot(root) {
        const headPath = path.join(root, METADATA_DIR, 'HEAD')
        if (!existsSync(headPath)) return root
        const head = readFileSync(headPath, 'utf8').trim()
        const match = head.match(/^ref: refs\/heads\/(.+)$/)
        if (!match) throw new Error('FYLO repository HEAD is corrupt')
        const branch = match[1]
        validateBranchName(branch)
        if (branch === DEFAULT_BRANCH) return root
        const branchRoot = path.join(root, METADATA_DIR, 'branches', branch)
        assertPathInside(path.join(root, METADATA_DIR, 'branches'), branchRoot)
        if (!existsSync(path.join(root, METADATA_DIR, 'refs', 'heads', `${branch}.json`))) {
            throw new Error(`Active FYLO branch is missing its ref: ${branch}`)
        }
        return branchRoot
    }

    /**
     * Resolves the repository metadata root even when callers pass an already
     * materialized branch working tree with `{ versioning: { resolve: false } }`.
     *
     * @param {string} root
     * @returns {string}
     */
    static resolveRepositoryRoot(root) {
        const absolute = path.resolve(root)
        if (existsSync(path.join(absolute, METADATA_DIR, 'HEAD'))) return absolute
        let current = absolute
        while (true) {
            const parent = path.dirname(current)
            if (parent === current) return absolute
            if (existsSync(path.join(parent, METADATA_DIR, 'HEAD'))) {
                const branchesRoot = path.join(parent, METADATA_DIR, 'branches')
                const relative = path.relative(branchesRoot, absolute)
                if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
                    return parent
                }
            }
            current = parent
        }
    }

    /** @returns {string} */
    objectsRoot() {
        return path.join(this.metadataRoot(), OBJECTS_DIR)
    }

    /**
     * @param {string} hash
     * @returns {string}
     */
    objectPath(hash) {
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Invalid object hash: ${hash}`)
        return path.join(this.objectsRoot(), hash.slice(0, 2), hash.slice(2))
    }

    /**
     * Persists a document's bytes as a content-addressed, deduplicated blob.
     * Identical content across documents, commits, and branches is stored once.
     *
     * @param {string} hash
     * @param {Uint8Array} content
     * @returns {Promise<void>}
     */
    async writeObject(hash, content) {
        const target = this.objectPath(hash)
        if (await exists(target)) {
            await this.readObject(hash)
            return
        }
        await writeDurable(target, content)
    }

    /**
     * @param {string} hash
     * @returns {Promise<Buffer>}
     */
    async readObject(hash) {
        const content = await readFile(this.objectPath(hash))
        const actual = createHash('sha256').update(content).digest('hex')
        if (actual !== hash) {
            throw new Error(`Corrupt version object ${hash}: content hashes to ${actual}`)
        }
        return content
    }

    /**
     * Reads the hash of a commit's content-addressed root tree (or null for an
     * empty commit). O(1) — used for parent lookups and the dirty check.
     *
     * @param {string} commitId
     * @returns {Promise<string | null>}
     */
    async readTreeRoot(commitId) {
        await validateCommitId(commitId)
        const text = await readFile(path.join(await this.commitRoot(commitId), 'tree.json'), 'utf8')
        return /** @type {{ root: string | null }} */ (JSON.parse(text)).root
    }

    /**
     * Reads a commit's document tree as a flat `path → content-hash` map by
     * walking its content-addressed tree objects. Diff, merge, and restore all
     * consume this flat shape, so they are unaffected by the nested storage.
     *
     * @param {string} commitId
     * @returns {Promise<Map<string, DocumentTreeEntry>>}
     */
    async readCommitTree(commitId) {
        /** @type {Map<string, DocumentTreeEntry>} */
        const tree = new Map()
        const rootHash = await this.readTreeRoot(commitId)
        if (rootHash) await this.flattenTree(rootHash, tree)
        return tree
    }

    /**
     * @param {string} rootHash
     * @param {Map<string, DocumentTreeEntry>} tree
     * @returns {Promise<void>}
     */
    async flattenTree(rootHash, tree) {
        for (const collectionNode of await this.readTreeNode(rootHash)) {
            const collection = collectionNode.name
            // The committed tree doesn't record the namespace dir; the current
            // catalog descriptor is the authority for where it restores to.
            const dataDir = await this.collectionDataDir(collection)
            for (const kindNode of await this.readTreeNode(collectionNode.hash)) {
                const namespace = kindNode.name
                const kind = versionedKindForNamespace(namespace)
                for (const bucketNode of await this.readTreeNode(kindNode.hash)) {
                    for (const blob of await this.readTreeNode(bucketNode.hash)) {
                        const filename = blob.name
                        const id = rawFileId(filename)
                        if (!id || !(await TTID.isTTID(id))) continue
                        tree.set(`${collection}/${kind}/${filename}`, {
                            collection,
                            kind,
                            id,
                            path: path.join(
                                dataDir,
                                collection,
                                namespace,
                                bucketNode.name,
                                filename
                            ),
                            hash: blob.hash
                        })
                    }
                }
            }
        }
    }

    /**
     * Writes a content-addressed tree node: a canonical, name-sorted list of
     * child entries. Identical nodes across commits and branches collapse to one
     * object, which is what lets unchanged subtrees be shared by reference.
     *
     * @param {Map<string, { type: 'tree' | 'blob', hash: string }>} entries
     * @returns {Promise<string>}
     */
    async writeTreeNode(entries) {
        const node = {
            entries: [...entries.entries()]
                .map(([name, child]) => ({ name, type: child.type, hash: child.hash }))
                .sort((left, right) =>
                    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
                )
        }
        const serialized = JSON.stringify(node)
        const hash = createHash('sha256').update(serialized).digest('hex')
        await this.writeObject(hash, Buffer.from(serialized, 'utf8'))
        return hash
    }

    /**
     * @param {string} hash
     * @returns {Promise<Array<{ name: string, type: 'tree' | 'blob', hash: string }>>}
     */
    async readTreeNode(hash) {
        const buffer = await this.readObject(hash)
        return /** @type {{ entries: Array<{ name: string, type: 'tree' | 'blob', hash: string }> }} */ (
            JSON.parse(buffer.toString('utf8'))
        ).entries
    }

    /**
     * @param {string | undefined} hash
     * @returns {Promise<Map<string, { type: 'tree' | 'blob', hash: string }>>}
     */
    async toEntryMap(hash) {
        /** @type {Map<string, { type: 'tree' | 'blob', hash: string }>} */
        const map = new Map()
        if (!hash) return map
        for (const child of await this.readTreeNode(hash)) {
            map.set(child.name, { type: child.type, hash: child.hash })
        }
        return map
    }

    /**
     * Builds the full nested tree from a flat document map, writing every tree
     * node, and returns the root hash (null for an empty tree). The hierarchy is
     * collection → namespace (`docs`/`.deleted`) → bucket (`shardOf(id)`) →
     * document blob, mirroring the on-disk shard layout.
     *
     * @param {Map<string, DocumentTreeEntry>} flatTree
     * @returns {Promise<string | null>}
     */
    async writeTreeFromEntries(flatTree) {
        if (flatTree.size === 0) return null
        /** @type {Map<string, Map<string, Map<string, Map<string, string>>>>} */
        const grouped = new Map()
        for (const entry of flatTree.values()) {
            const namespace = namespaceForVersionedKind(entry.kind)
            getOrCreate(
                getOrCreate(getOrCreate(grouped, entry.collection), namespace),
                shardOf(entry.id)
            ).set(path.basename(entry.path), entry.hash)
        }
        /** @type {Map<string, { type: 'tree' | 'blob', hash: string }>} */
        const rootEntries = new Map()
        for (const [collection, namespaces] of grouped) {
            /** @type {Map<string, { type: 'tree' | 'blob', hash: string }>} */
            const collectionEntries = new Map()
            for (const [namespace, buckets] of namespaces) {
                /** @type {Map<string, { type: 'tree' | 'blob', hash: string }>} */
                const kindEntries = new Map()
                for (const [bucket, docs] of buckets) {
                    /** @type {Map<string, { type: 'tree' | 'blob', hash: string }>} */
                    const docEntries = new Map()
                    for (const [filename, hash] of docs)
                        docEntries.set(filename, { type: 'blob', hash })
                    kindEntries.set(bucket, {
                        type: 'tree',
                        hash: await this.writeTreeNode(docEntries)
                    })
                }
                collectionEntries.set(namespace, {
                    type: 'tree',
                    hash: await this.writeTreeNode(kindEntries)
                })
            }
            rootEntries.set(collection, {
                type: 'tree',
                hash: await this.writeTreeNode(collectionEntries)
            })
        }
        return await this.writeTreeNode(rootEntries)
    }

    /**
     * Computes a new root tree from the parent tree plus the documents that
     * changed, re-reading only those documents and rewriting only the tree nodes
     * on their paths. Unchanged subtrees are inherited from the parent by hash.
     * Produces a hash identical to a full scan of the same state, so it
     * interoperates with `writeTreeFromEntries` and the O(1) dirty check.
     *
     * @param {string | null} parentRoot
     * @param {string} branchRoot
     * @param {Array<{ collection: string, id: string }>} changes
     * @returns {Promise<string | null>}
     */
    async computeIncrementalRoot(parentRoot, branchRoot, changes) {
        const changeMap = await this.buildChangeMap(branchRoot, changes)
        const rootEntries = await this.toEntryMap(parentRoot ?? undefined)
        for (const [collection, namespaces] of changeMap) {
            const collectionEntries = await this.toEntryMap(rootEntries.get(collection)?.hash)
            for (const [namespace, buckets] of namespaces) {
                const kindEntries = await this.toEntryMap(collectionEntries.get(namespace)?.hash)
                for (const [bucket, docs] of buckets) {
                    const bucketEntries = await this.toEntryMap(kindEntries.get(bucket)?.hash)
                    for (const [id, file] of docs) {
                        for (const filename of bucketEntries.keys()) {
                            if (rawFileId(filename) === id) bucketEntries.delete(filename)
                        }
                        if (file !== null) {
                            bucketEntries.set(file.filename, {
                                type: 'blob',
                                hash: file.hash
                            })
                        }
                    }
                    if (bucketEntries.size === 0) kindEntries.delete(bucket)
                    else
                        kindEntries.set(bucket, {
                            type: 'tree',
                            hash: await this.writeTreeNode(bucketEntries)
                        })
                }
                if (kindEntries.size === 0) collectionEntries.delete(namespace)
                else
                    collectionEntries.set(namespace, {
                        type: 'tree',
                        hash: await this.writeTreeNode(kindEntries)
                    })
            }
            if (collectionEntries.size === 0) rootEntries.delete(collection)
            else
                rootEntries.set(collection, {
                    type: 'tree',
                    hash: await this.writeTreeNode(collectionEntries)
                })
        }
        if (rootEntries.size === 0) return null
        return await this.writeTreeNode(rootEntries)
    }

    /**
     * Reconciles each changed document id against the working tree, writing any
     * new blob, and groups the results as collection → namespace → bucket → id →
     * blob descriptor (null = the document is absent from that namespace and must be
     * removed). Both namespaces are reconciled per id so deletes and restores
     * move documents between `docs` and `.deleted` correctly.
     *
     * @param {string} branchRoot
     * @param {Array<{ collection: string, id: string }>} changes
     * @returns {Promise<Map<string, Map<string, Map<string, Map<string, { filename: string, hash: string } | null>>>>>}
     */
    async buildChangeMap(branchRoot, changes) {
        /** @type {Map<string, Map<string, Map<string, Map<string, { filename: string, hash: string } | null>>>>} */
        const grouped = new Map()
        /** @type {Set<string>} */
        const seen = new Set()
        for (const change of changes) {
            const id = String(change.id)
            const dedupeKey = `${change.collection}/${id}`
            if (seen.has(dedupeKey)) continue
            seen.add(dedupeKey)
            if (!(await this.isVersionedCollection(change.collection))) continue
            const bucket = shardOf(id)
            const changeDataDir = await this.collectionDataDir(change.collection)
            /** @type {string | null} */
            let documentPath = null
            for (const namespace of ['docs', '.deleted']) {
                const namespaceRoot = path.join(
                    branchRoot,
                    changeDataDir,
                    change.collection,
                    namespace,
                    bucket
                )
                const filePath = await findVersionedFile(branchRoot, namespaceRoot, id)
                /** @type {{ filename: string, hash: string } | null} */
                let blob = null
                if (filePath) {
                    documentPath ??= filePath
                    const content = await readFile(filePath)
                    const hash = createHash('sha256').update(content).digest('hex')
                    await this.writeObject(hash, content)
                    blob = { filename: path.basename(filePath), hash }
                }
                getOrCreate(
                    getOrCreate(getOrCreate(grouped, change.collection), namespace),
                    bucket
                ).set(id, blob)
            }
            /** @type {{ filename: string, hash: string } | null} */
            let metadataBlob = null
            const content = documentPath ? xattrBlobForFile(documentPath) : null
            if (content) {
                const hash = createHash('sha256').update(content).digest('hex')
                await this.writeObject(hash, content)
                metadataBlob = { filename: `${id}.json`, hash }
            }
            getOrCreate(
                getOrCreate(getOrCreate(grouped, change.collection), '.metadata'),
                bucket
            ).set(id, metadataBlob)
        }
        return grouped
    }

    /**
     * Snapshots a working tree into the object store: every document and
     * tombstone is hashed, written once as a blob, and recorded as a tree entry.
     * Returns the tree without copying whole collection directories.
     *
     * @param {string} branchRoot
     * @returns {Promise<Map<string, DocumentTreeEntry>>}
     */
    async snapshotWorkingTree(branchRoot) {
        /** @type {Map<string, DocumentTreeEntry>} */
        const tree = new Map()
        for (const dataDir of DATA_DIRS) {
            const collectionsRoot = path.join(branchRoot, dataDir)
            if (!(await exists(collectionsRoot))) continue
            await assertSafeStoragePath(branchRoot, collectionsRoot, { finalType: 'directory' })
            for (const collectionEntry of await readdir(collectionsRoot, { withFileTypes: true })) {
                if (collectionEntry.isSymbolicLink()) {
                    throw new Error(
                        `Version storage path contains a symbolic link: ${path.join(collectionsRoot, collectionEntry.name)}`
                    )
                }
                if (!collectionEntry.isDirectory()) continue
                const collection = collectionEntry.name
                if (!(await this.isVersionedCollection(collection))) continue
                const collectionRoot = path.join(collectionsRoot, collection)
                await this.snapshotNamespace(
                    tree,
                    branchRoot,
                    collectionRoot,
                    collection,
                    'docs',
                    'active',
                    dataDir
                )
                await this.snapshotNamespace(
                    tree,
                    branchRoot,
                    collectionRoot,
                    collection,
                    '.deleted',
                    'deleted',
                    dataDir
                )
                for (const entry of await collectXattrEntries(
                    branchRoot,
                    collectionRoot,
                    collection,
                    dataDir
                )) {
                    const hash = createHash('sha256').update(entry.content).digest('hex')
                    await this.writeObject(hash, entry.content)
                    tree.set(`${collection}/metadata/${entry.id}.json`, {
                        collection,
                        kind: 'metadata',
                        id: entry.id,
                        path: entry.path,
                        hash
                    })
                }
            }
        }
        return tree
    }

    /**
     * @param {Map<string, DocumentTreeEntry>} tree
     * @param {string} branchRoot
     * @param {string} collectionRoot
     * @param {string} collection
     * @param {string} namespace
     * @param {FyloVersionedDocumentKind} kind
     * @param {string} dataDir Top-level namespace dir (.collections or .buckets)
     * @returns {Promise<void>}
     */
    async snapshotNamespace(
        tree,
        branchRoot,
        collectionRoot,
        collection,
        namespace,
        kind,
        dataDir
    ) {
        const namespaceRoot = path.join(collectionRoot, namespace)
        if (!(await exists(namespaceRoot))) return
        await assertSafeStoragePath(branchRoot, namespaceRoot, { finalType: 'directory' })
        for (const file of await listFiles(namespaceRoot)) {
            const filename = path.basename(file)
            const id = rawFileId(filename)
            if (!id || !(await TTID.isTTID(id))) continue
            let content
            try {
                const target = path.join(namespaceRoot, file)
                await assertSafeStoragePath(branchRoot, target, { finalType: 'file' })
                content = await readFile(target)
            } catch (err) {
                // A concurrent write can move/replace this file between listing
                // and reading; skip the vanished version — the next auto-commit
                // captures the settled state.
                if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') continue
                throw err
            }
            const hash = createHash('sha256').update(content).digest('hex')
            await this.writeObject(hash, content)
            tree.set(`${collection}/${kind}/${filename}`, {
                collection,
                kind,
                id,
                path: path.join(dataDir, collection, namespace, file),
                hash
            })
        }
    }

    /**
     * Materializes a committed tree into a working directory by reconstructing
     * each document from its blob, then rebuilds the derived indexes for every
     * affected collection (documents are truth; indexes are accelerators).
     *
     * @param {Map<string, DocumentTreeEntry>} tree
     * @param {string} targetRoot
     * @param {{ ref?: { prior: FyloBranchRef, target: FyloBranchRef } }} [options]
     * @returns {Promise<void>}
     */
    async materializeTree(tree, targetRoot, options = {}) {
        assertPathInside(this.root, targetRoot)
        /** @type {Map<string, Buffer>} */
        const objects = new Map()
        /** @type {Map<string, string>} */
        const collections = new Map()
        /** @type {DocumentTreeEntry[]} */
        const metadataEntries = []
        for (const entry of tree.values()) {
            if (!(await this.isVersionedCollection(entry.collection))) continue
            collections.set(entry.collection, await this.collectionDataDir(entry.collection))
            if (!objects.has(entry.hash)) objects.set(entry.hash, await this.readObject(entry.hash))
            if (entry.kind === 'metadata') {
                metadataEntries.push(entry)
                parseXattrBlob(/** @type {Buffer} */ (objects.get(entry.hash)))
                continue
            }
        }
        /** @type {Map<string, { dataDir: string, collection: string }>} */
        const affected = new Map()
        for (const [collection, dataDir] of collections) {
            affected.set(`${dataDir}/${collection}`, { dataDir, collection })
        }
        // Unversioned collections are intentionally absent: only cataloged
        // versioned collection directories participate in the swap.
        for (const dataDir of DATA_DIRS) {
            const dataRoot = path.join(targetRoot, dataDir)
            if (!(await exists(dataRoot))) continue
            for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.isSymbolicLink()) continue
                if (!(await this.isVersionedCollection(entry.name))) continue
                affected.set(`${dataDir}/${entry.name}`, { dataDir, collection: entry.name })
            }
        }

        await this.withMaterializationGuards(
            [...affected.values()].map(({ collection }) => collection),
            async () => {
                const transactionRoot = path.join(this.stagingRoot(), String(Bun.randomUUIDv7()))
                const stageRoot = path.join(transactionRoot, 'next')
                const backupRoot = path.join(transactionRoot, 'previous')
                /** @type {MaterializationTransaction} */
                const manifest = {
                    version: 1,
                    phase: 'preparing',
                    targetRoot: path.relative(this.root, targetRoot) || '.',
                    targets: [],
                    ref: options.ref ?? null
                }
                for (const { dataDir, collection } of affected.values()) {
                    const relative = path.join(dataDir, collection)
                    manifest.targets.push({
                        relative,
                        collection,
                        hadCurrent: await exists(path.join(targetRoot, relative)),
                        shouldInstall: collections.get(collection) === dataDir
                    })
                }
                await this.writeMaterializationManifest(transactionRoot, manifest)
                try {
                    await this.stageMaterializedTree(stageRoot, tree, objects, metadataEntries)
                    await this.rebuildStagedCollections(stageRoot, collections)
                    manifest.phase = 'staged'
                    await this.writeMaterializationManifest(transactionRoot, manifest)
                    manifest.phase = 'swapping'
                    await this.writeMaterializationManifest(transactionRoot, manifest)

                    await this.swapMaterializedTargets(manifest, {
                        transactionRoot,
                        targetRoot,
                        stageRoot,
                        backupRoot
                    })
                    manifest.phase = 'installed'
                    await this.writeMaterializationManifest(transactionRoot, manifest)
                    if (manifest.ref) await this.writeRef(manifest.ref.target)
                    manifest.phase = 'ref-updated'
                    await this.writeMaterializationManifest(transactionRoot, manifest)
                    await this.cleanupMaterialization(transactionRoot)
                } catch (error) {
                    try {
                        await this.rollBackMaterialization(transactionRoot, manifest)
                    } catch (rollbackError) {
                        throw new AggregateError(
                            [error, rollbackError],
                            'Version tree materialization failed and rollback was incomplete'
                        )
                    }
                    throw error
                }
            }
        )
    }

    /**
     * Writes every versioned blob into the staging tree, then reapplies the
     * recorded xattr metadata on top of the files it belongs to.
     * @param {string} stageRoot
     * @param {Map<string, any>} tree
     * @param {Map<string, Buffer>} objects
     * @param {any[]} metadataEntries
     */
    async stageMaterializedTree(stageRoot, tree, objects, metadataEntries) {
        for (const entry of tree.values()) {
            if (!(await this.isVersionedCollection(entry.collection))) continue
            if (entry.kind === 'metadata') continue
            const target = path.join(stageRoot, entry.path)
            assertPathInside(stageRoot, target)
            await writeDurable(target, /** @type {Buffer} */ (objects.get(entry.hash)))
        }
        for (const entry of metadataEntries) {
            const target = await findMaterializedFile(stageRoot, entry)
            if (!target) continue
            await applyXattrBlob(target, /** @type {Buffer} */ (objects.get(entry.hash)))
        }
    }

    /**
     * Indexes are accelerators, so they are rebuilt from the staged documents
     * rather than restored from the commit.
     * @param {string} stageRoot
     * @param {Map<string, string>} collections
     */
    async rebuildStagedCollections(stageRoot, collections) {
        if (collections.size === 0) return
        const engine = new FilesystemEngine(stageRoot, {
            catalogRoot: this.root,
            repositoryGate: false
        })
        for (const collection of collections.keys()) {
            await engine.ensureCollection(collection)
            await engine.rebuildCollection(collection)
        }
    }

    /**
     * Moves each staged target into place, recording the backup phase before
     * displacing an existing tree so recovery can undo a partial swap.
     * @param {MaterializationTransaction} manifest
     * @param {{ transactionRoot: string, targetRoot: string, stageRoot: string, backupRoot: string }} roots
     */
    async swapMaterializedTargets(manifest, roots) {
        const { transactionRoot, targetRoot, stageRoot, backupRoot } = roots
        for (const target of manifest.targets) {
            const current = path.join(targetRoot, target.relative)
            const staged = path.join(stageRoot, target.relative)
            const backup = path.join(backupRoot, target.relative)
            assertPathInside(targetRoot, current)
            assertPathInside(transactionRoot, staged)
            assertPathInside(transactionRoot, backup)
            if (target.hadCurrent) {
                await mkdir(path.dirname(backup), { recursive: true })
                await renameDurable(current, backup)
                manifest.phase = 'backup-moved'
                await this.writeMaterializationManifest(transactionRoot, manifest)
            }
            if (await exists(staged)) {
                await mkdir(path.dirname(current), { recursive: true })
                await renameDurable(staged, current)
            }
        }
    }

    /**
     * @param {string | null} baseId
     * @param {string} oursId
     * @param {string} theirsId
     * @returns {Promise<ThreeWayMergePlan>}
     */
    async planThreeWayMerge(baseId, oursId, theirsId) {
        const [base, ours, theirs] = await Promise.all([
            baseId ? this.readCommitTree(baseId) : new Map(),
            this.readCommitTree(oursId),
            this.readCommitTree(theirsId)
        ])
        const keys = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort()
        /** @type {(DocumentTreeEntry & { deleted?: boolean })[]} */
        const apply = []
        /** @type {FyloMergeConflict[]} */
        const conflicts = []
        for (const key of keys) {
            const baseEntry = base.get(key)
            const oursEntry = ours.get(key)
            const theirsEntry = theirs.get(key)
            const baseHash = baseEntry?.hash ?? null
            const oursHash = oursEntry?.hash ?? null
            const theirsHash = theirsEntry?.hash ?? null
            if (oursHash === theirsHash) continue
            if (baseHash === theirsHash) continue
            if (baseHash === oursHash) {
                if (theirsEntry) apply.push(theirsEntry)
                else {
                    const deletionEntry = oursEntry ?? baseEntry
                    if (deletionEntry) apply.push({ ...deletionEntry, hash: '', deleted: true })
                }
                continue
            }
            const representative = theirsEntry ?? oursEntry ?? baseEntry
            if (!representative) continue
            conflicts.push({
                collection: representative.collection,
                kind: representative.kind,
                id: representative.id,
                path: representative.path,
                baseHash,
                oursHash,
                theirsHash
            })
        }
        return { apply, conflicts }
    }
}

/**
 * Returns the nested map stored at `key`, creating an empty one if absent.
 * Used to group documents into the collection/namespace/bucket hierarchy.
 *
 * @template {Map<any, any>} V
 * @param {Map<string, V>} map
 * @param {string} key
 * @returns {V}
 */
function getOrCreate(map, key) {
    let value = map.get(key)
    if (!value) map.set(key, (value = /** @type {V} */ (new Map())))
    return value
}

/** @param {DocumentTreeEntry} entry @returns {string} */
function treeEntryKey(entry) {
    return `${entry.collection}/${entry.kind}/${path.basename(entry.path)}`
}

/** @param {unknown} value @returns {asserts value is MaterializationTransaction} */
function validateMaterializationManifest(value) {
    const manifest = /** @type {Partial<MaterializationTransaction>} */ (value)
    const phases = new Set([
        'preparing',
        'staged',
        'swapping',
        'backup-moved',
        'installed',
        'ref-updated'
    ])
    if (
        !manifest ||
        manifest.version !== 1 ||
        typeof manifest.phase !== 'string' ||
        !phases.has(manifest.phase) ||
        typeof manifest.targetRoot !== 'string' ||
        path.isAbsolute(manifest.targetRoot) ||
        !Array.isArray(manifest.targets)
    ) {
        throw new Error('Corrupt FYLO materialization transaction manifest')
    }
    for (const target of manifest.targets) assertMaterializationTarget(target)
    if (manifest.ref !== null) assertMaterializationRef(manifest.ref)
}

/**
 * Each target must name a relative path that stays inside the repository.
 * @param {any} target
 */
function assertMaterializationTarget(target) {
    if (
        !target ||
        typeof target.relative !== 'string' ||
        target.relative.length === 0 ||
        path.isAbsolute(target.relative) ||
        path.relative('.', target.relative).startsWith('..') ||
        typeof target.collection !== 'string' ||
        typeof target.hadCurrent !== 'boolean' ||
        typeof target.shouldInstall !== 'boolean'
    ) {
        throw new Error('Corrupt FYLO materialization transaction target')
    }
    validateBranchName(target.collection)
}

/**
 * A recorded ref transition may advance a branch but never rename it, so a
 * recovered materialization cannot move work onto a different branch.
 * @param {any} ref
 */
function assertMaterializationRef(ref) {
    if (!ref || !ref.prior || !ref.target) {
        throw new Error('Corrupt FYLO materialization ref transition')
    }
    validateBranchName(ref.prior.name)
    validateBranchName(ref.target.name)
    if (ref.prior.name !== ref.target.name) {
        throw new Error('FYLO materialization ref transition changes branch identity')
    }
}

/**
 * Fsyncs a directory entry when the host supports it. Windows and a few
 * network filesystems reject directory handles/sync; their atomic rename is
 * still used, and recovery remains deterministic from the manifest.
 * @param {string} target
 */
async function syncDirectory(target) {
    let handle
    try {
        handle = await open(target, 'r')
        await handle.sync()
    } catch (error) {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code
        if (!['ENOENT', 'EPERM', 'EINVAL', 'ENOTSUP', 'EISDIR'].includes(String(code))) throw error
    } finally {
        await handle?.close()
    }
}

/** @param {string} source @param {string} target */
async function renameDurable(source, target) {
    const sourceDirectory = path.dirname(source)
    const targetDirectory = path.dirname(target)
    await mkdir(targetDirectory, { recursive: true })
    await rename(source, target)
    await syncDirectory(sourceDirectory)
    if (targetDirectory !== sourceDirectory) await syncDirectory(targetDirectory)
}

/**
 * @param {FyloVersionedDocumentKind} kind
 * @returns {'docs' | '.deleted' | '.metadata'}
 */
function namespaceForVersionedKind(kind) {
    if (kind === 'active') return 'docs'
    if (kind === 'deleted') return '.deleted'
    return '.metadata'
}

/**
 * @param {string} namespace
 * @returns {FyloVersionedDocumentKind}
 */
function versionedKindForNamespace(namespace) {
    if (namespace === 'docs') return 'active'
    if (namespace === '.deleted') return 'deleted'
    if (namespace === '.metadata') return 'metadata'
    throw new Error(`Unsupported versioned namespace: ${namespace}`)
}

/**
 * @param {string} name
 * @returns {void}
 */
export function validateBranchName(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
        throw new Error('Branch name must be a non-empty string up to 128 characters')
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) {
        throw new Error('Branch name may contain letters, numbers, ".", "_", "-", and "/"')
    }
    if (
        name.includes('..') ||
        name.includes('//') ||
        name.endsWith('/') ||
        name.endsWith('.lock')
    ) {
        throw new Error(`Invalid branch name: ${name}`)
    }
}

/**
 * @param {string} commitId
 * @returns {Promise<void>}
 */
async function validateCommitId(commitId) {
    if (typeof commitId !== 'string' || !(await TTID.isTTID(commitId))) {
        throw new Error(`Invalid commit id: ${commitId}`)
    }
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listJsonFiles(root) {
    return (await listFiles(root)).filter((file) => file.endsWith('.json'))
}

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function listFiles(root) {
    /** @type {string[]} */
    const files = []
    /**
     * @param {string} directory
     * @param {string} [prefix]
     * @returns {Promise<void>}
     */
    async function walk(directory, prefix = '') {
        const entries = await readdir(directory, { withFileTypes: true })
        for (const entry of entries) {
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name
            const full = path.join(directory, entry.name)
            if (entry.isSymbolicLink()) {
                throw new Error(`Version storage path contains a symbolic link: ${full}`)
            }
            if (entry.isDirectory()) {
                await walk(full, relative)
                continue
            }
            if (entry.isFile() && !isDurableWriteScratchPath(entry.name)) files.push(relative)
        }
    }
    await walk(root)
    return files
}

/**
 * @param {string} storageRoot
 * @param {string} namespaceRoot
 * @param {string} id
 * @returns {Promise<string | null>}
 */
async function findVersionedFile(storageRoot, namespaceRoot, id) {
    if (!(await exists(namespaceRoot))) return null
    await assertSafeStoragePath(storageRoot, namespaceRoot, { finalType: 'directory' })
    const matches = []
    for (const entry of await readdir(namespaceRoot, { withFileTypes: true })) {
        if (entry.isFile() && isDurableWriteScratchPath(entry.name)) continue
        if (rawFileId(entry.name) !== id) continue
        const target = path.join(namespaceRoot, entry.name)
        if (entry.isSymbolicLink() || !entry.isFile()) {
            throw new Error(`Version document target is not a regular, non-link file: ${target}`)
        }
        await assertSafeStoragePath(storageRoot, target, { finalType: 'file' })
        matches.push(target)
    }
    if (matches.length > 1) throw new Error(`Multiple versioned files found for document ID: ${id}`)
    return matches[0] ?? null
}

/**
 * @param {string} sourceRoot
 * @param {string} targetRoot
 * @returns {Promise<void>}
 */
async function copyCollections(sourceRoot, targetRoot) {
    for (const dataDir of DATA_DIRS) {
        const source = path.join(sourceRoot, dataDir)
        const target = path.join(targetRoot, dataDir)
        await rm(target, { recursive: true, force: true })
        try {
            const sourceStats = await stat(source)
            if (!sourceStats.isDirectory()) continue
            await assertSafeStoragePath(sourceRoot, source, { finalType: 'directory' })
            await listFiles(source)
            await assertSafeStoragePath(targetRoot, target, {
                allowMissingFinal: true,
                createParentDirectories: true,
                finalType: 'directory'
            })
            await cp(source, target, { recursive: true, preserveTimestamps: true })
        } catch (error) {
            if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
        }
    }
}

/**
 * @param {Map<string, DocumentTreeEntry>} left
 * @param {Map<string, DocumentTreeEntry>} right
 * @returns {FyloTreeChange[]}
 */
function diffTrees(left, right) {
    const keys = [...new Set([...left.keys(), ...right.keys()])].sort()
    /** @type {FyloTreeChange[]} */
    const changes = []
    for (const key of keys) {
        const leftEntry = left.get(key)
        const rightEntry = right.get(key)
        if (!leftEntry && rightEntry) {
            changes.push({ ...rightEntry, status: 'added' })
            continue
        }
        if (leftEntry && !rightEntry) {
            changes.push({ ...leftEntry, status: 'deleted' })
            continue
        }
        if (leftEntry && rightEntry && leftEntry.hash !== rightEntry.hash) {
            changes.push({ ...rightEntry, status: 'modified' })
        }
    }
    return changes
}

/**
 * @typedef {object} ThreeWayMergePlan
 * @property {(DocumentTreeEntry & { deleted?: boolean })[]} apply
 * @property {FyloMergeConflict[]} conflicts
 */

/**
 * @param {string} branch
 * @param {string} source
 * @param {string | null} base
 * @param {string | null} head
 * @param {FyloMergeMode} mode
 * @param {boolean} merged
 * @returns {FyloMergeResult}
 */
function mergeResult(branch, source, base, head, mode, merged) {
    return {
        branch,
        source,
        base,
        head,
        mode,
        merged,
        parents: head && head !== source ? [head, source] : [source],
        commit: undefined,
        applied: 0,
        conflicts: []
    }
}

/**
 * @param {FyloTreeChange[]} changes
 * @returns {{ added: number, modified: number, deleted: number, total: number }}
 */
function countChanges(changes) {
    const counts = { added: 0, modified: 0, deleted: 0, total: changes.length }
    for (const change of changes) counts[change.status]++
    return counts
}

/**
 * @typedef {object} DocumentTreeEntry
 * @property {string} collection
 * @property {FyloVersionedDocumentKind} kind
 * @property {string} id
 * @property {string} path
 * @property {string} hash
 */

/**
 * @param {string} root
 * @param {(collection: string) => Promise<boolean>} isVersioned
 * @returns {Promise<Map<string, DocumentTreeEntry>>}
 */
async function readDocumentTree(root, isVersioned) {
    const entries = new Map()
    if (!root) return entries
    for (const dataDir of DATA_DIRS) {
        const collectionsRoot = path.join(root, dataDir)
        if (!(await exists(collectionsRoot))) continue
        await assertSafeStoragePath(root, collectionsRoot, { finalType: 'directory' })
        for (const collectionEntry of await readdir(collectionsRoot, { withFileTypes: true })) {
            if (collectionEntry.isSymbolicLink()) {
                throw new Error(
                    `Version storage path contains a symbolic link: ${path.join(collectionsRoot, collectionEntry.name)}`
                )
            }
            if (!collectionEntry.isDirectory()) continue
            const collection = collectionEntry.name
            if (!(await isVersioned(collection))) continue
            const collectionRoot = path.join(collectionsRoot, collection)
            await readDocumentNamespace(
                entries,
                root,
                collectionRoot,
                collection,
                'docs',
                'active',
                dataDir
            )
            await readDocumentNamespace(
                entries,
                root,
                collectionRoot,
                collection,
                '.deleted',
                'deleted',
                dataDir
            )
            for (const entry of await collectXattrEntries(
                root,
                collectionRoot,
                collection,
                dataDir
            )) {
                entries.set(`${collection}/metadata/${entry.id}.json`, {
                    collection,
                    kind: 'metadata',
                    id: entry.id,
                    path: entry.path,
                    hash: createHash('sha256').update(entry.content).digest('hex')
                })
            }
        }
    }
    return entries
}

/**
 * @param {Map<string, DocumentTreeEntry>} entries
 * @param {string} storageRoot
 * @param {string} collectionRoot
 * @param {string} collection
 * @param {string} namespace
 * @param {FyloVersionedDocumentKind} kind
 * @param {string} dataDir Top-level namespace dir (.collections or .buckets)
 * @returns {Promise<void>}
 */
async function readDocumentNamespace(
    entries,
    storageRoot,
    collectionRoot,
    collection,
    namespace,
    kind,
    dataDir = COLLECTIONS_DIR
) {
    const namespaceRoot = path.join(collectionRoot, namespace)
    if (!(await exists(namespaceRoot))) return
    await assertSafeStoragePath(storageRoot, namespaceRoot, { finalType: 'directory' })
    for (const file of await listFiles(namespaceRoot)) {
        const filename = path.basename(file)
        const id = rawFileId(filename)
        if (!id || !(await TTID.isTTID(id))) continue
        const relativePath = path.join(dataDir, collection, namespace, file)
        const target = path.join(namespaceRoot, file)
        await assertSafeStoragePath(storageRoot, target, { finalType: 'file' })
        const hash = await hashFile(target)
        entries.set(`${collection}/${kind}/${filename}`, {
            collection,
            kind,
            id,
            path: relativePath,
            hash
        })
    }
}

/**
 * Canonical metadata blob derived from a file's `user.fylo.*` xattrs:
 * name-sorted, base64 values, one JSON line. Returns null when the file has
 * no fylo xattrs or vanished mid-scan (a concurrent move; the next commit
 * captures the settled state).
 *
 * @param {string} target
 * @returns {Buffer | null}
 */
function xattrBlobForFile(target) {
    /** @type {Record<string, string>} */
    const xattrs = {}
    try {
        const names = listXattr(target)
            .filter((name) => name.startsWith(FYLO_XATTR_PREFIX) && name !== CHECKSUM_XATTR)
            .sort()
        for (const name of names) {
            const value = getXattr(target, name)
            if (value !== null) xattrs[name] = Buffer.from(value).toString('base64')
        }
    } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null
        throw err
    }
    if (Object.keys(xattrs).length === 0) return null
    return Buffer.from(`${JSON.stringify({ version: 2, xattrs })}\n`, 'utf8')
}

/**
 * Applies a committed metadata blob back onto a file as xattrs. Legacy
 * `{version:1,key}` blobs (the pre-xattr sidecar format) map to the key
 * xattr, so restoring old commits migrates them in place.
 *
 * @param {string} target
 * @param {Buffer} content
 * @returns {Promise<void>}
 */
async function applyXattrBlob(target, content) {
    const parsed = parseXattrBlob(content)
    if (parsed.version === 1 && typeof parsed.key === 'string') {
        setXattr(target, `${FYLO_XATTR_PREFIX}key`, parsed.key)
        return
    }
    if (parsed.version !== 2) throw new Error('Corrupt version metadata object')
    for (const [name, encoded] of Object.entries(parsed.xattrs)) {
        setXattr(target, name, Buffer.from(encoded, 'base64'))
    }
    await restoreAccessDescriptor(target, await readAccessDescriptor(target))
}

/**
 * Parses and validates a committed metadata object before any working-tree
 * mutation. Unknown versions, malformed xattr maps, foreign namespaces, and
 * non-canonical base64 are corruption rather than best-effort input.
 * @param {Buffer} content
 * @returns {{ version: 1, key: string } | { version: 2, xattrs: Record<string, string> }}
 */
function parseXattrBlob(content) {
    const parsed = /** @type {{ version?: unknown, key?: unknown, xattrs?: unknown }} */ (
        JSON.parse(content.toString('utf8'))
    )
    if (parsed.version === 1 && typeof parsed.key === 'string') {
        return { version: 1, key: parsed.key }
    }
    if (
        parsed.version !== 2 ||
        !parsed.xattrs ||
        typeof parsed.xattrs !== 'object' ||
        Array.isArray(parsed.xattrs)
    ) {
        throw new Error('Corrupt version metadata object: invalid xattr manifest')
    }
    /** @type {Record<string, string>} */
    const xattrs = {}
    for (const [name, encoded] of Object.entries(parsed.xattrs)) {
        if (!name.startsWith(FYLO_XATTR_PREFIX) || typeof encoded !== 'string') {
            throw new Error('Corrupt version metadata object: invalid xattr entry')
        }
        const decoded = Buffer.from(encoded, 'base64')
        if (decoded.toString('base64') !== encoded) {
            throw new Error('Corrupt version metadata object: invalid base64 value')
        }
        xattrs[name] = encoded
    }
    return { version: 2, xattrs }
}

/**
 * Collects the xattr-derived metadata entries for every document and
 * tombstone in a collection working tree.
 *
 * @param {string} storageRoot
 * @param {string} collectionRoot
 * @param {string} collection
 * @returns {Promise<Array<{ id: string, path: string, content: Buffer }>>}
 */
async function collectXattrEntries(
    storageRoot,
    collectionRoot,
    collection,
    dataDir = COLLECTIONS_DIR
) {
    /** @type {Array<{ id: string, path: string, content: Buffer }>} */
    const collected = []
    for (const namespace of ['docs', '.deleted']) {
        const namespaceRoot = path.join(collectionRoot, namespace)
        if (!(await exists(namespaceRoot))) continue
        await assertSafeStoragePath(storageRoot, namespaceRoot, { finalType: 'directory' })
        for (const file of await listFiles(namespaceRoot)) {
            const filename = path.basename(file)
            const id = rawFileId(filename)
            if (!id || !(await TTID.isTTID(id))) continue
            const target = path.join(namespaceRoot, file)
            await assertSafeStoragePath(storageRoot, target, { finalType: 'file' })
            const content = xattrBlobForFile(target)
            if (!content) continue
            collected.push({
                id,
                path: path.join(dataDir, collection, '.metadata', shardOf(id), `${id}.json`),
                content
            })
        }
    }
    return collected
}

/**
 * Locates the materialized document or tombstone file a metadata entry
 * belongs to, or null when the file is absent from both namespaces.
 *
 * @param {string} targetRoot
 * @param {DocumentTreeEntry} entry
 * @returns {Promise<string | null>}
 */
async function findMaterializedFile(targetRoot, entry) {
    const bucket = shardOf(entry.id)
    // entry.path already encodes the namespace dir (.collections or .buckets).
    const dataDir = entry.path.split(path.sep)[0] || COLLECTIONS_DIR
    for (const namespace of ['docs', '.deleted']) {
        const found = await findVersionedFile(
            targetRoot,
            path.join(targetRoot, dataDir, entry.collection, namespace, bucket),
            entry.id
        )
        if (found) return found
    }
    return null
}

/**
 * @param {string} target
 * @returns {Promise<string>}
 */
async function hashFile(target) {
    return createHash('sha256')
        .update(await readFile(target))
        .digest('hex')
}

/**
 * @param {string} target
 * @returns {Promise<boolean>}
 */
async function exists(target) {
    try {
        await stat(target)
        return true
    } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return false
        throw error
    }
}

/**
 * @param {string} root
 * @param {string} target
 * @returns {void}
 */
function assertPathInside(root, target) {
    const relative = path.relative(path.resolve(root), path.resolve(target))
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return
    throw new Error(`Path escapes FYLO repository metadata: ${target}`)
}
