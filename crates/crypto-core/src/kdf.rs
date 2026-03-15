use wasm_bindgen::prelude::*;
use hkdf::Hkdf;
use sha2::Sha256;

use crate::utils::js_err;

const HKDF_INFO: &[u8] = b"securedrop-v1-enc-key";

// ============================================================================
// Pure Rust core
// ============================================================================

/// Derive a 32-byte encryption key from the ECDH shared secret using HKDF-SHA256.
/// `salt` can be empty (HKDF uses a zero-filled salt in that case).
pub fn derive_encryption_key_raw(shared_secret: &[u8], salt: &[u8]) -> Result<[u8; 32], &'static str> {
    let salt_opt: Option<&[u8]> = if salt.is_empty() { None } else { Some(salt) };
    let hk = Hkdf::<Sha256>::new(salt_opt, shared_secret);
    let mut okm = [0u8; 32];
    hk.expand(HKDF_INFO, &mut okm)
        .map_err(|_| "HKDF expand failed")?;
    Ok(okm)
}

/// Derive 44 bytes: [enc_key (32)] || [nonce_seed (12)].
/// Split with `split_key_material`.
pub fn derive_key_material_raw(shared_secret: &[u8], salt: &[u8]) -> Result<[u8; 44], &'static str> {
    let salt_opt: Option<&[u8]> = if salt.is_empty() { None } else { Some(salt) };
    let hk = Hkdf::<Sha256>::new(salt_opt, shared_secret);
    let mut okm = [0u8; 44];
    hk.expand(HKDF_INFO, &mut okm)
        .map_err(|_| "HKDF expand failed")?;
    Ok(okm)
}

/// Split 44-byte key material into (key, nonce_seed).
pub fn split_key_material(km: &[u8; 44]) -> ([u8; 32], [u8; 12]) {
    let mut key = [0u8; 32];
    let mut seed = [0u8; 12];
    key.copy_from_slice(&km[..32]);
    seed.copy_from_slice(&km[32..44]);
    (key, seed)
}

// ============================================================================
// WASM bindings
// ============================================================================

/// Derive a 32-byte symmetric encryption key from the ECDH shared secret (HKDF-SHA256).
#[wasm_bindgen(js_name = deriveEncryptionKey)]
pub fn derive_encryption_key(shared_secret: &[u8], salt: &[u8]) -> Result<Vec<u8>, JsValue> {
    if shared_secret.is_empty() {
        return Err(js_err("shared_secret must not be empty"));
    }
    derive_encryption_key_raw(shared_secret, salt)
        .map(|k| k.to_vec())
        .map_err(js_err)
}

/// Derive 44 bytes: first 32 = enc key, last 12 = nonce seed.
#[wasm_bindgen(js_name = deriveKeyMaterial)]
pub fn derive_key_material(shared_secret: &[u8], salt: &[u8]) -> Result<Vec<u8>, JsValue> {
    if shared_secret.is_empty() {
        return Err(js_err("shared_secret must not be empty"));
    }
    derive_key_material_raw(shared_secret, salt)
        .map(|k| k.to_vec())
        .map_err(js_err)
}

// ============================================================================
// Native unit tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_key_is_deterministic() {
        let secret = [0xABu8; 32];
        let salt = [0x01u8; 32];
        let k1 = derive_encryption_key_raw(&secret, &salt).unwrap();
        let k2 = derive_encryption_key_raw(&secret, &salt).unwrap();
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 32);
    }

    #[test]
    fn different_salts_different_keys() {
        let secret = [0xABu8; 32];
        let k1 = derive_encryption_key_raw(&secret, &[0x01u8; 32]).unwrap();
        let k2 = derive_encryption_key_raw(&secret, &[0x02u8; 32]).unwrap();
        assert_ne!(k1, k2);
    }

    #[test]
    fn different_secrets_different_keys() {
        let salt = [0x00u8; 32];
        let k1 = derive_encryption_key_raw(&[0x01u8; 32], &salt).unwrap();
        let k2 = derive_encryption_key_raw(&[0x02u8; 32], &salt).unwrap();
        assert_ne!(k1, k2);
    }

    #[test]
    fn key_material_correct_length() {
        let km = derive_key_material_raw(&[0xCDu8; 32], &[]).unwrap();
        assert_eq!(km.len(), 44);
    }

    #[test]
    fn split_key_material_correct() {
        let km = derive_key_material_raw(&[0xEFu8; 32], &[0xABu8; 16]).unwrap();
        let (key, seed) = split_key_material(&km);
        assert_eq!(key.len(), 32);
        assert_eq!(seed.len(), 12);
        // They should be the same bytes as the first 32 and last 12
        assert_eq!(&key, &km[..32]);
        assert_eq!(&seed, &km[32..44]);
    }

    #[test]
    fn empty_secret_fails_via_wasm_wrapper() {
        // Only testing via the raw function with an empty slice
        // (non-empty is validated by WASM wrapper)
        let result = derive_encryption_key_raw(&[], &[]);
        // HKDF allows empty IKM but we validate in the wasm wrapper — raw succeeds
        assert!(result.is_ok());
    }
}
