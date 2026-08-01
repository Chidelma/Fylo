//! Narrow C ABI for the portable FYLO prefix-index kernel.
//!
//! All parsing, validation, and scanning lives in the safe `fylo-query`
//! crate. Unsafe code is confined to copying bytes across the WebAssembly
//! linear-memory boundary.

#![deny(unsafe_code)]

use std::cell::RefCell;

use fylo_query::{parse_queries, IndexSnapshot, QueryLimits};

const ERROR: i32 = -1;
const ABI_VERSION: u32 = 1;

thread_local! {
    static SNAPSHOT: RefCell<Option<IndexSnapshot>> = const { RefCell::new(None) };
}

/// Return the host/guest ABI version.
#[no_mangle]
#[allow(unsafe_code)]
pub extern "C" fn abi_version() -> u32 {
    ABI_VERSION
}

/// Allocate guest memory for a host-to-guest copy.
#[no_mangle]
#[allow(unsafe_code)]
pub extern "C" fn allocate(length: usize) -> *mut u8 {
    let mut bytes = Vec::<u8>::with_capacity(length);
    let pointer = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    pointer
}

/// Release memory returned by [`allocate`].
///
/// # Safety
///
/// `pointer` must come from `allocate(capacity)` and must not have been freed.
#[no_mangle]
#[allow(unsafe_code)]
pub unsafe extern "C" fn deallocate(pointer: *mut u8, capacity: usize) {
    if pointer.is_null() || capacity == 0 {
        return;
    }
    // SAFETY: The ABI contract requires the original allocation pointer and
    // capacity, and reconstructs a zero-length Vec solely to free its buffer.
    unsafe { drop(Vec::from_raw_parts(pointer, 0, capacity)) };
}

/// Replace this instance's immutable, sorted newline-delimited snapshot.
///
/// # Safety
///
/// `pointer` must identify `length` readable bytes for the duration of the
/// call.
#[no_mangle]
#[allow(unsafe_code)]
pub unsafe extern "C" fn load_snapshot(pointer: *const u8, length: usize) -> i32 {
    if pointer.is_null() && length > 0 {
        return ERROR;
    }
    let source = if length == 0 {
        &[]
    } else {
        // SAFETY: The host promises a readable region of `length` bytes and
        // this slice does not escape the call.
        unsafe { std::slice::from_raw_parts(pointer, length) }
    };
    let snapshot = match IndexSnapshot::from_bytes(source, QueryLimits::default()) {
        Ok(snapshot) => snapshot,
        Err(_) => return ERROR,
    };
    SNAPSHOT.with(|current| current.replace(Some(snapshot)));
    0
}

/// Scan one or more prefix/range constraints, intersecting document IDs.
///
/// The return value is the required output length. If the supplied buffer is
/// too small no bytes are written, allowing the host to resize and retry.
///
/// # Safety
///
/// Input/output pointers must identify readable/writable regions of the stated
/// sizes and must not be concurrently mutated during this call.
#[no_mangle]
#[allow(unsafe_code)]
pub unsafe extern "C" fn scan_queries(
    query_pointer: *const u8,
    query_length: usize,
    output_pointer: *mut u8,
    output_capacity: usize,
) -> i32 {
    if query_pointer.is_null() {
        return ERROR;
    }
    // SAFETY: The host promises a readable region of `query_length` bytes and
    // the slice does not escape the call.
    let input = unsafe { std::slice::from_raw_parts(query_pointer, query_length) };
    let limits = QueryLimits::default();
    let queries = match parse_queries(input, limits) {
        Ok(queries) => queries,
        Err(_) => return ERROR,
    };
    let encoded = SNAPSHOT.with(|snapshot| {
        snapshot
            .borrow()
            .as_ref()
            .ok_or(())
            .and_then(|snapshot| snapshot.scan_encoded(&queries, limits).map_err(|_| ()))
    });
    let Ok(encoded) = encoded else {
        return ERROR;
    };
    let required = encoded.len();
    let Ok(required_i32) = i32::try_from(required) else {
        return ERROR;
    };
    if required > output_capacity || (required > 0 && output_pointer.is_null()) {
        return required_i32;
    }
    if required > 0 {
        // SAFETY: The host promises a writable region of `output_capacity`
        // bytes, and the preceding check proves `required <= output_capacity`.
        unsafe { std::ptr::copy_nonoverlapping(encoded.as_ptr(), output_pointer, required) };
    }
    required_i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_a_versioned_abi() {
        assert_eq!(abi_version(), 1);
    }
}
