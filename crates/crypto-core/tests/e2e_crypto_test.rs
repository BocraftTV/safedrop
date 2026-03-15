/// End-to-end integration test: simulates a full SecureDrop transfer
/// from the sender's perspective (key exchange → encryption → chunking → Merkle)
/// and the receiver's perspective (key exchange → decryption → verify).
use rand_core::OsRng;
use x25519_dalek::{EphemeralSecret, PublicKey};

use crypto_core::kdf::{derive_key_material_raw, split_key_material};
use crypto_core::cipher::{encrypt_chunk_raw, decrypt_chunk_raw};
use crypto_core::chunks::{split_chunks_raw, hash_chunk_raw, compute_merkle_root_raw, chunk_count_raw};

/// Simulated random salt (in production: sent alongside the public key via signaling)
const SALT: &[u8] = b"securedrop-test-salt-32-bytes!!!";

fn ecdh_exchange() -> ([u8; 32], [u8; 32]) {
    let sender_secret = EphemeralSecret::random_from_rng(OsRng);
    let sender_pk = *PublicKey::from(&sender_secret).as_bytes();

    let receiver_secret = EphemeralSecret::random_from_rng(OsRng);
    let receiver_pk = *PublicKey::from(&receiver_secret).as_bytes();

    let sender_shared = *sender_secret.diffie_hellman(&PublicKey::from(receiver_pk)).as_bytes();
    let receiver_shared = *receiver_secret.diffie_hellman(&PublicKey::from(sender_pk)).as_bytes();

    assert_eq!(sender_shared, receiver_shared, "ECDH shared secrets must match");
    (sender_shared, receiver_shared)
}

#[test]
fn full_transfer_small_file() {
    let file_data = b"Hello, SecureDrop! This is a small test file.".to_vec();

    // ── Key Exchange ──────────────────────────────────────────────
    let (sender_shared, receiver_shared) = ecdh_exchange();
    let sender_km = derive_key_material_raw(&sender_shared, SALT).unwrap();
    let receiver_km = derive_key_material_raw(&receiver_shared, SALT).unwrap();
    assert_eq!(sender_km, receiver_km, "Key material must match");

    let (enc_key, nonce_seed) = split_key_material(&sender_km);

    // ── Sender: Chunk + Encrypt + Merkle ─────────────────────────
    const CHUNK_SIZE: usize = 16; // tiny for testing
    let chunks = split_chunks_raw(&file_data, CHUNK_SIZE);
    let mut ciphertext_chunks: Vec<Vec<u8>> = Vec::new();
    let mut leaf_hashes: Vec<[u8; 32]> = Vec::new();

    for (i, chunk) in chunks.iter().enumerate() {
        let ct = encrypt_chunk_raw(&enc_key, &nonce_seed, i as u32, chunk).unwrap();
        let hash = hash_chunk_raw(chunk, i as u32);
        ciphertext_chunks.push(ct);
        leaf_hashes.push(hash);
    }
    let sender_root = compute_merkle_root_raw(&leaf_hashes);

    // ── Receiver: Decrypt + Verify ────────────────────────────────
    let (recv_key, recv_seed) = split_key_material(&receiver_km);
    let mut received_leaves: Vec<[u8; 32]> = Vec::new();
    let mut reassembled: Vec<u8> = Vec::new();

    for (i, ct) in ciphertext_chunks.iter().enumerate() {
        let pt = decrypt_chunk_raw(&recv_key, &recv_seed, i as u32, ct).unwrap();
        received_leaves.push(hash_chunk_raw(&pt, i as u32));
        reassembled.extend_from_slice(&pt);
    }

    let receiver_root = compute_merkle_root_raw(&received_leaves);

    // ── Assertions ────────────────────────────────────────────────
    assert_eq!(reassembled, file_data, "Reassembled file must match original");
    assert_eq!(sender_root, receiver_root, "Merkle roots must match");
}

#[test]
fn full_transfer_1mb_file() {
    // 1 MiB of pseudo-random-looking data
    let file_data: Vec<u8> = (0u8..=255u8).cycle().take(1024 * 1024).collect();

    let (shared, _) = ecdh_exchange();
    let km = derive_key_material_raw(&shared, SALT).unwrap();
    let (key, seed) = split_key_material(&km);

    let chunk_size = 64 * 1024usize;
    let chunks = split_chunks_raw(&file_data, chunk_size);
    assert_eq!(chunks.len(), chunk_count_raw(file_data.len() as u64, chunk_size as u32) as usize);

    let mut reassembled: Vec<u8> = Vec::with_capacity(file_data.len());
    let mut leaf_hashes: Vec<[u8; 32]> = Vec::new();

    for (i, chunk) in chunks.iter().enumerate() {
        let ct = encrypt_chunk_raw(&key, &seed, i as u32, chunk).unwrap();
        let pt = decrypt_chunk_raw(&key, &seed, i as u32, &ct).unwrap();
        leaf_hashes.push(hash_chunk_raw(&pt, i as u32));
        reassembled.extend_from_slice(&pt);
    }

    assert_eq!(reassembled, file_data);

    let root = compute_merkle_root_raw(&leaf_hashes);
    assert_eq!(root.len(), 32);
    assert_ne!(root, [0u8; 32]);
}

#[test]
fn tampered_chunk_detected() {
    let file_data = b"Sensitive document content!".repeat(100);
    let (shared, _) = ecdh_exchange();
    let km = derive_key_material_raw(&shared, SALT).unwrap();
    let (key, seed) = split_key_material(&km);

    let chunks = split_chunks_raw(&file_data, 64);
    let mut ciphertexts: Vec<Vec<u8>> = chunks
        .iter()
        .enumerate()
        .map(|(i, c)| encrypt_chunk_raw(&key, &seed, i as u32, c).unwrap())
        .collect();

    // Tamper with chunk 2
    ciphertexts[2][0] ^= 0xFF;

    let result = decrypt_chunk_raw(&key, &seed, 2, &ciphertexts[2]);
    assert!(result.is_err(), "Tampered chunk must fail authentication");
}
