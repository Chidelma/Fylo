import { dlopen, FFIType, ptr, read } from 'bun:ffi'
import {
    closeSync,
    constants,
    fchmodSync,
    fstatSync,
    fsyncSync,
    ftruncateSync,
    futimesSync,
    openSync,
    readSync,
    realpathSync,
    writeSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    windowsCloseDescriptor,
    windowsOpenDirectoryNoFollow,
    windowsOpenFileAtRoot,
    windowsOpenFileAtRootStrict,
    windowsOpenFileAtRootWithFlags,
    windowsOpenRenameableFileAtRootWithFlags,
    windowsRenameAtRoots,
    windowsRenameOpenFileAtRoot,
    windowsReadAllDescriptor,
    windowsReadDescriptor,
    windowsSetDescriptorMode,
    windowsSetDescriptorTimes,
    windowsStatDescriptor,
    windowsSyncDescriptor,
    windowsTruncateDescriptor,
    windowsTryAcquireProcessFileLock,
    windowsUnlinkAtRoot,
    windowsWriteDescriptor
} from './windows-secure-open.js'

const encoder = new TextEncoder()

/** @param {any} descriptor */
export function closeSecureDescriptor(descriptor) {
    if (descriptor === null || descriptor === undefined) return
    if (process.platform === 'win32') return windowsCloseDescriptor(descriptor)
    closeSync(descriptor)
}

/** @param {any} descriptor */
export function statSecureDescriptor(descriptor) {
    return process.platform === 'win32' ? windowsStatDescriptor(descriptor) : fstatSync(descriptor)
}

/** @param {any} descriptor @param {Uint8Array} buffer @param {number} offset @param {number} length @param {number} position */
export function readSecureDescriptor(descriptor, buffer, offset, length, position) {
    return process.platform === 'win32'
        ? windowsReadDescriptor(descriptor, buffer, offset, length, position)
        : readSync(descriptor, buffer, offset, length, position)
}

/** @param {any} descriptor @param {Uint8Array} buffer @param {number} offset @param {number} length @param {number} position */
export function writeSecureDescriptor(descriptor, buffer, offset, length, position) {
    return process.platform === 'win32'
        ? windowsWriteDescriptor(descriptor, buffer, offset, length, position)
        : writeSync(descriptor, buffer, offset, length, position)
}

/** @param {any} descriptor */
export function syncSecureDescriptor(descriptor) {
    return process.platform === 'win32' ? windowsSyncDescriptor(descriptor) : fsyncSync(descriptor)
}

/** @param {any} descriptor @param {number} length */
export function truncateSecureDescriptor(descriptor, length) {
    return process.platform === 'win32'
        ? windowsTruncateDescriptor(descriptor, length)
        : ftruncateSync(descriptor, length)
}

/** @param {any} descriptor @param {number} mode */
export function chmodSecureDescriptor(descriptor, mode) {
    return process.platform === 'win32'
        ? windowsSetDescriptorMode(descriptor, mode)
        : fchmodSync(descriptor, mode)
}

/** @param {any} descriptor @param {number | Date} atime @param {number | Date} mtime */
export function timesSecureDescriptor(descriptor, atime, mtime) {
    return process.platform === 'win32'
        ? windowsSetDescriptorTimes(descriptor, atime, mtime)
        : futimesSync(descriptor, atime, mtime)
}

/** @param {any} descriptor @param {number} maxBytes */
export function readAllSecureDescriptor(descriptor, maxBytes) {
    if (process.platform === 'win32') return windowsReadAllDescriptor(descriptor, maxBytes)
    const size = fstatSync(descriptor).size
    if (size > maxBytes) throw new Error(`Secure read exceeds ${maxBytes} bytes`)
    const result = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
        const count = readSync(descriptor, result, offset, size - offset, offset)
        if (count === 0) break
        offset += count
    }
    return result.subarray(0, offset)
}

/** @param {NodeJS.Platform} platform @param {string} architecture */
export function libcCandidates(platform, architecture) {
    if (platform === 'darwin') return ['libSystem.B.dylib']
    if (platform !== 'linux') return []
    const muslArchitecture =
        {
            x64: 'x86_64',
            arm64: 'aarch64',
            arm: 'armhf'
        }[architecture] ?? architecture
    return [
        'libc.so.6',
        `libc.musl-${muslArchitecture}.so.1`,
        `/lib/ld-musl-${muslArchitecture}.so.1`
    ]
}

/** @param {NodeJS.Platform} platform */
function symbolDefinitions(platform) {
    return {
        openat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32],
            returns: FFIType.i32
        },
        flock: {
            args: [FFIType.i32, FFIType.i32],
            returns: FFIType.i32
        },
        renameat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
            returns: FFIType.i32
        },
        unlinkat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32],
            returns: FFIType.i32
        },
        mkdirat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.u32],
            returns: FFIType.i32
        },
        ...(platform === 'darwin'
            ? { __error: { args: [], returns: FFIType.ptr } }
            : { __errno_location: { args: [], returns: FFIType.ptr } })
    }
}

/**
 * Takes a kernel-owned, non-blocking exclusive lock on a persistent sentinel.
 * The directory entry intentionally remains after release: ownership lives in
 * the open-file description, so SIGKILL cannot strand the claim.
 *
 * @param {string} target
 * @returns {(() => void) | null}
 */
export function tryAcquireProcessFileLock(target) {
    if (process.platform === 'win32') return windowsTryAcquireProcessFileLock(target)
    const loaded = secureOpenSymbols()
    const flock = loaded?.flock
    if (!flock) throw new Error('Crash-safe process file locks are unavailable on this platform')
    const descriptor = openSync(
        target,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600
    )
    const LOCK_EX = 2
    const LOCK_NB = 4
    const LOCK_UN = 8
    if (flock(descriptor, LOCK_EX | LOCK_NB) !== 0) {
        const code = errno(loaded)
        closeSync(descriptor)
        if (code === os.constants.errno.EAGAIN || code === os.constants.errno.EWOULDBLOCK) {
            return null
        }
        throw openFailure(target, false, loaded)
    }
    let released = false
    return () => {
        if (released) return
        released = true
        try {
            flock(descriptor, LOCK_UN)
        } finally {
            closeSync(descriptor)
        }
    }
}

/**
 * Resolve the platform C library without making module import depend on a
 * particular libc distribution. Returning null keeps traversal fail-closed.
 *
 * @param {typeof dlopen} openLibrary
 * @param {string[]} candidates
 * @param {NodeJS.Platform} [platform]
 * @returns {Record<string, Function> | null}
 */
export function loadSecureOpenSymbols(
    openLibrary = dlopen,
    candidates = libcCandidates(process.platform, process.arch),
    platform = process.platform
) {
    for (const candidate of candidates) {
        try {
            return /** @type {any} */ (openLibrary(candidate, symbolDefinitions(platform))).symbols
        } catch {
            // Try the next ABI-compatible libc name. Absence is handled by callers.
        }
    }
    return null
}

/** @type {Record<string, Function> | null | undefined} */
let symbols

function secureOpenSymbols() {
    if (symbols === undefined) symbols = loadSecureOpenSymbols()
    return symbols
}

/** @param {string} value */
function cstr(value) {
    return encoder.encode(`${value}\0`)
}

/** @param {Record<string, Function>} symbols @returns {number} */
function errno(symbols) {
    const location =
        process.platform === 'darwin'
            ? /** @type {any} */ (symbols).__error()
            : /** @type {any} */ (symbols).__errno_location()
    return read.i32(location, 0)
}

/**
 * @param {string} target
 * @param {boolean} allowUnsafe
 * @param {Record<string, Function>} symbols
 */
function openFailure(target, allowUnsafe, symbols) {
    const code = errno(symbols)
    const name = Object.entries(os.constants.errno).find(([, value]) => value === code)?.[0]
    if (allowUnsafe && (name === 'ENOENT' || name === 'ELOOP' || name === 'ENOTDIR')) return null
    const error = /** @type {NodeJS.ErrnoException} */ (
        new Error(`Secure open failed for ${target}: ${name ?? `errno ${code}`}`)
    )
    error.code = name
    error.errno = code
    throw error
}

/**
 * Open a regular-file candidate by walking from an already-open root directory.
 * Every component uses O_NOFOLLOW, so renaming or replacing any parent cannot
 * redirect the final descriptor outside the root inode.
 *
 * @param {string} target
 * @returns {any} caller-owned secure descriptor for the pinned directory
 */
export function openDirectoryNoFollow(target) {
    if (process.platform === 'win32') return windowsOpenDirectoryNoFollow(target)
    const symbols = secureOpenSymbols()
    const openat = symbols?.openat
    if (!openat) throw new Error('Secure descriptor traversal is unavailable on this platform')
    const parent = realpathSync(path.dirname(path.resolve(target)))
    const resolved = path.join(parent, path.basename(target))
    const parsed = path.parse(resolved)
    const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
    let current = openSync(parsed.root, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
        for (const part of parts) {
            const next = openat(
                current,
                ptr(cstr(part)),
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
                0
            )
            if (next < 0) openFailure(target, false, symbols)
            closeSync(current)
            current = next
        }
        const result = current
        current = -1
        return result
    } finally {
        if (current >= 0) closeSync(current)
    }
}

/**
 * @param {number} rootFd pinned descriptor for the FYLO root directory
 * @param {string} relative
 * @returns {number | null}
 */
export function openFileAtRoot(rootFd, relative) {
    if (process.platform === 'win32') return windowsOpenFileAtRoot(rootFd, relative)
    const symbols = secureOpenSymbols()
    const openat = symbols?.openat
    if (!openat) throw new Error('Secure descriptor traversal is unavailable on this platform')
    const parts = relative.split(path.sep)
    if (!relative || parts.some((part) => !part || part === '.' || part === '..')) return null

    let current = rootFd
    let ownsCurrent = false
    try {
        for (let index = 0; index < parts.length; index += 1) {
            const directory = index < parts.length - 1
            const flags =
                constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0)
            const next = openat(current, ptr(cstr(parts[index])), flags, 0)
            if (next < 0) return openFailure(relative, true, symbols)
            if (ownsCurrent) closeSync(current)
            current = next
            ownsCurrent = true
        }
        const result = current
        ownsCurrent = false
        return result
    } finally {
        if (ownsCurrent) closeSync(current)
    }
}

/**
 * Strict variant for security metadata: only an actually missing component is
 * returned as null. Symlinks, reparse-like non-directories, and traversal
 * errors fail closed.
 * @param {number} rootFd
 * @param {string} relative
 * @returns {number | null}
 */
export function openFileAtRootStrict(rootFd, relative) {
    if (process.platform === 'win32') return windowsOpenFileAtRootStrict(rootFd, relative)
    const loaded = secureOpenSymbols()
    const openat = loaded?.openat
    if (!openat) throw new Error('Secure descriptor traversal is unavailable on this platform')
    const parts = relative.split(path.sep)
    if (!relative || parts.some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`Unsafe rooted path: ${relative}`)
    }
    let current = rootFd
    let ownsCurrent = false
    try {
        for (let index = 0; index < parts.length; index += 1) {
            const directory = index < parts.length - 1
            const flags =
                constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0)
            const next = openat(current, ptr(cstr(parts[index])), flags, 0)
            if (next < 0) {
                const code = errno(loaded)
                if (code === os.constants.errno.ENOENT) return null
                openFailure(relative, false, loaded)
            }
            if (ownsCurrent) closeSync(current)
            current = next
            ownsCurrent = true
        }
        const result = current
        ownsCurrent = false
        return result
    } finally {
        if (ownsCurrent) closeSync(current)
    }
}

/** @param {string} relative */
function safeParts(relative) {
    const parts = relative.split(path.sep)
    if (!relative || parts.some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`Unsafe rooted path: ${relative}`)
    }
    return parts
}

/**
 * Pins a file's parent directory below an already-pinned root. Each component
 * is opened with O_NOFOLLOW; optional creation uses mkdirat on the pinned
 * parent and therefore cannot be redirected by a concurrent symlink swap.
 *
 * @param {number} rootFd
 * @param {string} relative
 * @param {boolean} [create]
 */
export function openParentAtRoot(rootFd, relative, create = false) {
    const loaded = secureOpenSymbols()
    const openat = loaded?.openat
    const mkdirat = loaded?.mkdirat
    if (!openat || !mkdirat) {
        throw new Error('Secure descriptor traversal is unavailable on this platform')
    }
    const parts = safeParts(relative)
    const name = /** @type {string} */ (parts.pop())
    let current = openat(
        rootFd,
        ptr(cstr('.')),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
        0
    )
    if (current < 0) openFailure(relative, false, loaded)
    try {
        for (const part of parts) {
            let next = openat(
                current,
                ptr(cstr(part)),
                constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
                0
            )
            if (next < 0 && create && errno(loaded) === os.constants.errno.ENOENT) {
                const made = mkdirat(current, ptr(cstr(part)), 0o700)
                if (made !== 0 && errno(loaded) !== os.constants.errno.EEXIST) {
                    openFailure(relative, false, loaded)
                }
                next = openat(
                    current,
                    ptr(cstr(part)),
                    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
                    0
                )
            }
            if (next < 0) openFailure(relative, false, loaded)
            closeSync(current)
            current = next
        }
        const result = { fd: current, name }
        current = -1
        return result
    } finally {
        if (current >= 0) closeSync(current)
    }
}

/** @param {number} rootFd @param {string} relative @param {number} flags @param {number} mode */
export function openFileAtRootWithFlags(rootFd, relative, flags, mode = 0o600) {
    if (process.platform === 'win32') {
        return windowsOpenFileAtRootWithFlags(rootFd, relative, flags, mode)
    }
    const loaded = secureOpenSymbols()
    const openat = loaded?.openat
    if (!openat) throw new Error('Secure descriptor traversal is unavailable on this platform')
    const parent = openParentAtRoot(rootFd, relative, Boolean(flags & constants.O_CREAT))
    try {
        const descriptor = openat(
            parent.fd,
            ptr(cstr(parent.name)),
            flags | constants.O_NOFOLLOW,
            mode
        )
        if (descriptor < 0) openFailure(relative, false, loaded)
        if (flags & constants.O_CREAT) fchmodSync(descriptor, mode)
        return descriptor
    } finally {
        closeSync(parent.fd)
    }
}

/** @param {number} rootFd @param {string} relative @param {number} flags @param {number} mode */
export function openRenameableFileAtRootWithFlags(rootFd, relative, flags, mode = 0o600) {
    if (process.platform === 'win32') {
        return windowsOpenRenameableFileAtRootWithFlags(rootFd, relative, flags, mode)
    }
    return openFileAtRootWithFlags(rootFd, relative, flags, mode)
}

/** @param {number} rootFd @param {string} relative @param {boolean} [directory] */
export function unlinkAtRoot(rootFd, relative, directory = false) {
    if (process.platform === 'win32') return windowsUnlinkAtRoot(rootFd, relative, directory)
    const loaded = secureOpenSymbols()
    const unlinkat = loaded?.unlinkat
    if (!unlinkat) throw new Error('Secure rooted unlink is unavailable on this platform')
    let parent
    try {
        parent = openParentAtRoot(rootFd, relative)
    } catch (error) {
        // A missing parent directory means the entry is already absent, which
        // is the same outcome `unlinkat` reports as ENOENT below. Records are
        // sharded by their trailing creation characters, so a directory may
        // never have been created at all; the previous layout put everything
        // written in a four-month window in one directory, which always
        // existed and hid this case.
        if (/** @type {NodeJS.ErrnoException} */ (error)?.code === 'ENOENT') return
        throw error
    }
    try {
        const AT_REMOVEDIR = process.platform === 'darwin' ? 0x80 : 0x200
        const result = unlinkat(parent.fd, ptr(cstr(parent.name)), directory ? AT_REMOVEDIR : 0)
        if (result !== 0 && errno(loaded) !== os.constants.errno.ENOENT) {
            openFailure(relative, false, loaded)
        }
        fsyncSync(parent.fd)
    } finally {
        closeSync(parent.fd)
    }
}

/**
 * @param {number} sourceRootFd
 * @param {string} sourceRelative
 * @param {number} targetRootFd
 * @param {string} targetRelative
 */
export function renameAtRoots(sourceRootFd, sourceRelative, targetRootFd, targetRelative) {
    if (process.platform === 'win32') {
        return windowsRenameAtRoots(sourceRootFd, sourceRelative, targetRootFd, targetRelative)
    }
    const loaded = secureOpenSymbols()
    const renameat = loaded?.renameat
    if (!renameat) throw new Error('Secure rooted rename is unavailable on this platform')
    const source = openParentAtRoot(sourceRootFd, sourceRelative)
    const target = openParentAtRoot(targetRootFd, targetRelative, true)
    try {
        if (renameat(source.fd, ptr(cstr(source.name)), target.fd, ptr(cstr(target.name))) !== 0) {
            openFailure(sourceRelative, false, loaded)
        }
        fsyncSync(target.fd)
        if (source.fd !== target.fd) fsyncSync(source.fd)
    } finally {
        closeSync(source.fd)
        closeSync(target.fd)
    }
}

/**
 * Renames a file while its already-open descriptor remains pinned. Windows
 * uses that handle directly so security software cannot race a close/reopen
 * between the durable write and FILE_RENAME_INFORMATION.
 * @param {number} sourceRootFd
 * @param {string} sourceRelative
 * @param {number} sourceDescriptor
 * @param {number} targetRootFd
 * @param {string} targetRelative
 */
export function renameOpenFileAtRoot(
    sourceRootFd,
    sourceRelative,
    sourceDescriptor,
    targetRootFd,
    targetRelative
) {
    if (process.platform === 'win32') {
        return windowsRenameOpenFileAtRoot(sourceDescriptor, targetRootFd, targetRelative)
    }
    return renameAtRoots(sourceRootFd, sourceRelative, targetRootFd, targetRelative)
}
