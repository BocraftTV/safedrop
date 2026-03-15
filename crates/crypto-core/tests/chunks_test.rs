use crypto_core::chunks::{blake3_hash_raw, hash_chunk_raw, chunk_count_raw, compute_merkle_root_raw, split_chunks_raw};

#[test]
fn blake3_hash_is_32_bytes() {
    assert_eq!(blake3_hash_raw(b"hello world").len(), 32);
}

#[test]
fn blake3_hash_is_deterministic() {
    assert_eq!(blake3_hash_raw(b"test"), blake3_hash_raw(b"test"));
}

#[test]
fn different_data_different_hash() {
    assert_ne!(blake3_hash_raw(b"a"), blake3_hash_raw(b"b"));
}

#[test]
fn hash_chunk_index_affects_output() {
    let h0 = hash_chunk_raw(b"same", 0);
    let h1 = hash_chunk_raw(b"same", 1);
    assert_ne!(h0, h1);
}

#[test]
fn chunk_count_edge_cases() {
    let cs = 64 * 1024u32;
    assert_eq!(chunk_count_raw(0, cs), 0);
    assert_eq!(chunk_count_raw(1, cs), 1);
    assert_eq!(chunk_count_raw(cs as u64, cs), 1);
    assert_eq!(chunk_count_raw(cs as u64 + 1, cs), 2);
    assert_eq!(chunk_count_raw(cs as u64 * 3, cs), 3);
}

#[test]
fn merkle_root_is_leaf_for_single_chunk() {
    let leaf = blake3_hash_raw(b"solo chunk");
    let root = compute_merkle_root_raw(&[leaf]);
    assert_eq!(root, leaf);
}

#[test]
fn merkle_root_changes_with_content() {
    let leaves_a: Vec<[u8; 32]> = (0u32..4).map(|i| hash_chunk_raw(b"data_a", i)).collect();
    let leaves_b: Vec<[u8; 32]> = (0u32..4).map(|i| hash_chunk_raw(b"data_b", i)).collect();
    assert_ne!(compute_merkle_root_raw(&leaves_a), compute_merkle_root_raw(&leaves_b));
}

#[test]
fn split_and_hash_roundtrip() {
    let data = b"SecureDrop test payload".repeat(3000);
    let chunks = split_chunks_raw(&data, 64 * 1024);
    let leaves: Vec<[u8; 32]> = chunks
        .iter()
        .enumerate()
        .map(|(i, c)| hash_chunk_raw(c, i as u32))
        .collect();
    let root = compute_merkle_root_raw(&leaves);
    // Deterministic
    assert_eq!(root, compute_merkle_root_raw(&leaves));
}
