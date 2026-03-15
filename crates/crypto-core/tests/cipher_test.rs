use crypto_core::cipher::{encrypt_chunk_raw, decrypt_chunk_raw};

fn key() -> [u8; 32] { [0x55u8; 32] }
fn seed() -> [u8; 12] { [0xAAu8; 12] }

#[test]
fn full_roundtrip() {
    let plaintext = b"The quick brown fox jumps over the lazy dog";
    let ct = encrypt_chunk_raw(&key(), &seed(), 0, plaintext).unwrap();
    let pt = decrypt_chunk_raw(&key(), &seed(), 0, &ct).unwrap();
    assert_eq!(&pt, plaintext);
}

#[test]
fn empty_plaintext_roundtrip() {
    let ct = encrypt_chunk_raw(&key(), &seed(), 0, &[]).unwrap();
    let pt = decrypt_chunk_raw(&key(), &seed(), 0, &ct).unwrap();
    assert!(pt.is_empty());
}

#[test]
fn ciphertext_is_longer_by_16_byte_tag() {
    let plaintext = vec![0u8; 100];
    let ct = encrypt_chunk_raw(&key(), &seed(), 0, &plaintext).unwrap();
    assert_eq!(ct.len(), plaintext.len() + 16);
}

#[test]
fn bit_flip_in_ciphertext_fails_auth() {
    let plaintext = b"integrity check";
    let mut ct = encrypt_chunk_raw(&key(), &seed(), 0, plaintext).unwrap();
    ct[3] ^= 0x01;
    assert!(decrypt_chunk_raw(&key(), &seed(), 0, &ct).is_err());
}

#[test]
fn wrong_chunk_index_fails_auth() {
    let plaintext = b"index bound test";
    let ct = encrypt_chunk_raw(&key(), &seed(), 10, plaintext).unwrap();
    assert!(decrypt_chunk_raw(&key(), &seed(), 11, &ct).is_err());
}

#[test]
fn same_plaintext_different_index_different_ciphertext() {
    let plaintext = b"same content";
    let ct0 = encrypt_chunk_raw(&key(), &seed(), 0, plaintext).unwrap();
    let ct1 = encrypt_chunk_raw(&key(), &seed(), 1, plaintext).unwrap();
    assert_ne!(ct0, ct1, "Different chunk index must produce different ciphertext");
}
