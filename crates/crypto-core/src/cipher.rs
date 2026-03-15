use wasm_bindgen::prelude::*;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    ChaCha20Poly1305, Key, Nonce,
};

use crate::utils::js_err;

/// Authentication tag overhead (ChaCha20-Poly1305 AEAD): 16 bytes.
pub const TAG_SIZE: usize = 16;
/// Key size: 32 bytes (256-bit).
pub const KEY_SIZE: usize = 32;
/// Nonce size: 12 bytes (96-bit).
pub const NONCE_SIZE: usize = 12;

// ============================================================================
// Pure Rust core — usable in native tests and WASM
// ============================================================================

/// Build a unique 12-byte nonce for a given chunk index from a per-transfer seed.
/// The chunk index is XOR'd into the first 8 bytes to ensure nonce uniqueness.
pub fn nonce_for_chunk(seed: &[u8; 12], chunk_index: u64) -> [u8; NONCE_SIZE] {
    let mut nonce = [0u8; NONCE_SIZE];
    let index_bytes = chunk_index.to_le_bytes();
    for i in 0..8 {
        nonce[i] = seed[i] ^ index_bytes[i];
    }
    nonce[8..12].copy_from_slice(&seed[8..12]);
    nonce
}

/// Encrypt `plaintext` with ChaCha20-Poly1305.
/// Returns `ciphertext || 16-byte tag` on success.
pub fn encrypt_chunk_raw(
    key: &[u8; KEY_SIZE],
    nonce_seed: &[u8; NONCE_SIZE],
    chunk_index: u32,
    plaintext: &[u8],
) -> Result<Vec<u8>, &'static str> {
    let nonce_bytes = nonce_for_chunk(nonce_seed, chunk_index as u64);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
        .map_err(|_| "Encryption failed")
}

/// Decrypt and authenticate `ciphertext` (must include the 16-byte tag).
/// Returns plaintext on success, error on authentication failure.
pub fn decrypt_chunk_raw(
    key: &[u8; KEY_SIZE],
    nonce_seed: &[u8; NONCE_SIZE],
    chunk_index: u32,
    ciphertext: &[u8],
) -> Result<Vec<u8>, &'static str> {
    if ciphertext.len() < TAG_SIZE {
        return Err("Ciphertext too short");
    }
    let nonce_bytes = nonce_for_chunk(nonce_seed, chunk_index as u64);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext)
        .map_err(|_| "Decryption failed — authentication tag mismatch")
}

// ============================================================================
// WASM bindings — parse JS byte slices, call raw functions
// ============================================================================

/// Encrypt a chunk. Takes key (32 B), nonce_seed (12 B), chunk_index, plaintext.
/// Returns ciphertext + 16-byte AEAD tag as Uint8Array.
#[wasm_bindgen(js_name = encryptChunk)]
pub fn encrypt_chunk(
    key: &[u8],
    nonce_seed: &[u8],
    chunk_index: u32,
    plaintext: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let key = parse_key(key)?;
    let seed = parse_seed(nonce_seed)?;
    encrypt_chunk_raw(&key, &seed, chunk_index, plaintext).map_err(js_err)
}

/// Decrypt a chunk. Ciphertext must include the 16-byte AEAD tag.
/// Returns plaintext as Uint8Array or throws on auth failure.
#[wasm_bindgen(js_name = decryptChunk)]
pub fn decrypt_chunk(
    key: &[u8],
    nonce_seed: &[u8],
    chunk_index: u32,
    ciphertext: &[u8],
) -> Result<Vec<u8>, JsValue> {
    let key = parse_key(key)?;
    let seed = parse_seed(nonce_seed)?;
    decrypt_chunk_raw(&key, &seed, chunk_index, ciphertext).map_err(js_err)
}

fn parse_key(key: &[u8]) -> Result<[u8; KEY_SIZE], JsValue> {
    key.try_into()
        .map_err(|_| js_err(format!("Key must be {} bytes, got {}", KEY_SIZE, key.len())))
}

fn parse_seed(seed: &[u8]) -> Result<[u8; NONCE_SIZE], JsValue> {
    seed.try_into()
        .map_err(|_| js_err(format!("Nonce seed must be {} bytes, got {}", NONCE_SIZE, seed.len())))
}

// ============================================================================
// Native unit tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] { [0x42u8; 32] }
    fn seed() -> [u8; 12] { [0x13u8; 12] }

    #[test]
    fn roundtrip() {
        let pt = b"Hello, SecureDrop!";
        let ct = encrypt_chunk_raw(&key(), &seed(), 0, pt).unwrap();
        let decrypted = decrypt_chunk_raw(&key(), &seed(), 0, &ct).unwrap();
        assert_eq!(decrypted, pt);
    }

    #[test]
    fn ciphertext_length() {
        let ct = encrypt_chunk_raw(&key(), &seed(), 0, &[0u8; 100]).unwrap();
        assert_eq!(ct.len(), 100 + TAG_SIZE);
    }

    #[test]
    fn tamper_fails() {
        let mut ct = encrypt_chunk_raw(&key(), &seed(), 0, b"tamper test").unwrap();
        ct[0] ^= 0xFF;
        assert!(decrypt_chunk_raw(&key(), &seed(), 0, &ct).is_err());
    }

    #[test]
    fn different_index_different_ciphertext() {
        let pt = b"same plaintext";
        let ct0 = encrypt_chunk_raw(&key(), &seed(), 0, pt).unwrap();
        let ct1 = encrypt_chunk_raw(&key(), &seed(), 1, pt).unwrap();
        assert_ne!(ct0, ct1);
    }

    #[test]
    fn wrong_index_on_decrypt_fails() {
        let ct = encrypt_chunk_raw(&key(), &seed(), 5, b"test").unwrap();
        assert!(decrypt_chunk_raw(&key(), &seed(), 6, &ct).is_err());
    }

    #[test]
    fn nonce_uniqueness_across_1000_chunks() {
        let seed = [0xABu8; 12];
        let nonces: std::collections::HashSet<[u8; 12]> = (0u32..1000)
            .map(|i| nonce_for_chunk(&seed, i as u64))
            .collect();
        assert_eq!(nonces.len(), 1000, "All nonces must be unique");
    }
}
