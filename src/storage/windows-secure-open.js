import { dlopen, FFIType, ptr, read } from 'bun:ffi'
import { constants } from 'node:fs'
import path from 'node:path'

// Native values are intentionally kept here instead of copied into callers.
// The layouts below are the x64/arm64 Windows SDK layouts; 32-bit Windows is
// rejected because FYLO does not publish a 32-bit executable.
export const WINDOWS_NATIVE_LAYOUT = Object.freeze({
    pointerBytes: 8,
    unicodeStringBytes: 16,
    objectAttributesBytes: 48,
    ioStatusBlockBytes: 16,
    overlappedBytes: 32,
    fileRenameHeaderBytes: 20,
    fileRenameStructBytes: 24
})

export const WINDOWS_NATIVE_CONSTANTS = Object.freeze({
    INVALID_HANDLE_VALUE: -1n,
    LOCKFILE_FAIL_IMMEDIATELY: 0x1,
    LOCKFILE_EXCLUSIVE_LOCK: 0x2,
    ERROR_LOCK_VIOLATION: 33,
    OBJ_CASE_INSENSITIVE: 0x40,
    FILE_SHARE_READ: 0x1,
    FILE_SHARE_WRITE: 0x2,
    FILE_SHARE_DELETE: 0x4,
    FILE_OPEN: 0x1,
    FILE_CREATE: 0x2,
    FILE_OPEN_IF: 0x3,
    FILE_OVERWRITE: 0x4,
    FILE_OVERWRITE_IF: 0x5,
    FILE_DIRECTORY_FILE: 0x1,
    FILE_SYNCHRONOUS_IO_NONALERT: 0x20,
    FILE_NON_DIRECTORY_FILE: 0x40,
    FILE_OPEN_REPARSE_POINT: 0x200000,
    FILE_READ_DATA: 0x1,
    FILE_WRITE_DATA: 0x2,
    FILE_APPEND_DATA: 0x4,
    FILE_READ_ATTRIBUTES: 0x80,
    FILE_WRITE_ATTRIBUTES: 0x100,
    DELETE: 0x10000,
    SYNCHRONIZE: 0x100000,
    FILE_ATTRIBUTE_NORMAL: 0x80,
    FILE_ATTRIBUTE_DIRECTORY: 0x10,
    FILE_ATTRIBUTE_REPARSE_POINT: 0x400,
    FILE_ATTRIBUTE_READONLY: 0x1,
    FILE_FLAG_BACKUP_SEMANTICS: 0x02000000,
    FILE_FLAG_OPEN_REPARSE_POINT: 0x00200000,
    OPEN_EXISTING: 3,
    // FILE_INFO_BY_HANDLE_CLASS (Win32), not the similarly named NT enum.
    FILE_RENAME_INFO: 3,
    FILE_RENAME_INFO_EX: 22,
    FILE_DISPOSITION_INFO_EX: 21,
    FILE_RENAME_FLAG_REPLACE_IF_EXISTS: 0x1,
    FILE_RENAME_FLAG_POSIX_SEMANTICS: 0x2,
    FILE_DISPOSITION_FLAG_DELETE: 0x1,
    FILE_DISPOSITION_FLAG_POSIX_SEMANTICS: 0x2,
    FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE: 0x10,
    FILE_RENAME_INFORMATION: 10,
    STATUS_ACCESS_DENIED: -1073741790,
    STATUS_OBJECT_NAME_NOT_FOUND: -1073741772,
    STATUS_OBJECT_PATH_NOT_FOUND: -1073741766,
    STATUS_NO_SUCH_FILE: -1073741809,
    O_BINARY: 0x8000
})

const WINDOWS_RENAME_RETRY_DELAYS_MS = Object.freeze([10, 20, 40, 80, 160, 320, 640])
const windowsRenameWait = new Int32Array(new SharedArrayBuffer(4))

/** @param {number} delayMs */
function waitForWindowsRename(delayMs) {
    Atomics.wait(windowsRenameWait, 0, 0, delayMs)
}

/**
 * Antivirus and indexing filters can briefly deny an otherwise valid NTFS
 * replacement. Retry only that observed transient status, using the same
 * already-validated handles, and return every other status immediately.
 *
 * @param {() => number} rename
 * @param {(delayMs: number) => void} [wait]
 * @returns {number}
 */
export function retryWindowsRenameAccessDenied(rename, wait = waitForWindowsRename) {
    let status = rename()
    for (const delayMs of WINDOWS_RENAME_RETRY_DELAYS_MS) {
        if (status !== WINDOWS_NATIVE_CONSTANTS.STATUS_ACCESS_DENIED) return status
        wait(delayMs)
        status = rename()
    }
    return status
}

/** @param {number | bigint} value */
function isInvalidHandle(value) {
    const handle = asBigInt(value)
    return (
        handle === 0n || BigInt.asIntN(64, handle) === WINDOWS_NATIVE_CONSTANTS.INVALID_HANDLE_VALUE
    )
}

/** @type {Record<string, Function> | undefined} */
let native

function assertSupportedRuntime() {
    if (process.platform !== 'win32')
        throw new Error('Windows native filesystem APIs are unavailable')
    if (!['x64', 'arm64'].includes(process.arch)) {
        throw new Error(
            `Secure Windows filesystem operations require a 64-bit process (got ${process.arch})`
        )
    }
}

function symbols() {
    assertSupportedRuntime()
    if (native) return native
    const kernel32 = dlopen('kernel32.dll', {
        CreateFileW: {
            args: [
                FFIType.ptr,
                FFIType.u32,
                FFIType.u32,
                FFIType.ptr,
                FFIType.u32,
                FFIType.u32,
                FFIType.ptr
            ],
            returns: FFIType.u64
        },
        // Bun's `ptr` argument converter accepts buffers/pointer objects, not the
        // integer HANDLE values returned by Win32. HANDLEs are pointer-sized
        // unsigned integers on our required 64-bit Windows runtime.
        CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
        LockFileEx: {
            args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
            returns: FFIType.bool
        },
        UnlockFileEx: {
            args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
            returns: FFIType.bool
        },
        GetLastError: { args: [], returns: FFIType.u32 },
        SetFileInformationByHandle: {
            args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
            returns: FFIType.bool
        },
        GetFileInformationByHandle: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.bool },
        GetFileInformationByHandleEx: {
            args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
            returns: FFIType.bool
        },
        ReadFile: {
            args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
            returns: FFIType.bool
        },
        WriteFile: {
            args: [FFIType.u64, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
            returns: FFIType.bool
        },
        SetFilePointerEx: {
            args: [FFIType.u64, FFIType.i64, FFIType.ptr, FFIType.u32],
            returns: FFIType.bool
        },
        SetEndOfFile: { args: [FFIType.u64], returns: FFIType.bool },
        FlushFileBuffers: { args: [FFIType.u64], returns: FFIType.bool },
        SetFileTime: {
            args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr],
            returns: FFIType.bool
        }
    }).symbols
    const ntdll = dlopen('ntdll.dll', {
        NtCreateFile: {
            args: [
                FFIType.ptr,
                FFIType.u32,
                FFIType.ptr,
                FFIType.ptr,
                FFIType.ptr,
                FFIType.u32,
                FFIType.u32,
                FFIType.u32,
                FFIType.u32,
                FFIType.ptr,
                FFIType.u32
            ],
            returns: FFIType.i32
        },
        NtSetInformationFile: {
            args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32],
            returns: FFIType.i32
        },
        RtlNtStatusToDosError: { args: [FFIType.i32], returns: FFIType.u32 }
    }).symbols
    native = { ...kernel32, ...ntdll }
    return native
}

/** @param {number | bigint} value */
function asBigInt(value) {
    return typeof value === 'bigint' ? value : BigInt(value)
}

/** @param {any} descriptor */
function handleForDescriptor(descriptor) {
    if (typeof descriptor === 'object' && descriptor?.__fyloWindowsHandle === true)
        return descriptor.handle
    throw new Error('Secure Windows filesystem operation received a non-native descriptor')
}

/** @param {bigint} handle @param {number} flags @returns {any} */
function descriptorForHandle(handle, flags) {
    return {
        __fyloWindowsHandle: true,
        handle,
        flags,
        closed: false,
        parent: null,
        ownsParent: false,
        name: ''
    }
}

/** @param {any} descriptor */
export function windowsCloseDescriptor(descriptor) {
    if (!descriptor || descriptor.__fyloWindowsHandle !== true || descriptor.closed) return
    descriptor.closed = true
    symbols().CloseHandle(descriptor.handle)
    if (descriptor.ownsParent) windowsCloseDescriptor(descriptor.parent)
}

/** @param {string} value */
function wide(value) {
    return Buffer.from(`${value}\0`, 'utf16le')
}

/** @param {DataView} view @param {number} offset @param {number | bigint} value */
function setPointer(view, offset, value) {
    view.setBigUint64(offset, asBigInt(value), true)
}

/** @param {number} status @param {string} label */
function ntFailure(status, label) {
    const win32 = symbols().RtlNtStatusToDosError(status)
    const error = /** @type {NodeJS.ErrnoException} */ (
        new Error(
            `${label} failed closed (NTSTATUS 0x${(status >>> 0).toString(16)}, Win32 ${win32})`
        )
    )
    error.code = `WIN32_${win32}`
    error.errno = win32
    throw error
}

/** @param {number} status */
function isMissingStatus(status) {
    return /** @type {number[]} */ ([
        WINDOWS_NATIVE_CONSTANTS.STATUS_OBJECT_NAME_NOT_FOUND,
        WINDOWS_NATIVE_CONSTANTS.STATUS_OBJECT_PATH_NOT_FOUND,
        WINDOWS_NATIVE_CONSTANTS.STATUS_NO_SUCH_FILE
    ]).includes(status)
}

/**
 * Translates POSIX open flags into an NT access mask. A directory handle only
 * ever needs read access.
 * @param {{ directory?: boolean, deleteAccess?: boolean }} options
 * @param {number} flags
 * @returns {number}
 */
function ntAccessMask(options, flags) {
    let access =
        WINDOWS_NATIVE_CONSTANTS.FILE_READ_ATTRIBUTES | WINDOWS_NATIVE_CONSTANTS.SYNCHRONIZE
    if (options.directory) access |= WINDOWS_NATIVE_CONSTANTS.FILE_READ_DATA
    else if (flags & constants.O_RDWR) {
        access |=
            WINDOWS_NATIVE_CONSTANTS.FILE_READ_DATA |
            WINDOWS_NATIVE_CONSTANTS.FILE_WRITE_DATA |
            WINDOWS_NATIVE_CONSTANTS.FILE_WRITE_ATTRIBUTES
    } else if (flags & constants.O_WRONLY) {
        access |=
            WINDOWS_NATIVE_CONSTANTS.FILE_WRITE_DATA |
            WINDOWS_NATIVE_CONSTANTS.FILE_WRITE_ATTRIBUTES
    } else access |= WINDOWS_NATIVE_CONSTANTS.FILE_READ_DATA
    if (options.deleteAccess) access |= WINDOWS_NATIVE_CONSTANTS.DELETE
    return access
}

/**
 * `O_EXCL` demands creation, plain create opens-or-creates, and otherwise the
 * file must already exist.
 * @param {{ create?: boolean }} options
 * @param {number} flags
 * @returns {number}
 */
function ntDisposition(options, flags) {
    if (options.create && flags & constants.O_EXCL) return WINDOWS_NATIVE_CONSTANTS.FILE_CREATE
    if (options.create) return WINDOWS_NATIVE_CONSTANTS.FILE_OPEN_IF
    return WINDOWS_NATIVE_CONSTANTS.FILE_OPEN
}

/**
 * Always opens the reparse point itself rather than its target, so a junction
 * cannot redirect a rooted open outside the root.
 * @param {{ directory?: boolean }} options
 * @returns {number}
 */
function ntCreateOptions(options) {
    let createOptions =
        WINDOWS_NATIVE_CONSTANTS.FILE_SYNCHRONOUS_IO_NONALERT |
        WINDOWS_NATIVE_CONSTANTS.FILE_OPEN_REPARSE_POINT
    if (options.directory === true) createOptions |= WINDOWS_NATIVE_CONSTANTS.FILE_DIRECTORY_FILE
    if (options.directory === false) {
        createOptions |= WINDOWS_NATIVE_CONSTANTS.FILE_NON_DIRECTORY_FILE
    }
    return createOptions
}

/** @param {string} name */
function assertSafePathComponent(name) {
    if (
        !name ||
        name === '.' ||
        name === '..' ||
        name.includes('\\') ||
        name.includes('/') ||
        name.includes('\0')
    ) {
        throw new Error(`Unsafe rooted path component: ${name}`)
    }
}

/**
 * Opens one name relative to a pinned directory. FILE_OPEN_REPARSE_POINT is
 * mandatory: a junction or symlink is returned as the reparse object itself,
 * and FILE_DIRECTORY_FILE/NON_DIRECTORY_FILE then rejects it fail-closed.
 * @param {any} parentFd
 * @param {string} name
 * @param {{ directory?: boolean, create?: boolean, flags?: number, mode?: number, deleteAccess?: boolean }} options
 */
function ntOpenRelative(parentFd, name, options = {}) {
    assertSafePathComponent(name)
    const api = symbols()
    const encoded = wide(name)
    const unicode = Buffer.alloc(WINDOWS_NATIVE_LAYOUT.unicodeStringBytes)
    const unicodeView = new DataView(unicode.buffer, unicode.byteOffset, unicode.byteLength)
    const nameBytes = encoded.byteLength - 2
    unicodeView.setUint16(0, nameBytes, true)
    unicodeView.setUint16(2, nameBytes + 2, true)
    setPointer(unicodeView, 8, ptr(encoded))

    const attributes = Buffer.alloc(WINDOWS_NATIVE_LAYOUT.objectAttributesBytes)
    const attributesView = new DataView(
        attributes.buffer,
        attributes.byteOffset,
        attributes.byteLength
    )
    attributesView.setUint32(0, WINDOWS_NATIVE_LAYOUT.objectAttributesBytes, true)
    setPointer(attributesView, 8, handleForDescriptor(parentFd))
    setPointer(attributesView, 16, ptr(unicode))
    attributesView.setUint32(24, WINDOWS_NATIVE_CONSTANTS.OBJ_CASE_INSENSITIVE, true)

    const output = Buffer.alloc(8)
    const io = Buffer.alloc(WINDOWS_NATIVE_LAYOUT.ioStatusBlockBytes)
    const flags = options.flags ?? constants.O_RDONLY
    const access = ntAccessMask(options, flags)
    const disposition = ntDisposition(options, flags)
    const createOptions = ntCreateOptions(options)
    const status = api.NtCreateFile(
        ptr(output),
        access,
        ptr(attributes),
        ptr(io),
        null,
        options.directory
            ? WINDOWS_NATIVE_CONSTANTS.FILE_ATTRIBUTE_DIRECTORY
            : WINDOWS_NATIVE_CONSTANTS.FILE_ATTRIBUTE_NORMAL,
        WINDOWS_NATIVE_CONSTANTS.FILE_SHARE_READ |
            WINDOWS_NATIVE_CONSTANTS.FILE_SHARE_WRITE |
            WINDOWS_NATIVE_CONSTANTS.FILE_SHARE_DELETE,
        disposition,
        createOptions,
        null,
        0
    )
    if (status < 0) return { status, descriptor: -1 }
    const handle = read.u64(ptr(output), 0)
    const info = Buffer.alloc(52)
    if (!api.GetFileInformationByHandle(handle, ptr(info))) {
        api.CloseHandle(handle)
        throw new Error(`Secure handle validation failed (Win32 ${api.GetLastError()})`)
    }
    if (info.readUInt32LE(0) & WINDOWS_NATIVE_CONSTANTS.FILE_ATTRIBUTE_REPARSE_POINT) {
        api.CloseHandle(handle)
        throw new Error(`Secure rooted open rejected a reparse point: ${name}`)
    }
    return { status, descriptor: descriptorForHandle(asBigInt(handle), flags) }
}

/** @param {string} relative */
function safeParts(relative) {
    const parts = relative.split(/[\\/]/)
    if (
        !relative ||
        path.win32.isAbsolute(relative) ||
        parts.some((part) => !part || part === '.' || part === '..')
    ) {
        throw new Error(`Unsafe rooted path: ${relative}`)
    }
    return parts
}

/** @param {number} descriptor */
function syncDescriptor(descriptor) {
    windowsSyncDescriptor(descriptor)
}

/** @param {string} target */
export function windowsTryAcquireProcessFileLock(target) {
    assertSupportedRuntime()
    const parent = windowsOpenDirectoryNoFollow(path.win32.dirname(path.win32.resolve(target)))
    let descriptor
    try {
        let opened = ntOpenRelative(parent, path.win32.basename(target), {
            directory: false,
            create: true,
            flags: constants.O_CREAT | constants.O_RDWR
        })
        // NTFS refuses write access to an ADS when the base file has the
        // read-only attribute. The lock sentinel is persistent, so reopen the
        // existing stream with read access; LockFileEx only requires read or
        // write access and still supplies the same exclusive kernel lock.
        if (opened.status === WINDOWS_NATIVE_CONSTANTS.STATUS_ACCESS_DENIED) {
            opened = ntOpenRelative(parent, path.win32.basename(target), {
                directory: false,
                flags: constants.O_RDONLY
            })
        }
        if (opened.status < 0) ntFailure(opened.status, `Secure lock sentinel open for ${target}`)
        descriptor = opened.descriptor
    } finally {
        windowsCloseDescriptor(parent)
    }
    const overlapped = Buffer.alloc(WINDOWS_NATIVE_LAYOUT.overlappedBytes)
    const api = symbols()
    const handle = handleForDescriptor(descriptor)
    if (
        !api.LockFileEx(
            handle,
            WINDOWS_NATIVE_CONSTANTS.LOCKFILE_EXCLUSIVE_LOCK |
                WINDOWS_NATIVE_CONSTANTS.LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            ptr(overlapped)
        )
    ) {
        const code = api.GetLastError()
        windowsCloseDescriptor(descriptor)
        if (code === WINDOWS_NATIVE_CONSTANTS.ERROR_LOCK_VIOLATION) return null
        throw new Error(`LockFileEx failed for ${target} (Win32 ${code})`)
    }
    let released = false
    return () => {
        if (released) return
        released = true
        try {
            api.UnlockFileEx(handle, 0, 1, 0, ptr(overlapped))
        } finally {
            windowsCloseDescriptor(descriptor)
        }
    }
}

/** @param {string} target */
export function windowsOpenDirectoryNoFollow(target) {
    assertSupportedRuntime()
    const resolved = path.win32.resolve(target)
    const parsed = path.win32.parse(resolved)
    if (!/^[A-Za-z]:\\$/.test(parsed.root)) {
        throw new Error('Secure Windows traversal currently requires a local drive path')
    }
    const api = symbols()
    const rootName = wide(parsed.root)
    const rootHandle = asBigInt(
        api.CreateFileW(
            ptr(rootName),
            WINDOWS_NATIVE_CONSTANTS.FILE_READ_DATA |
                WINDOWS_NATIVE_CONSTANTS.FILE_READ_ATTRIBUTES |
                WINDOWS_NATIVE_CONSTANTS.SYNCHRONIZE,
            WINDOWS_NATIVE_CONSTANTS.FILE_SHARE_READ |
                WINDOWS_NATIVE_CONSTANTS.FILE_SHARE_WRITE |
                WINDOWS_NATIVE_CONSTANTS.FILE_SHARE_DELETE,
            null,
            WINDOWS_NATIVE_CONSTANTS.OPEN_EXISTING,
            WINDOWS_NATIVE_CONSTANTS.FILE_FLAG_BACKUP_SEMANTICS |
                WINDOWS_NATIVE_CONSTANTS.FILE_FLAG_OPEN_REPARSE_POINT,
            null
        )
    )
    if (isInvalidHandle(rootHandle)) {
        throw new Error(`CreateFileW failed for trusted volume root (Win32 ${api.GetLastError()})`)
    }
    /** @type {any} */
    let current = descriptorForHandle(rootHandle, constants.O_RDONLY)
    try {
        const suffix = resolved.slice(parsed.root.length)
        for (const component of safeParts(suffix)) {
            const opened = ntOpenRelative(current, component, { directory: true })
            if (opened.status < 0) ntFailure(opened.status, `Secure directory open for ${target}`)
            windowsCloseDescriptor(current)
            current = opened.descriptor
        }
        const result = current
        current = null
        return result
    } finally {
        windowsCloseDescriptor(current)
    }
}

/** @param {any} rootFd @param {string} relative @param {boolean} strict */
function openAtRoot(rootFd, relative, strict) {
    const parts = safeParts(relative)
    /** @type {any} */
    let current = rootFd
    let ownsCurrent = false
    try {
        for (let index = 0; index < parts.length; index += 1) {
            const opened = ntOpenRelative(
                current,
                parts[index],
                index < parts.length - 1 ? { directory: true } : {}
            )
            if (opened.status < 0) {
                if (isMissingStatus(opened.status)) return null
                if (!strict) return null
                ntFailure(opened.status, `Secure rooted open for ${relative}`)
            }
            if (index === parts.length - 1) {
                opened.descriptor.parent = current
                opened.descriptor.ownsParent = ownsCurrent
                opened.descriptor.name = parts[index]
                ownsCurrent = false
            }
            if (ownsCurrent) windowsCloseDescriptor(current)
            current = opened.descriptor
            ownsCurrent = true
        }
        const result = current
        ownsCurrent = false
        return result
    } finally {
        if (ownsCurrent) windowsCloseDescriptor(current)
    }
}

/** @param {any} rootFd @param {string} relative */
export function windowsOpenFileAtRoot(rootFd, relative) {
    return openAtRoot(rootFd, relative, false)
}

/** @param {any} rootFd @param {string} relative */
export function windowsOpenFileAtRootStrict(rootFd, relative) {
    return openAtRoot(rootFd, relative, true)
}

/** @param {any} rootFd @param {string} relative @param {boolean} create */
function openParent(rootFd, relative, create) {
    const parts = safeParts(relative)
    const name = /** @type {string} */ (parts.pop())
    /** @type {any} */
    let current = rootFd
    let ownsCurrent = false
    try {
        for (const component of parts) {
            const opened = ntOpenRelative(current, component, { directory: true, create })
            if (opened.status < 0)
                ntFailure(opened.status, `Secure rooted parent open for ${relative}`)
            if (ownsCurrent) windowsCloseDescriptor(current)
            current = opened.descriptor
            ownsCurrent = true
        }
        return { fd: current, ownsFd: ownsCurrent, name }
    } catch (error) {
        if (ownsCurrent) windowsCloseDescriptor(current)
        throw error
    }
}

/** @param {any} rootFd @param {string} relative @param {number} flags @param {number} mode @param {boolean} deleteAccess */
function openFileAtRootWithFlags(rootFd, relative, flags, mode, deleteAccess) {
    const parent = openParent(rootFd, relative, Boolean(flags & constants.O_CREAT))
    let transferredParent = false
    try {
        const opened = ntOpenRelative(parent.fd, parent.name, {
            directory: false,
            flags,
            create: Boolean(flags & constants.O_CREAT),
            mode,
            deleteAccess
        })
        if (opened.status < 0) ntFailure(opened.status, `Secure rooted file open for ${relative}`)
        opened.descriptor.parent = parent.fd
        opened.descriptor.ownsParent = parent.ownsFd
        opened.descriptor.name = parent.name
        transferredParent = parent.ownsFd
        return opened.descriptor
    } finally {
        if (parent.ownsFd && !transferredParent) windowsCloseDescriptor(parent.fd)
    }
}

/** @param {any} rootFd @param {string} relative @param {number} flags @param {number} mode */
export function windowsOpenFileAtRootWithFlags(rootFd, relative, flags, mode = 0o600) {
    return openFileAtRootWithFlags(rootFd, relative, flags, mode, false)
}

/** @param {any} rootFd @param {string} relative @param {number} flags @param {number} mode */
export function windowsOpenRenameableFileAtRootWithFlags(rootFd, relative, flags, mode = 0o600) {
    return openFileAtRootWithFlags(rootFd, relative, flags, mode, true)
}

/** @param {any} rootFd @param {string} relative @param {boolean} directory */
/**
 * Whether a secure-open failure means the path simply is not there.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isMissingError(error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error)?.code
    if (code === 'ENOENT') return true
    const message = error instanceof Error ? error.message : ''
    // STATUS_OBJECT_NAME_NOT_FOUND / STATUS_OBJECT_PATH_NOT_FOUND.
    return message.includes('0xc0000034') || message.includes('0xc000003a')
}

export function windowsUnlinkAtRoot(rootFd, relative, directory = false) {
    let parent
    try {
        parent = openParent(rootFd, relative, false)
    } catch (error) {
        // A missing parent directory means the entry is already absent, the
        // same outcome `isMissingStatus` handles for the entry itself below.
        // Records shard by their trailing creation characters, so a shard
        // directory may never have been created; the previous layout put
        // everything written in a four-month window in one directory, which
        // always existed and hid this case.
        if (isMissingError(error)) return
        throw error
    }
    let descriptor = null
    try {
        const opened = ntOpenRelative(parent.fd, parent.name, { directory, deleteAccess: true })
        if (isMissingStatus(opened.status)) return
        if (opened.status < 0) ntFailure(opened.status, `Secure rooted delete open for ${relative}`)
        descriptor = opened.descriptor
        const disposition = Buffer.alloc(4)
        disposition.writeUInt32LE(
            WINDOWS_NATIVE_CONSTANTS.FILE_DISPOSITION_FLAG_DELETE |
                WINDOWS_NATIVE_CONSTANTS.FILE_DISPOSITION_FLAG_POSIX_SEMANTICS |
                WINDOWS_NATIVE_CONSTANTS.FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE
        )
        if (
            !symbols().SetFileInformationByHandle(
                handleForDescriptor(descriptor),
                WINDOWS_NATIVE_CONSTANTS.FILE_DISPOSITION_INFO_EX,
                ptr(disposition),
                disposition.byteLength
            )
        ) {
            throw new Error(
                `Secure rooted delete failed for ${relative} (Win32 ${symbols().GetLastError()})`
            )
        }
        syncDescriptor(parent.fd)
    } finally {
        windowsCloseDescriptor(descriptor)
        if (parent.ownsFd) windowsCloseDescriptor(parent.fd)
    }
}

/** @param {any} sourceRootFd @param {string} sourceRelative @param {any} targetRootFd @param {string} targetRelative */
export function windowsRenameAtRoots(sourceRootFd, sourceRelative, targetRootFd, targetRelative) {
    const source = openParent(sourceRootFd, sourceRelative, false)
    const target = openParent(targetRootFd, targetRelative, true)
    let descriptor = null
    try {
        const opened = ntOpenRelative(source.fd, source.name, { deleteAccess: true })
        if (opened.status < 0)
            ntFailure(opened.status, `Secure rooted rename open for ${sourceRelative}`)
        descriptor = opened.descriptor
        const encodedName = Buffer.from(target.name, 'utf16le')
        const info = Buffer.alloc(
            WINDOWS_NATIVE_LAYOUT.fileRenameStructBytes + encodedName.byteLength
        )
        const view = new DataView(info.buffer, info.byteOffset, info.byteLength)
        // The original FILE_RENAME_INFO contract is supported on every
        // Windows release in our matrix and remains handle-relative. The Ex
        // flags are rejected with ERROR_INVALID_PARAMETER on some NTFS hosts.
        view.setUint8(0, 1) // ReplaceIfExists = TRUE
        setPointer(view, 8, handleForDescriptor(target.fd))
        view.setUint32(16, encodedName.byteLength, true)
        encodedName.copy(info, WINDOWS_NATIVE_LAYOUT.fileRenameHeaderBytes)
        const io = Buffer.alloc(WINDOWS_NATIVE_LAYOUT.ioStatusBlockBytes)
        const status = symbols().NtSetInformationFile(
            handleForDescriptor(descriptor),
            ptr(io),
            ptr(info),
            info.byteLength,
            WINDOWS_NATIVE_CONSTANTS.FILE_RENAME_INFORMATION
        )
        if (status < 0) ntFailure(status, `Secure rooted rename for ${sourceRelative}`)
        syncDescriptor(target.fd)
        if (source.fd !== target.fd) syncDescriptor(source.fd)
    } finally {
        windowsCloseDescriptor(descriptor)
        if (source.ownsFd) windowsCloseDescriptor(source.fd)
        if (target.ownsFd) windowsCloseDescriptor(target.fd)
    }
}

/** @param {any} descriptor @param {any} targetRootFd @param {string} targetRelative */
export function windowsRenameOpenFileAtRoot(descriptor, targetRootFd, targetRelative) {
    const target = openParent(targetRootFd, targetRelative, true)
    try {
        const encodedName = Buffer.from(target.name, 'utf16le')
        const info = Buffer.alloc(
            WINDOWS_NATIVE_LAYOUT.fileRenameStructBytes + encodedName.byteLength
        )
        const view = new DataView(info.buffer, info.byteOffset, info.byteLength)
        view.setUint8(0, 1)
        setPointer(view, 8, handleForDescriptor(target.fd))
        view.setUint32(16, encodedName.byteLength, true)
        encodedName.copy(info, WINDOWS_NATIVE_LAYOUT.fileRenameHeaderBytes)
        const io = Buffer.alloc(WINDOWS_NATIVE_LAYOUT.ioStatusBlockBytes)
        const status = retryWindowsRenameAccessDenied(() =>
            symbols().NtSetInformationFile(
                handleForDescriptor(descriptor),
                ptr(io),
                ptr(info),
                info.byteLength,
                WINDOWS_NATIVE_CONSTANTS.FILE_RENAME_INFORMATION
            )
        )
        if (status < 0) ntFailure(status, `Secure rooted rename for ${targetRelative}`)
        syncDescriptor(target.fd)
        if (descriptor.parent && descriptor.parent !== target.fd) syncDescriptor(descriptor.parent)
    } finally {
        if (target.ownsFd) windowsCloseDescriptor(target.fd)
    }
}

/** @param {any} descriptor */
export function windowsStatDescriptor(descriptor) {
    const info = Buffer.alloc(52)
    if (!symbols().GetFileInformationByHandle(handleForDescriptor(descriptor), ptr(info))) {
        throw new Error(`GetFileInformationByHandle failed (Win32 ${symbols().GetLastError()})`)
    }
    const attributes = info.readUInt32LE(0)
    const size = Number((BigInt(info.readUInt32LE(32)) << 32n) | BigInt(info.readUInt32LE(36)))
    if (!Number.isSafeInteger(size)) throw new Error('Secure Windows file size exceeds safe bounds')
    const directory = Boolean(attributes & WINDOWS_NATIVE_CONSTANTS.FILE_ATTRIBUTE_DIRECTORY)
    const writeTime = info.readBigUInt64LE(20)
    const mtimeMs = Number(writeTime / 10_000n - 11_644_473_600_000n)
    const writable = !(attributes & WINDOWS_NATIVE_CONSTANTS.FILE_ATTRIBUTE_READONLY)
    const mode = directory ? (writable ? 0o777 : 0o555) : writable ? 0o666 : 0o444
    return {
        size,
        mode,
        mtimeMs,
        isDirectory: () => directory,
        isFile: () => !directory
    }
}

/** @param {any} descriptor @param {Uint8Array} buffer @param {number} offset @param {number} length @param {number} position */
export function windowsReadDescriptor(descriptor, buffer, offset, length, position) {
    if (length === 0) return 0
    const api = symbols()
    if (!api.SetFilePointerEx(handleForDescriptor(descriptor), BigInt(position), null, 0)) {
        throw new Error(`SetFilePointerEx(read) failed (Win32 ${api.GetLastError()})`)
    }
    const count = Buffer.alloc(4)
    const target = buffer.subarray(offset, offset + length)
    if (!api.ReadFile(handleForDescriptor(descriptor), ptr(target), length, ptr(count), null)) {
        const code = api.GetLastError()
        // ERROR_HANDLE_EOF is an ordinary zero-byte read.
        if (code === 38) return 0
        throw new Error(`ReadFile failed (Win32 ${code})`)
    }
    return count.readUInt32LE(0)
}

/** @param {any} descriptor @param {Uint8Array} buffer @param {number} offset @param {number} length @param {number} position */
export function windowsWriteDescriptor(descriptor, buffer, offset, length, position) {
    if (length === 0) return 0
    const api = symbols()
    if (!api.SetFilePointerEx(handleForDescriptor(descriptor), BigInt(position), null, 0)) {
        throw new Error(`SetFilePointerEx(write) failed (Win32 ${api.GetLastError()})`)
    }
    const count = Buffer.alloc(4)
    const source = buffer.subarray(offset, offset + length)
    if (!api.WriteFile(handleForDescriptor(descriptor), ptr(source), length, ptr(count), null)) {
        throw new Error(`WriteFile failed (Win32 ${api.GetLastError()})`)
    }
    const written = count.readUInt32LE(0)
    if (written === 0) throw new Error('WriteFile made no progress')
    return written
}

/** @param {any} descriptor */
export function windowsSyncDescriptor(descriptor) {
    if (!symbols().FlushFileBuffers(handleForDescriptor(descriptor))) {
        const code = symbols().GetLastError()
        // Directory handles may reject FlushFileBuffers; files must not.
        if (!windowsStatDescriptor(descriptor).isDirectory() || ![5, 6].includes(code)) {
            throw new Error(`FlushFileBuffers failed (Win32 ${code})`)
        }
    }
}

/** @param {any} descriptor @param {number} length */
export function windowsTruncateDescriptor(descriptor, length) {
    const api = symbols()
    if (!api.SetFilePointerEx(handleForDescriptor(descriptor), BigInt(length), null, 0)) {
        throw new Error(`SetFilePointerEx(truncate) failed (Win32 ${api.GetLastError()})`)
    }
    if (!api.SetEndOfFile(handleForDescriptor(descriptor))) {
        throw new Error(`SetEndOfFile failed (Win32 ${api.GetLastError()})`)
    }
}

/** @param {number | Date} value */
function windowsFileTime(value) {
    const milliseconds = value instanceof Date ? value.getTime() : value
    const ticks = BigInt(Math.trunc(milliseconds)) * 10_000n + 116_444_736_000_000_000n
    const result = Buffer.alloc(8)
    result.writeBigUInt64LE(ticks)
    return result
}

/** @param {any} descriptor @param {number | Date} atime @param {number | Date} mtime */
export function windowsSetDescriptorTimes(descriptor, atime, mtime) {
    const access = windowsFileTime(atime)
    const write = windowsFileTime(mtime)
    if (!symbols().SetFileTime(handleForDescriptor(descriptor), null, ptr(access), ptr(write))) {
        throw new Error(`SetFileTime failed (Win32 ${symbols().GetLastError()})`)
    }
}

/** @param {any} descriptor @param {number} mode */
export function windowsSetDescriptorMode(descriptor, mode) {
    const api = symbols()
    const basic = Buffer.alloc(40)
    if (
        !api.GetFileInformationByHandleEx(
            handleForDescriptor(descriptor),
            0,
            ptr(basic),
            basic.byteLength
        )
    ) {
        throw new Error(`GetFileInformationByHandleEx failed (Win32 ${api.GetLastError()})`)
    }
    let attributes = basic.readUInt32LE(32)
    if (mode & 0o222) attributes &= ~WINDOWS_NATIVE_CONSTANTS.FILE_ATTRIBUTE_READONLY
    else attributes |= WINDOWS_NATIVE_CONSTANTS.FILE_ATTRIBUTE_READONLY
    if (attributes === 0) attributes = WINDOWS_NATIVE_CONSTANTS.FILE_ATTRIBUTE_NORMAL
    basic.writeUInt32LE(attributes, 32)
    if (
        !api.SetFileInformationByHandle(
            handleForDescriptor(descriptor),
            0,
            ptr(basic),
            basic.byteLength
        )
    ) {
        throw new Error(
            `SetFileInformationByHandle(FileBasicInfo) failed (Win32 ${api.GetLastError()})`
        )
    }
}

/** @param {any} descriptor @param {number} maxBytes */
export function windowsReadAllDescriptor(descriptor, maxBytes = Number.MAX_SAFE_INTEGER) {
    const size = windowsStatDescriptor(descriptor).size
    if (size > maxBytes) throw new Error(`Secure Windows read exceeds ${maxBytes} bytes`)
    const result = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
        const count = windowsReadDescriptor(descriptor, result, offset, size - offset, offset)
        if (count === 0) break
        offset += count
    }
    return result.subarray(0, offset)
}

/** @param {any} descriptor @param {string} stream @param {number} flags @param {boolean} create @param {boolean} [deleteAccess] */
function openNamedStream(descriptor, stream, flags, create, deleteAccess = false) {
    if (!descriptor?.__fyloWindowsHandle || !/^fylo\.[a-z.]+$/.test(stream)) {
        throw new Error('Secure Windows ADS access requires a rooted file handle')
    }
    // NTFS accepts a base file HANDLE as RootDirectory for a stream-only name;
    // this binds ADS access to the pinned file identity, not its mutable path.
    const opened = ntOpenRelative(descriptor, `:${stream}`, {
        directory: false,
        flags,
        create,
        deleteAccess
    })
    if (isMissingStatus(opened.status)) return null
    if (opened.status < 0) ntFailure(opened.status, `Secure ADS open for ${stream}`)
    return opened.descriptor
}

/** @param {any} descriptor @param {string} stream @param {number} maxBytes */
export function windowsReadNamedStream(descriptor, stream, maxBytes) {
    const opened = openNamedStream(descriptor, stream, constants.O_RDONLY, false)
    if (!opened) return null
    try {
        return windowsReadAllDescriptor(opened, maxBytes)
    } finally {
        windowsCloseDescriptor(opened)
    }
}

/** @param {any} descriptor @param {string} stream @param {Uint8Array} bytes */
export function windowsWriteNamedStream(descriptor, stream, bytes) {
    const opened = openNamedStream(descriptor, stream, constants.O_RDWR, true)
    if (!opened) throw new Error(`Unable to create secure ADS ${stream}`)
    try {
        windowsTruncateDescriptor(opened, 0)
        let offset = 0
        while (offset < bytes.length) {
            offset += windowsWriteDescriptor(opened, bytes, offset, bytes.length - offset, offset)
        }
        windowsSyncDescriptor(opened)
    } finally {
        windowsCloseDescriptor(opened)
    }
}

/** @param {any} descriptor @param {string} stream */
export function windowsDeleteNamedStream(descriptor, stream) {
    const opened = openNamedStream(descriptor, stream, constants.O_RDONLY, false, true)
    if (!opened) return
    try {
        const disposition = Buffer.alloc(4)
        disposition.writeUInt32LE(
            WINDOWS_NATIVE_CONSTANTS.FILE_DISPOSITION_FLAG_DELETE |
                WINDOWS_NATIVE_CONSTANTS.FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
        )
        if (
            !symbols().SetFileInformationByHandle(
                handleForDescriptor(opened),
                WINDOWS_NATIVE_CONSTANTS.FILE_DISPOSITION_INFO_EX,
                ptr(disposition),
                4
            )
        ) {
            throw new Error(`Secure ADS delete failed (Win32 ${symbols().GetLastError()})`)
        }
    } finally {
        windowsCloseDescriptor(opened)
    }
}

/** @param {any} descriptor @param {() => any} operation */
export function windowsWithDescriptorLock(descriptor, operation) {
    const api = symbols()
    const overlapped = Buffer.alloc(WINDOWS_NATIVE_LAYOUT.overlappedBytes)
    // Reserve a byte-range far beyond supported FYLO file sizes so metadata
    // coordination never conflicts with document I/O.
    overlapped.writeUInt32LE(0x7fffffff, 20)
    if (
        !api.LockFileEx(
            handleForDescriptor(descriptor),
            WINDOWS_NATIVE_CONSTANTS.LOCKFILE_EXCLUSIVE_LOCK,
            0,
            1,
            0,
            ptr(overlapped)
        )
    ) {
        throw new Error(`LockFileEx(metadata) failed (Win32 ${api.GetLastError()})`)
    }
    try {
        return operation()
    } finally {
        api.UnlockFileEx(handleForDescriptor(descriptor), 0, 1, 0, ptr(overlapped))
    }
}
