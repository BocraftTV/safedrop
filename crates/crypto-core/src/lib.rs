mod utils;
pub mod keys;
pub mod kdf;
pub mod cipher;
pub mod chunks;

use wasm_bindgen::prelude::*;

/// Called once by the JS side to initialize the WASM module.
/// Sets up the panic hook for readable error messages in the browser console.
#[wasm_bindgen(start)]
pub fn init() {
    utils::set_panic_hook();
}

// Re-export public API so wasm-bindgen picks everything up from the crate root.
pub use keys::Keypair;
pub use kdf::{derive_encryption_key, derive_key_material};
pub use cipher::{encrypt_chunk, decrypt_chunk};
pub use chunks::{blake3_hash, hash_chunk, split_into_chunks, chunk_count, compute_merkle_root};

// ---------------------------------------------------------------------------
// Smoke-test export — Phase 1 success criterion
// ---------------------------------------------------------------------------

/// Returns the SecureDrop crypto-core version string.
/// This is the minimal export that proves WASM loads and runs correctly.
#[wasm_bindgen(js_name = version)]
pub fn version() -> String {
    "securedrop-crypto-core/0.1.0".to_owned()
}

/// Simple add function — used in the Phase 1 browser smoke test.
#[wasm_bindgen(js_name = smokeTestAdd)]
pub fn smoke_test_add(a: u32, b: u32) -> u32 {
    a + b
}
