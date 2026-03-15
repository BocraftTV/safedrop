/// WASM browser tests — run with:
///   wasm-pack test --chrome --headless
///
/// These test the full WASM API surface including js_sys types.
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

use crypto_core::{
    Keypair,
    blake3_hash, hash_chunk, chunk_count, compute_merkle_root,
    encrypt_chunk, decrypt_chunk,
    derive_encryption_key, derive_key_material,
    smoke_test_add, version,
};

// ── Smoke Test ──────────────────────────────────────────────────────────────

#[wasm_bindgen_test]
fn smoke_test_add_works() {
    assert_eq!(smoke_test_add(21, 21), 42);
}

#[wasm_bindgen_test]
fn version_string_correct() {
    assert_eq!(version(), "securedrop-crypto-core/0.1.0");
}

// ── Key Exchange ─────────────────────────────────────────────────────────────

#[wasm_bindgen_test]
fn keypair_ecdh_shared_secrets_match() {
    let mut alice = Keypair::generate();
    let mut bob = Keypair::generate();

    let alice_pk = alice.public_key();
    let bob_pk = bob.public_key();

    assert_eq!(alice_pk.len(), 32);
    assert_eq!(bob_pk.len(), 32);
    assert_ne!(alice_pk, bob_pk);

    let alice_shared = alice.diffie_hellman(&bob_pk).unwrap();
    let bob_shared = bob.diffie_hellman(&alice_pk).unwrap();

    assert_eq!(alice_shared, bob_shared);
    assert_eq!(alice_shared.len(), 32);
    assert_ne!(alice_shared, vec![0u8; 32]);
}

#[wasm_bindgen_test]
fn keypair_consumed_after_ecdh() {
    let mut alice = Keypair::generate();
    let bob = Keypair::generate();
    let bob_pk = bob.public_key();

    alice.diffie_hellman(&bob_pk).unwrap();
    assert!(alice.diffie_hellman(&bob_pk).is_err(), "Keypair must be consumed after one ECDH");
}

// ── KDF ──────────────────────────────────────────────────────────────────────

#[wasm_bindgen_test]
fn derive_key_is_32_bytes() {
    let secret = vec![0xABu8; 32];
    let salt = vec![0x01u8; 32];
    let key = derive_encryption_key(&secret, &salt).unwrap();
    assert_eq!(key.len(), 32);
}

#[wasm_bindgen_test]
fn derive_key_material_is_44_bytes() {
    let secret = vec![0xCDu8; 32];
    let km = derive_key_material(&secret, &[]).unwrap();
    assert_eq!(km.len(), 44);
}

#[wasm_bindgen_test]
fn derive_key_deterministic() {
    let secret = vec![0x55u8; 32];
    let salt = vec![0x12u8; 16];
    let k1 = derive_encryption_key(&secret, &salt).unwrap();
    let k2 = derive_encryption_key(&secret, &salt).unwrap();
    assert_eq!(k1, k2);
}

// ── Encryption / Decryption ───────────────────────────────────────────────────

#[wasm_bindgen_test]
fn encrypt_decrypt_roundtrip() {
    let key = vec![0x42u8; 32];
    let seed = vec![0x13u8; 12];
    let plaintext = b"Hello, SecureDrop WASM!".to_vec();

    let ct = encrypt_chunk(&key, &seed, 0, &plaintext).unwrap();
    assert_eq!(ct.len(), plaintext.len() + 16);

    let pt = decrypt_chunk(&key, &seed, 0, &ct).unwrap();
    assert_eq!(pt, plaintext);
}

#[wasm_bindgen_test]
fn tampered_ciphertext_fails() {
    let key = vec![0x42u8; 32];
    let seed = vec![0x13u8; 12];
    let mut ct = encrypt_chunk(&key, &seed, 0, b"integrity test").unwrap();
    ct[0] ^= 0xFF;
    assert!(decrypt_chunk(&key, &seed, 0, &ct).is_err());
}

// ── Hashing & Merkle ─────────────────────────────────────────────────────────

#[wasm_bindgen_test]
fn blake3_hash_length() {
    let h = blake3_hash(&[1, 2, 3, 4]);
    assert_eq!(h.len(), 32);
}

#[wasm_bindgen_test]
fn hash_chunk_index_differs() {
    let h0 = hash_chunk(b"data", 0);
    let h1 = hash_chunk(b"data", 1);
    assert_ne!(h0, h1);
}

#[wasm_bindgen_test]
fn chunk_count_correct() {
    assert_eq!(chunk_count(0, 64 * 1024), 0);
    assert_eq!(chunk_count(1, 64 * 1024), 1);
    assert_eq!(chunk_count(64 * 1024, 64 * 1024), 1);
    assert_eq!(chunk_count(64 * 1024 + 1, 64 * 1024), 2);
}

#[wasm_bindgen_test]
fn merkle_root_from_js_array() {
    let h0 = js_sys::Uint8Array::from(hash_chunk(b"chunk0", 0).as_slice());
    let h1 = js_sys::Uint8Array::from(hash_chunk(b"chunk1", 1).as_slice());

    let arr = js_sys::Array::new();
    arr.push(&h0);
    arr.push(&h1);

    let root = compute_merkle_root(arr).unwrap();
    assert_eq!(root.len(), 32);
}

// ── Full WASM E2E ─────────────────────────────────────────────────────────────

#[wasm_bindgen_test]
fn full_e2e_wasm() {
    // Key exchange
    let mut alice = Keypair::generate();
    let mut bob = Keypair::generate();
    let alice_pk = alice.public_key();
    let bob_pk = bob.public_key();
    let alice_shared = alice.diffie_hellman(&bob_pk).unwrap();
    let bob_shared = bob.diffie_hellman(&alice_pk).unwrap();
    assert_eq!(alice_shared, bob_shared);

    // KDF
    let salt = vec![0u8; 32];
    let km = derive_key_material(&alice_shared, &salt).unwrap();
    let key = km[..32].to_vec();
    let nonce_seed = km[32..44].to_vec();

    // Encrypt chunks
    let file = b"SecureDrop E2E test file content!".repeat(10);
    let chunk_size = 64usize;
    let leaf_arr = js_sys::Array::new();
    let mut ciphertexts: Vec<Vec<u8>> = Vec::new();

    for (i, chunk) in file.chunks(chunk_size).enumerate() {
        let ct = encrypt_chunk(&key, &nonce_seed, i as u32, chunk).unwrap();
        ciphertexts.push(ct);
    }

    // Decrypt + verify
    let mut reassembled: Vec<u8> = Vec::new();
    let recv_km = derive_key_material(&bob_shared, &salt).unwrap();
    let recv_key = recv_km[..32].to_vec();
    let recv_seed = recv_km[32..44].to_vec();

    for (i, ct) in ciphertexts.iter().enumerate() {
        let pt = decrypt_chunk(&recv_key, &recv_seed, i as u32, ct).unwrap();
        let h = js_sys::Uint8Array::from(hash_chunk(&pt, i as u32).as_slice());
        leaf_arr.push(&h);
        reassembled.extend_from_slice(&pt);
    }

    assert_eq!(reassembled, file.to_vec());

    let root = compute_merkle_root(leaf_arr).unwrap();
    assert_eq!(root.len(), 32);
}
